const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EdgeSpeech } = require('./edge-speech.js');

function fixture(fetcher) {
  const spoken = [], reports = [];
  const audio = {
    paused: true, ended: false, currentTime: 0,
    async play() { this.paused = false; this.onplay?.(); },
    pause() { this.paused = true; this.onpause?.(); },
    removeAttribute() {}
  };
  const config = { source: 'auto', url: 'http://pc:8000', key: 'test', edgeVoice: 'en-GB-SoniaNeural' };
  const engine = new EdgeSpeech({ speak(u) { spoken.push(u); }, cancel() {} }, () => config, m => reports.push(m), audio, fetcher);
  const utterance = { text: 'Listen carefully.', rate: 1, pitch: 1.4, voice: { name: 'Daniel' }, onend() {}, onerror() {} };
  return { engine, spoken, reports, audio, config, utterance };
}

test('PC failure falls back with same text and settings, without retrying every segment', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('Offline'); });
  await f.engine.speak(f.utterance); await f.engine.speak(f.utterance);
  assert.equal(calls, 1); assert.equal(f.spoken.length, 2);
  assert.equal(f.spoken[0].pitch, 1.4); assert.equal(f.spoken[0].voice.name, 'Daniel');
  f.engine.cancel();
});

test('button and headset pause/resume retain audio position and synchronize player state', async () => {
  const { Player } = require('./speech.js');
  let requests = 0;
  const f = fixture(async () => { requests++; return { ok: true, blob: async () => new Blob(['audio']) }; });
  let displayedState;
  const player = new Player(f.engine, text => ({ text }), () => ({ rate: 1, gap: 0 }), () => { displayedState = player.state; });
  player.setText('First.\n\nSecond.'); player.play();
  await new Promise(resolve => setImmediate(resolve));
  f.audio.currentTime = 1.234;
  const source = f.audio.src;
  player.pause();
  assert.equal(f.audio.paused, true); assert.equal(displayedState, 'paused');
  await f.audio.play(); // Headset resumes after the button paused.
  assert.equal(displayedState, 'speaking');
  f.audio.pause(); // Headset pauses; button resumes.
  assert.equal(displayedState, 'paused');
  player.play();
  assert.equal(displayedState, 'speaking'); assert.equal(f.audio.paused, false);
  assert.equal(f.audio.currentTime, 1.234); assert.equal(f.audio.src, source); assert.equal(requests, 1);
  player.stop(); assert.equal(displayedState, 'idle');
  f.audio.onpause(); assert.equal(displayedState, 'idle');
});

test('pause while fetching keeps prepared audio silent until resume', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  const pending = f.engine.speak(f.utterance); f.engine.pause();
  resolve({ ok: true, blob: async () => new Blob(['audio']) }); await pending;
  assert.equal(f.audio.paused, true); assert.equal(f.spoken.length, 0);
  f.engine.resume(); assert.equal(f.audio.paused, false); f.engine.cancel();
});

test('browser speech uses native pause and resume without repeating speech', async () => {
  const f = fixture(() => assert.fail('Must not fetch'));
  let pauses = 0, resumes = 0;
  f.engine.native.pause = () => pauses++;
  f.engine.native.resume = () => resumes++;
  f.config.source = 'browser'; await f.engine.speak(f.utterance);
  f.engine.pause(); f.engine.resume();
  assert.equal(pauses, 1); assert.equal(resumes, 1); assert.equal(f.spoken.length, 1); f.engine.cancel();
});

test('failed resume leaves the UI paused and allows retry', async () => {
  const f = fixture(async () => ({ ok: true, blob: async () => new Blob(['audio']) }));
  await f.engine.speak(f.utterance); f.engine.pause();
  let paused;
  f.engine.onPlaybackChange = value => { paused = value; };
  f.audio.play = async () => { throw new Error('Blocked'); };
  f.engine.resume(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused, true); assert.equal(f.engine.paused, true); f.engine.cancel();
});

test('pause interrupting a pending play promise does not trigger fallback', async () => {
  const f = fixture(async () => ({ ok: true, blob: async () => new Blob(['audio']) }));
  f.audio.play = async () => {
    f.engine.pause();
    const error = new Error('Playback interrupted'); error.name = 'AbortError'; throw error;
  };
  await f.engine.speak(f.utterance);
  assert.equal(f.spoken.length, 0); assert.equal(f.engine.failed, false);
  assert.equal(f.engine.paused, true); f.engine.cancel();
});
test('manual browser source never contacts PC', async () => {
  const f = fixture(() => assert.fail('Must not fetch'));
  f.config.source = 'browser'; await f.engine.speak(f.utterance);
  assert.equal(f.spoken.length, 1); f.engine.cancel();
});
test('stop while request is pending cannot start Edge audio or browser fallback', async () => {
  let reject;
  const f = fixture(() => new Promise((_, r) => { reject = r; }));
  const pending = f.engine.speak(f.utterance); f.engine.cancel(); reject(new Error('Offline'));
  await pending; assert.equal(f.spoken.length, 0);
});
test('successful Edge playback advances only on audio completion', async () => {
  let ended = 0, body;
  const f = fixture(async (_, options) => { body = JSON.parse(options.body); return { ok: true, blob: async () => new Blob(['audio']) }; });
  f.utterance.onend = () => ended++;
  await f.engine.speak(f.utterance);
  assert.equal(body.voice, 'en-GB-SoniaNeural'); assert.equal(ended, 0);
  f.audio.onended(); assert.equal(ended, 1); assert.equal(f.spoken.length, 0); f.engine.cancel();
});
test('mobile playback permission failure asks for a tap and allows retry', async () => {
  const f = fixture(async () => ({ ok: true, blob: async () => new Blob(['audio']) }));
  f.audio.play = async () => { const e = new Error(); e.name = 'NotAllowedError'; throw e; };
  let error;
  f.utterance.onerror = e => { error = e.error; };
  await f.engine.speak(f.utterance);
  assert.match(error, /Tap Play/); assert.equal(f.spoken.length, 0); assert.equal(f.engine.failed, false); f.engine.cancel();
});

test('late successful response after stop cannot play audio', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  f.audio.play = () => assert.fail('Canceled audio must not play');
  const pending = f.engine.speak(f.utterance); f.engine.cancel();
  resolve({ ok: true, blob: async () => new Blob(['audio']) });
  await pending; assert.equal(f.spoken.length, 0);
});
test('media error plus rejected play promise triggers fallback only once', async () => {
  const f = fixture(async () => ({ ok: true, blob: async () => new Blob(['audio']) }));
  f.audio.play = async () => { f.audio.onerror(); throw new Error('Bad media'); };
  await f.engine.speak(f.utterance);
  assert.equal(f.spoken.length, 1); f.engine.cancel();
});
