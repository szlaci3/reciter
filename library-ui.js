/* Keep document storage and editing separate from the speech player. */
(function (root) {
  root.mountLibrary = async function ({ initialText, onTextChanged, onSwitch }) {
    const $ = id => document.getElementById(id);
    const title = $('document-title'), material = $('material'), status = $('save-status');
    let ready = false, displayedId = null, renderedCards = '', failedNavigation = null;
    let startupStep = 'loading library scripts';
    function render(editor) {
      if (!ready) startupStep = 'displaying the library';
      const active = editor.active;
      if (active?.id !== displayedId) {
        displayedId = active.id;
        title.value = active.title; material.value = active.text;
        onTextChanged();
      }
      title.disabled = material.disabled = !ready || editor.busy;
      $('new-document').disabled = !ready || editor.busy;
      $('retry-save').hidden = editor.state !== 'error';
      $('retry-save').disabled = editor.busy;
      status.textContent = editor.state === 'error'
        ? (editor.error?.name === 'ConflictError' ? 'Not saved. ' + editor.error.message
          : 'Could not save or open the document. Your edits are still here. Retry before leaving this page.')
        : editor.state === 'saving' ? 'Saving…' : 'Saved on this device';
      status.dataset.state = editor.state;
      $('document-count').textContent = `${editor.documents.length} ${editor.documents.length === 1 ? 'document' : 'documents'}`;
      $('material-section').style.setProperty('--document-color', active.color);
      $('editing-document').textContent = active.title.trim() || 'Untitled document';
      // Keep existing buttons/focus while typing; update once a save completes.
      const signature = JSON.stringify([editor.documents, active.id, editor.busy]);
      if (signature === renderedCards) return;
      renderedCards = signature;
      const focused = document.activeElement?.dataset.documentId;
      const cards = editor.documents.map(doc => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'document-card';
        button.dataset.documentId = doc.id;
        button.style.setProperty('--document-color', doc.color);
        button.setAttribute('aria-pressed', String(doc.id === active.id));
        button.disabled = editor.busy;
        const name = document.createElement('strong'); name.textContent = doc.title.trim() || 'Untitled document';
        const preview = document.createElement('span'); preview.className = 'document-preview';
        preview.textContent = doc.text.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Add your text to start listening.';
        const selected = document.createElement('span'); selected.className = 'document-selection';
        selected.textContent = doc.id === active.id ? 'Selected' : 'Open document';
        button.append(name, preview, selected);
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
            return `${name}: HTTP ${response.status}, ${type}${failure ? '; ' + failure : '; script did not initialize'}; recheck ${identity} (${fingerprint})${excerpt}`;
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
    async function switchDocument(id) {
      if (editor.busy || id === editor.active.id) return;
      onSwitch();
      const switched = await editor.navigate(id);
      failedNavigation = switched ? null : { id };
      if (switched && !id) { title.focus(); title.select(); }
    }
    title.addEventListener('input', () => editor.edit({ title: title.value }));
    material.addEventListener('input', () => editor.edit({ text: material.value }));
    $('new-document').addEventListener('click', () => switchDocument());
    $('retry-save').addEventListener('click', () => {
      if (editor.dirty || !failedNavigation) editor.flush();
      else switchDocument(failedNavigation.id);
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
