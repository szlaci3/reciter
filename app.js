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
  const voiceId = v => `${v.voiceURI}|${v.name}|${v.lang}`;
  function settings() {
    return { voice: voices.find(v => voiceId(v) === $('voice').value) || null,
      pitch: Number($('pitch').value), rate: Number($('rate').value), gap: Number($('gap').value) };
  }
  function save() {
    const { pitch, rate, gap } = settings();
    try { localStorage.setItem(storageKey, JSON.stringify({ text: $('material').value, voice: preferred, pitch, rate, gap })); } catch { /* Private browsing may deny storage. */ }
  }
  function outputs() {
    $('pitch-value').value = Number($('pitch').value).toFixed(1);
    $('rate-value').value = `${Number($('rate').value).toFixed(1)}×`;
    $('gap-value').value = `${$('gap').value} s`;
  }
  outputs();
  if (!synth || !window.SpeechSynthesisUtterance) {
    $('status').textContent = 'Speech is unavailable in this browser. Try this page in another browser on your phone.';
    for (const id of ['play', 'pause', 'stop', 'previous', 'next', 'voice', 'passage']) $(id).disabled = true;
    return;
  }
  const player = new ReciterSpeech.Player(synth, text => new SpeechSynthesisUtterance(text), settings, render);
  function render(error) {
    const active = ['speaking', 'waiting'].includes(player.state);
    const position = player.items.length ? `Passage ${player.index + 1} of ${player.items.length}` : 'Add some text to begin';
    const labels = { idle: 'Ready', speaking: 'Speaking', waiting: 'Taking a breath', paused: 'Paused — resume repeats the interrupted segment', ended: 'Finished', error: `Speech failed (${error || 'unknown'}). Try Play again or choose another voice` };
    $('status').textContent = `${labels[player.state]} · ${position}`;
    $('play').textContent = player.state === 'paused' ? 'Resume' : player.state === 'ended' ? 'Replay' : 'Play';
    $('play').disabled = active || !player.items.length;
    $('pause').disabled = !active;
    $('stop').disabled = player.state === 'idle';
    $('previous').disabled = !player.items.length || player.index === 0;
    $('next').disabled = !player.items.length || player.index >= player.items.length - 1;
    $('passage').disabled = !player.items.length;
    $('passage').value = String(player.index);
    $('preview').textContent = player.items[player.index] || '';
  }
  function loadVoices() {
    voices = synth.getVoices();
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
    player.setText($('material').value);
    $('passage').replaceChildren(...player.items.map((text, i) => new Option(`${i + 1}. ${text.slice(0, 65)}${text.length > 65 ? '…' : ''}`, String(i))));
    render();
  }
  $('material').addEventListener('input', () => { textChanged(); save(); });
  $('voice').addEventListener('change', () => { preferred = $('voice').value; save(); $('voice-note').textContent = 'Your selected voice will be used for the next spoken segment.'; });
  for (const key of ['pitch', 'rate', 'gap']) $(key).addEventListener('input', () => { outputs(); save(); });
  $('play').addEventListener('click', () => { loadVoices(); player.play(); });
  $('pause').addEventListener('click', () => player.pause());
  $('stop').addEventListener('click', () => player.stop());
  $('previous').addEventListener('click', () => player.select(player.index - 1));
  $('next').addEventListener('click', () => player.select(player.index + 1));
  $('passage').addEventListener('change', () => player.select(Number($('passage').value)));
  synth.addEventListener('voiceschanged', loadVoices);
  window.addEventListener('pagehide', () => player.stop());
  loadVoices(); textChanged();
})();
