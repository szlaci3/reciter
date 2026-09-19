const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EdgeSpeech } = require('./edge-speech.js');

function fixture(fetcher, timers) {
  const spoken = [], reports = [];
  const audio = {
    paused: true, ended: false, currentTime: 0,
    async play() { this.paused = false; this.onplay?.(); },
    pause() { this.paused = true; this.onpause?.(); },
    removeAttribute() {}
  };
  const config = { source: 'auto', url: 'http://pc:8000', key: 'test', edgeVoice: 'en-GB-SoniaNeural' };
  const engine = new EdgeSpeech({ speak(u) { spoken.push(u); }, cancel() {} }, () => config, m => reports.push(m), audio, fetcher, timers);
  const utterance = { text: 'Listen carefully.', rate: 1, pitch: 1.4, voice: { name: 'Daniel' }, onend() {}, onerror() {} };
  return { engine, spoken, reports, audio, config, utterance };
}

function returnCheckFixture() {
  const pending = new Map(); let id = 0, requests = 0;
  const timers = {
    setTimeout(fn) { pending.set(++id, fn); return id; },
    clearTimeout(key) { pending.delete(key); }
  };
  const f = fixture(async () => {
    requests++; return { ok: true, blob: async () => new Blob(['audio']) };
  }, timers);
  const { Player } = require('./speech.js');
  const player = new Player(f.engine, text => ({ text }), () => ({ rate: 1, gap: 0 }), () => {});
  player.setText('An interrupted article.');
  return { ...f, player, pending, requests: () => requests };
}

test('return after a missed pause event offers resume without replacing the audio', async () => {
  const f = returnCheckFixture();
  f.player.play(); await new Promise(setImmediate);
  const source = f.audio.src;
  f.audio.currentTime = 4.2;
  f.audio.paused = true; // The OS paused audio without dispatching onpause.
  assert.equal(f.player.state, 'speaking');
  f.engine.reconcilePlayback();
  assert.equal(f.player.state, 'paused'); assert.equal(f.pending.size, 0);
  f.player.play();
  assert.equal(f.player.state, 'speaking'); assert.equal(f.audio.paused, false);
  assert.equal(f.audio.currentTime, 4.2); assert.equal(f.audio.src, source);
  assert.equal(f.requests(), 1); f.player.stop();
});

test('return after audio focus freezes playback offers resume even when paused is false', async () => {
  const f = returnCheckFixture();
  f.player.play(); await new Promise(setImmediate);
  f.audio.currentTime = 2.5;
  f.engine.reconcilePlayback();
  assert.equal(f.player.state, 'speaking');
  [...f.pending.values()][0](); // Time did not advance during the return check.
  assert.equal(f.player.state, 'paused'); assert.equal(f.audio.paused, true);
  f.player.play();
  assert.equal(f.player.state, 'speaking'); assert.equal(f.audio.currentTime, 2.5);
  assert.equal(f.requests(), 1); f.player.stop();
});

test('return does not interrupt progressing audio, loading, or completed playback', async () => {
  const f = returnCheckFixture();
  f.player.play();
  f.engine.reconcilePlayback(); assert.equal(f.pending.size, 0); // Still loading.
  await new Promise(setImmediate);
  f.engine.reconcilePlayback();
  f.audio.currentTime += 0.5;
  [...f.pending.values()][0]();
  assert.equal(f.player.state, 'speaking'); assert.equal(f.audio.paused, false);
  f.audio.ended = true; f.audio.onended();
  f.engine.reconcilePlayback();
  assert.equal(f.player.state, 'ended'); f.player.stop();
});

test('return checks are canceled when hidden, paused, stopped, or replaced by another segment', async () => {
  const f = returnCheckFixture();
  f.player.play(); await new Promise(setImmediate);
  f.engine.reconcilePlayback(); f.engine.reconcilePlayback();
  assert.equal(f.pending.size, 1);
  f.engine.clearReturnCheck(); assert.equal(f.pending.size, 0);
  f.engine.reconcilePlayback(); f.player.pause(); assert.equal(f.pending.size, 0);
  f.player.play(); f.engine.reconcilePlayback();
  const stale = [...f.pending.values()][0];
  f.player.stop(); assert.equal(f.pending.size, 0);
  f.player.play(); await new Promise(setImmediate);
  stale(); assert.equal(f.player.state, 'speaking'); assert.equal(f.audio.paused, false);
  f.player.stop();
});

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
  assert.equal(f.audio.currentTime, 1.234); assert.equal(f.audio.src, source);
  assert.equal(requests, 2); // Current audio plus the next passage; resume adds no request.
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

const tick = () => new Promise(setImmediate);
const okAudio = () => ({ ok: true, blob: async () => new Blob(['audio']) });
const nextUtterance = f => ({ ...f.utterance, text: 'The next chunk.' });

