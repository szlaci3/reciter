(() => {
  const $ = id => document.getElementById(id);
  const synth = window.speechSynthesis;
  const storageKey = 'reciter-listening-v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { /* Storage is optional. */ }
  if (typeof saved.text === 'string') $('material').value = saved.text;
  for (const key of ['pitch', 'rate', 'gap']) {
    if (Number.isFinite(saved[key])) $(key).value = saved[key];
  }
  let voices = [], preferred = typeof saved.voice === 'string' ? saved.voice : null;
  $('source').value = saved.source === 'browser' ? 'browser' : 'auto';
  $('pc-url').value = saved.pcUrl || (/^(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(location.hostname) ? location.origin : '');
  try { $('pc-key').value = sessionStorage.getItem('reciter-pc-key') || ''; } catch {}
  if (!EdgeSpeech.validAccessKey($('pc-key').value)) $('pc-key').value = '';
  let edgeVoice = saved.edgeVoice || 'en-GB-SoniaNeural';
  let libraryLoading = true, learningUI = null;
  function edgeConfig() { return { warmup: true, source: $('source').value, url: $('pc-url').value.trim().replace(/\/$/, ''), key: $('pc-key').value.trim(), edgeVoice }; }
  const engine = new EdgeSpeech(synth, edgeConfig, message => { $('connection').textContent = message; }, $('edge-audio'));
  const voiceId = v => `${v.voiceURI}|${v.name}|${v.lang}`;
  function settings() {
    return { voice: voices.find(v => voiceId(v) === $('voice').value) || null,
      pitch: Number($('pitch').value), rate: Number($('rate').value), gap: Number($('gap').value) };
  }
  function save() {
    const { pitch, rate, gap } = settings();
    try { localStorage.setItem(storageKey, JSON.stringify({ ...(typeof saved.text === 'string' ? { text: saved.text } : {}), voice: preferred, pitch, rate, gap,
      source: $('source').value, pcUrl: $('pc-url').value.trim(), edgeVoice })); } catch { /* Private browsing may deny storage. */ }
    try { sessionStorage.setItem('reciter-pc-key', $('pc-key').value.trim()); } catch {}
  }
  function outputs() {
    $('pitch-value').value = Number($('pitch').value).toFixed(1);
    $('rate-value').value = `${Number($('rate').value).toFixed(1)}×`;
    $('gap-value').value = `${$('gap').value} s`;
  }
  outputs();
  const player = new ReciterSpeech.Player(engine, text => window.SpeechSynthesisUtterance ? new SpeechSynthesisUtterance(text) : { text }, settings, render);
  function render(error) {
    if (!document) return;
    const active = ['speaking', 'waiting'].includes(player.state);
    const position = player.items.length ? `Passage ${player.index + 1} of ${player.items.length}` : 'Add some text to begin';
    const labels = { idle: 'Ready', speaking: 'Speaking', waiting: 'Taking a breath', paused: 'Paused', ended: 'Finished', error: `Speech failed (${error || 'unknown'}). Try Play again or choose another voice` };
    if (navigator.mediaSession) navigator.mediaSession.playbackState = active ? 'playing' : player.state === 'paused' ? 'paused' : 'none';
    $('status').textContent = `${labels[player.state]} · ${position}`;
    $('play').textContent = player.state === 'paused' ? 'Resume' : player.state === 'ended' ? 'Replay' : 'Play';
    $('play').disabled = libraryLoading || active || !player.items.length;
    $('pause').disabled = !active;
    $('stop').disabled = player.state === 'idle';
    $('previous').disabled = !player.items.length || player.index === 0;
    $('next').disabled = !player.items.length || player.index >= player.items.length - 1;
    $('passage').disabled = !player.items.length;
    $('passage').value = String(player.index);
    $('preview').textContent = player.items[player.index] || '';
    learningUI?.sync();
  }
  function loadVoices() {
    voices = synth?.getVoices() || [];
    const selected = preferred === '' ? null : voices.find(v => voiceId(v) === preferred)
      || voices.find(v => /\bdaniel\b/i.test(v.name) && /^en[-_]GB$/i.test(v.lang))
      || voices.find(v => /\bdaniel\b/i.test(v.name));
    $('voice').replaceChildren(new Option('Browser default', ''));
    for (const voice of voices) $('voice').add(new Option(`${voice.name} — ${voice.lang}`, voiceId(voice)));
    $('voice').value = selected ? voiceId(selected) : '';
    $('voice-note').textContent = selected
      ? `Selected: ${selected.name}. Preferred starting setup: Daniel, British English, pitch 1.4.`
      : 'Daniel is not currently exposed by this browser. You can audition another voice; the browser default may sound different from your preferred voice.';
  }
  function textChanged() {
    learningUI?.textChanged();
    player.setText($('material').value);
    $('passage').replaceChildren(...player.items.map((text, i) => new Option(`${i + 1}. ${text.slice(0, 65)}${text.length > 65 ? '…' : ''}`, String(i))));
    render();
  }
  $('material').addEventListener('input', textChanged);
  engine.onVoices = list => {
    list.sort((a, b) => Number(!a.locale.startsWith('en-GB')) - Number(!b.locale.startsWith('en-GB')) || a.name.localeCompare(b.name));
    $('edge-voice').replaceChildren(...list.map(v => new Option(`${v.name} · ${v.gender}`, v.name)));
    if (!list.some(v => v.name === edgeVoice)) edgeVoice = list[0].name;
    $('edge-voice').value = edgeVoice;
    save();
  };
  function connect() {
    save();
    if ($('source').value === 'browser') {
      $('connection').textContent = 'Phone voice selected. Choose Automatic to connect to Edge.';
      return;
    }
    engine.connect();
  }
  $('connect').addEventListener('click', connect);
  for (const id of ['pc-url', 'pc-key']) $(id).addEventListener('input', () => {
    learningUI?.cancel(); player.stop(); engine.readyKey = null; engine.failed = true; save();
  });
  $('source').addEventListener('change', () => { learningUI?.cancel(); player.stop(); engine.failed = false; save(); $('connection').textContent = 'Source changed. Press Play to listen.'; });
  $('edge-voice').addEventListener('change', () => { edgeVoice = $('edge-voice').value; save(); });
  $('voice').addEventListener('change', () => { preferred = $('voice').value; save(); $('voice-note').textContent = 'Your selected voice will be used for the next spoken segment.'; });
  for (const key of ['pitch', 'rate', 'gap']) $(key).addEventListener('input', () => { outputs(); save(); });
  function play() {
    if (!document || libraryLoading) return;
    if (['speaking', 'waiting'].includes(player.state)) return;
    if (player.state !== 'paused') {
      loadVoices();
      if ($('source').value === 'auto') engine.unlock();
    }
    player.play();
  }
  $('play').addEventListener('click', play);
  if (navigator.mediaSession) {
    for (const [action, handler] of [['play', play], ['pause', () => player.pause()]]) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ }
    }
  }
  $('pause').addEventListener('click', () => player.pause());
  $('stop').addEventListener('click', () => { learningUI?.cancel(); player.stop(); });
  $('previous').addEventListener('click', () => player.select(player.index - 1));
  $('next').addEventListener('click', () => player.select(player.index + 1));
  $('passage').addEventListener('change', () => player.select(Number($('passage').value)));
  synth?.addEventListener('voiceschanged', loadVoices);
  function reconcilePlayback() {
    if (document.visibilityState === 'visible') engine.reconcilePlayback();
    else engine.clearReturnCheck();
  }
  document.addEventListener('visibilitychange', reconcilePlayback);
  window.addEventListener('focus', reconcilePlayback);
  window.addEventListener('pageshow', reconcilePlayback);
  window.addEventListener('pagehide', () => { learningUI?.cancel(); player.stop(); });
  loadVoices(); textChanged();
  mountLibrary({ initialText: $('material').value, onTextChanged: textChanged, onSwitch: () => { learningUI?.cancel(); player.stop(); },
    onUnlock: () => { learningUI?.cancel(); player.stop(); if ($('source').value === 'auto') engine.unlock(); },
    onDocumentPlay: async id => {
      try { if (!learningUI || !await learningUI.playTopic(id)) play(); }
      catch (error) { if (document) $('package-status').textContent = error.message; }
    } })
    .then(async editor => {
      libraryLoading = false; render();
      if (editor && window.ReciterPackages) learningUI = await ReciterPackages.mount({ editor, player, play,
        unlock: () => { if ($('source').value === 'auto') engine.unlock(); } });
    })
    .catch(error => { if (document) $('package-status').textContent = 'Packages could not start: ' + error.message; })
    .finally(() => { libraryLoading = false; render(); });
  if ($('source').value === 'auto' && $('pc-url').value && $('pc-key').value) connect();
})();
