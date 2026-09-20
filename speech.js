/* Shared parsing and playback logic; also exercised by Node's built-in test runner. */
(function (root) {
  function passages(text) {
    return text.trim().split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  }
  function segments(text) {
    // Keep utterances short without throwing away punctuation or words.
    const result = [];
    let rest = text.trim();
    while (rest.length > 220) {
      const window = rest.slice(0, 221);
      const punctuation = [...window.matchAll(/[.!?;:]\s/g)].pop();
      let end = punctuation && punctuation.index > 60 ? punctuation.index + 1 : window.lastIndexOf(' ');
      if (end < 1) end = 220;
      result.push(rest.slice(0, end));
      rest = rest.slice(end).trimStart();
    }
    if (rest) result.push(rest);
    return result;
  }
  function edgeSegments(text) {
    // Keep normal sentences intact. Bound requests below the server's 2000
    // character limit, even for pasted text without sentence punctuation.
    const target = 300, limit = 900;
    const source = text.trim(), sentences = [];
    let start = 0;
    const endings = /[.!?]+(?:["'”’\)\]]|\[\d+(?:[–,\-]\d+)*\])*(?=\s|$)/g;
    for (const match of source.matchAll(endings)) {
      const end = match.index + match[0].length;
      const prefix = source.slice(start, match.index + 1);
      // Prefer missing an ambiguous boundary to cutting a name or abbreviation.
      if (match[0] === '.' && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.|\b[A-Z]\.|\b(?:[A-Za-z]\.){2,})$/i.test(prefix)) continue;
      sentences.push(source.slice(start, end).trim());
      start = end;
    }
    if (source.slice(start).trim()) sentences.push(source.slice(start).trim());
    const chunks = []; let current = '';
    const flush = () => { if (current) chunks.push(current); current = ''; };
    for (let sentence of sentences) {
      if (current && current.length + 1 + sentence.length > target) flush();
      while (sentence.length > limit) {
        flush();
        const window = sentence.slice(0, limit + 1);
        const clause = [...window.matchAll(/[,;:]\s/g)].pop();
        let end = clause && clause.index > limit / 2 ? clause.index + 1
          : window.search(/\s+\S*$/);
        if (end < 1) end = limit;
        // Do not split a UTF-16 surrogate pair in an unbroken token.
        if (/[\uD800-\uDBFF]/.test(sentence[end - 1])) end--;
        chunks.push(sentence.slice(0, end));
        sentence = sentence.slice(end).trimStart();
      }
      current = current ? current + ' ' + sentence : sentence;
    }
    flush();
    return chunks;
  }
  class Player {
    constructor(synth, makeUtterance, settings, update, timers = globalThis) {
      Object.assign(this, { synth, makeUtterance, settings, update, timers });
      this.items = []; this.index = 0; this.part = 0; this.state = 'idle'; this.generation = 0;
      synth.onPlaybackChange = paused => {
        if (!this.utterance || !['speaking', 'paused'].includes(this.state)) return;
        this.state = paused ? 'paused' : 'speaking'; this.update();
      };
    }
    invalidate() {
      this.generation++;
      this.timers.clearTimeout(this.timer);
      this.timer = null;
      this.synth.cancel();
      this.utterance = null;
    }
    setText(text) { this.stop(); this.items = passages(text); this.index = 0; this.update(); }
    stop() { this.invalidate(); this.state = 'idle'; this.part = 0; this.update(); }
    select(index) {
      const active = this.state === 'speaking' || this.state === 'waiting';
      this.stop(); this.index = Math.max(0, Math.min(index, this.items.length - 1));
      if (active) this.play(); else this.update();
    }
    play() {
      if (!this.items.length || this.state === 'speaking' || this.state === 'waiting') return;
      if (this.state === 'paused' && this.utterance) {
        this.state = 'speaking'; this.update(); this.synth.resume(); return;
      }
      if (this.state === 'ended') { this.index = 0; this.part = 0; }
      this.speak();
    }
    pause() {
      if (this.state !== 'speaking' && this.state !== 'waiting') return;
      if (this.state === 'waiting') {
        this.invalidate(); this.state = 'paused'; this.update(); return;
      }
      this.state = 'paused'; this.update(); this.synth.pause();
    }
    speak() {
      const token = ++this.generation;
      // Freeze the current passage's boundaries across fallback and resume so
      // changing engines cannot reinterpret the current part index.
      const split = text => this.synth.segmentText?.(text) ?? segments(text);
      const parts = this.part === 0 ? (this.parts = split(this.items[this.index])) : this.parts;
      const settings = this.settings();
      const utterance = this.makeUtterance(parts[this.part]);
      this.utterance = utterance;
      utterance.voice = settings.voice;
      utterance.lang = settings.voice?.lang || 'en-GB';
      utterance.pitch = settings.pitch; utterance.rate = settings.rate;
      utterance.onend = () => {
        if (token !== this.generation) return;
        this.utterance = null;
        if (++this.part < parts.length) { this.speak(); return; }
        this.part = 0;
        if (this.index + 1 >= this.items.length) { this.synth.finishSession?.(); this.state = 'ended'; this.update(); return; }
        this.index++; this.state = 'waiting'; this.update();
        const gap = this.settings().gap * 1000;
        // A zero-length break needs no background timer between recordings.
        if (gap === 0) { this.speak(); return; }
        this.timer = this.timers.setTimeout(() => {
          if (token === this.generation) this.speak();
        }, gap);
      };
      utterance.onerror = event => {
        if (token !== this.generation) return;
        this.invalidate(); this.state = 'error'; this.update(event.error || 'unknown');
      };
      this.state = 'speaking'; this.update();
      const nextText = parts[this.part + 1] ?? (this.index + 1 < this.items.length
        ? split(this.items[this.index + 1])[0] : null);
      const next = nextText ? { text: nextText, rate: settings.rate } : null;
      try { this.synth.speak(utterance, next); } catch { utterance.onerror({ error: 'speech unavailable' }); }
    }
  }
  const api = { passages, segments, edgeSegments, Player };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ReciterSpeech = api;
})(globalThis);
