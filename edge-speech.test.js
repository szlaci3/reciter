const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EdgeSpeech } = require('./edge-speech.js');

function fixture(fetcher) {
  const spoken = [], reports = [];
  const audio = { play: async () => {}, pause() {}, removeAttribute() {} };
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