test('next audio is fetched during playback and reused without a boundary request', async () => {
  const requests = [];
  const f = fixture((_, options) => new Promise(resolve => {
    requests.push({ resolve, body: JSON.parse(options.body), signal: options.signal });
  }));
  const next = nextUtterance(f);
  const first = f.engine.speak(f.utterance, next);
  assert.equal(requests.length, 1); // Prioritize startup before prefetching.
  requests[0].resolve(okAudio()); await first;
  assert.equal(requests.length, 2); assert.equal(requests[1].body.text, next.text);
  const source = f.audio.src;
  requests[1].resolve(okAudio()); await tick();
  assert.equal(f.audio.src, source); assert.equal(f.engine.mode, 'edge');
  await f.engine.speak(next);
  assert.equal(requests.length, 2); assert.notEqual(f.audio.src, source);
  assert.equal(f.spoken.length, 0); f.engine.cancel();
});

test('an unfinished prefetch is reused and pausing the wait keeps its result silent', async () => {
  let resolveNext, calls = 0;
  const f = fixture(() => ++calls === 1 ? Promise.resolve(okAudio()) : new Promise(r => { resolveNext = r; }));
  const next = nextUtterance(f);
  await f.engine.speak(f.utterance, next);
  f.audio.pause();
  const pending = f.engine.speak(next);
  f.engine.pause();
  assert.equal(calls, 2);
  resolveNext(okAudio()); await pending;
  assert.equal(f.audio.paused, true); assert.equal(f.spoken.length, 0);
  f.engine.resume(); assert.equal(f.audio.paused, false); f.engine.cancel();
});

test('cancel aborts prefetch and late completion cannot start or replace audio', async () => {
  let resolveNext, nextSignal, calls = 0;
  const f = fixture((_, options) => {
    if (++calls === 1) return Promise.resolve(okAudio());
    nextSignal = options.signal; return new Promise(r => { resolveNext = r; });
  });
  await f.engine.speak(f.utterance, nextUtterance(f));
  f.engine.cancel();
  assert.equal(nextSignal.aborted, true);
  f.audio.play = () => assert.fail('Canceled prefetch must not play');
  resolveNext(okAudio()); await tick();
  assert.equal(f.engine.prepared, null); assert.equal(f.engine.url, null);
  assert.equal(f.spoken.length, 0);
});

test('changed rate, voice, address, key or text never consumes stale prepared audio', async () => {
  for (const change of ['rate', 'edgeVoice', 'url', 'key', 'text']) {
    const bodies = [];
    const f = fixture(async (_, options) => { bodies.push(JSON.parse(options.body)); return okAudio(); });
    const next = nextUtterance(f);
    await f.engine.speak(f.utterance, next);
    if (change === 'rate') next.rate = 1.2;
    else if (change === 'text') next.text = 'Edited material.';
    else if (change === 'url') f.config.url = 'http://other-pc:8000';
    else f.config[change] += 'changed';
    await f.engine.speak(next);
    assert.equal(bodies.length, 3, change);
    assert.equal(bodies[2].text, next.text); assert.equal(bodies[2].rate, next.rate);
    assert.equal(bodies[2].voice, f.config.edgeVoice); f.engine.cancel();
  }
});

test('failed prefetch leaves current audio alone and falls back only when needed', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) return okAudio();
    throw new Error('PC disconnected');
  });
  const next = nextUtterance(f);
  await f.engine.speak(f.utterance, next); await tick();
  assert.equal(f.engine.mode, 'edge'); assert.equal(f.engine.failed, false);
  assert.equal(f.spoken.length, 0);
  await f.engine.speak(next);
  assert.equal(f.spoken.length, 1); assert.equal(f.spoken[0].text, next.text);
  assert.equal(f.engine.failed, true); assert.equal(calls, 2); f.engine.cancel();
});

test('manual phone speech discards prepared audio and does not prefetch', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return okAudio(); });
  const next = nextUtterance(f);
  await f.engine.speak(f.utterance, next);
  f.config.source = 'browser';
  await f.engine.speak(next, f.utterance);
  assert.equal(calls, 2); assert.equal(f.engine.prepared, null);
  assert.equal(f.spoken.length, 1); f.engine.cancel();
});

test('player prepares across chunks and passages while keeping the passage break and Replay', async () => {
  const { Player, edgeSegments } = require('./speech.js');
  const texts = [];
  const f = fixture(async (_, options) => { texts.push(JSON.parse(options.body).text); return okAudio(); });
  const pending = new Map(); let id = 0;
  const timers = {
    setTimeout(fn, delay) { assert.equal(delay, 2000); pending.set(++id, fn); return id; },
    clearTimeout(key) { pending.delete(key); }
  };
  const player = new Player(f.engine, text => ({ text }), () => ({ rate: 1, gap: 2 }), () => {}, timers);
  const paragraph = 'A useful sentence about the subject. '.repeat(30).trim();
  const parts = edgeSegments(paragraph);
  assert.equal(parts.length, 2);
  player.setText(paragraph + '\n\nFinal passage.'); player.play(); await tick();
  assert.deepEqual(texts, parts);
  f.audio.onended(); await tick();
  assert.deepEqual(texts, [...parts, 'Final passage.']);
  const source = f.audio.src;
  f.audio.onended();
  assert.equal(player.state, 'waiting'); assert.equal(f.audio.src, source);
  [...pending.values()][0](); await tick();
  assert.equal(texts.length, 3); assert.notEqual(f.audio.src, source);
  f.audio.onended(); assert.equal(player.state, 'ended');
  player.play(); await tick();
  assert.deepEqual(texts.slice(3), parts); assert.equal(player.index, 0); player.stop();
});

