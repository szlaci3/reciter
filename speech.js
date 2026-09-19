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
      const parts = segments(this.items[this.index]);
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
        if (this.index + 1 >= this.items.length) { this.state = 'ended'; this.update(); return; }
        this.index++; this.state = 'waiting'; this.update();
        this.timer = this.timers.setTimeout(() => {
          if (token === this.generation) this.speak();
        }, this.settings().gap * 1000);
      };
      utterance.onerror = event => {
        if (token !== this.generation) return;
        this.invalidate(); this.state = 'error'; this.update(event.error || 'unknown');
      };
      this.state = 'speaking'; this.update();
      try { this.synth.speak(utterance); } catch { utterance.onerror({ error: 'speech unavailable' }); }
    }
  }
  const api = { passages, segments, Player };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ReciterSpeech = api;
})(globalThis);