test('phone selection keeps short chunks and fallback preserves current passage boundaries', async () => {
  const { Player, edgeSegments, segments } = require('./speech.js');
  const f = fixture(async () => { throw new Error('PC offline'); });
  const text = 'An explanation that must be spoken in the correct order. '.repeat(23).trim();
  f.config.source = 'browser';
  assert.deepEqual(f.engine.segmentText(text), segments(text));
  f.config.source = 'auto';
  const expected = edgeSegments(text);
  assert.deepEqual(f.engine.segmentText(text), expected);
  assert.ok(expected.length > 1);
  const player = new Player(f.engine, text => ({ text }), () => ({ rate: 1, gap: 0 }), () => {});
  player.setText(text); player.play(); await tick();
  assert.equal(f.engine.failed, true);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(f.spoken[i].text, expected[i]);
    f.spoken[i].onend(); await tick();
  }
  assert.equal(player.state, 'ended'); assert.equal(f.spoken.length, expected.length);
  assert.deepEqual(f.engine.segmentText(text), segments(text)); player.stop();
});

test('HTTP 502 retries the identical request once and keeps Edge after success', async () => {
  const bodies = [];
  const f = fixture(async (_, options) => {
    bodies.push(options.body);
    return bodies.length === 1 ? { ok: false, status: 502 } : okAudio();
  });
  await f.engine.speak(f.utterance);
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(f.engine.mode, 'edge'); assert.equal(f.engine.failed, false);
  assert.equal(f.spoken.length, 0); f.engine.cancel();
});

test('two HTTP 502 responses abandon Edge and fall back once without a third attempt', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: false, status: 502 }; });
  await f.engine.speak(f.utterance);
  assert.equal(calls, 2); assert.equal(f.spoken.length, 1);
  assert.match(f.reports.at(-1), /502.*after 2 attempts/);
  await f.engine.speak(nextUtterance(f));
  assert.equal(calls, 2); assert.equal(f.spoken.length, 2); f.engine.cancel();
});

test('authentication and validation failures do not retry', async () => {
  for (const status of [400, 401, 403]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return { ok: false, status }; });
    await f.engine.speak(f.utterance);
    assert.equal(calls, 1); assert.equal(f.spoken.length, 1); f.engine.cancel();
  }
});

test('prefetch performs at most two attempts and its success is reused at playback', async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 2 ? { ok: false, status: 502 } : okAudio());
  const next = nextUtterance(f);
  await f.engine.speak(f.utterance, next); await tick();
  assert.equal(calls, 3); assert.equal(f.spoken.length, 0);
  await f.engine.speak(next);
  assert.equal(calls, 3); assert.equal(f.engine.mode, 'edge'); f.engine.cancel();
});

test('Stop after the first 502 prevents retry and fallback', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { ok: false, status: 502, body: { async cancel() { f.engine.cancel(); } } };
  });
  await f.engine.speak(f.utterance);
  assert.equal(calls, 1); assert.equal(f.spoken.length, 0);
  assert.equal(f.engine.mode, null);
});

test('pausing during the second attempt keeps returned audio paused', async () => {
  let calls = 0, resolve;
  const f = fixture(() => ++calls === 1 ? Promise.resolve({ ok: false, status: 502 })
    : new Promise(r => { resolve = r; }));
  const pending = f.engine.speak(f.utterance); await tick();
  assert.equal(calls, 2); f.engine.pause();
  resolve(okAudio()); await pending;
  assert.equal(f.audio.paused, true); assert.equal(f.spoken.length, 0);
  f.engine.resume(); assert.equal(f.audio.paused, false); f.engine.cancel();
});

test('reported clarification excerpt advances through all passages with zero or three-second gaps', async () => {
  const { Player, passages } = require('./speech.js');
  const text = 'Clarification – infer what the user really means.\n\n' +
    'Context enrichment – automatically inject relevant background, goals, constraints, and previous decisions.\n\n' +
    'Professionalization – rewrite the request the way a domain expert would formulate it.';
  for (const gap of [0, 3]) {
    const requests = [], timers = [];
    const f = fixture(async (_, options) => { requests.push(JSON.parse(options.body).text); return okAudio(); });
    const player = new Player(f.engine, text => ({ text }), () => ({ rate: 1, gap }), () => {}, {
      setTimeout(fn, delay) { assert.equal(delay, 3000); timers.push(fn); }, clearTimeout() {}
    });
    player.setText(text); player.play(); await tick();
    for (let i = 0; i < 3; i++) {
      f.audio.onended();
      if (i < 2 && gap) { assert.equal(player.state, 'waiting'); timers.shift()(); }
      await tick();
    }
    assert.deepEqual(requests, passages(text));
    assert.equal(player.state, 'ended'); assert.equal(f.spoken.length, 0);
    assert.equal(timers.length, 0); player.stop();
  }
});
