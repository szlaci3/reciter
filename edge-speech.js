/* Adapter keeps passage navigation/cancellation shared with browser speech. */
(function (root) {
  class EdgeSpeech {
    constructor(native, config, report, audio, fetcher = fetch) {
      Object.assign(this, { native, config, report, audio, fetcher });
      this.generation = 0;
      this.failed = false;
    }
    cancel() {
      this.generation++;
      this.controller?.abort();
      clearTimeout(this.timeout);
      this.audio.onended = this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
      this.native?.cancel();
    }
    // Called synchronously from Play to unlock the reusable mobile audio element.
    unlock() {
      this.audio.src = 'data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQEAAACA';
      this.audio.play()?.catch(() => {});
    }
    browser(utterance, reason) {
      if (!this.native) {
        utterance.onerror({ error: 'Browser speech unavailable. Connect the PC and retry.' });
        return;
      }
      this.report(reason + ' Using ' + (utterance.voice?.name || 'browser default (Daniel unavailable)') + '.');
      try { this.native.speak(utterance); }
      catch { utterance.onerror({ error: 'Phone speech failed. Tap Play or choose another phone voice.' }); }
    }
    async speak(utterance) {
      const token = ++this.generation;
      let fellBack = false;
      const fallback = reason => {
        if (fellBack || token !== this.generation) return;
        fellBack = true;
        this.audio.onended = this.audio.onerror = null;
        this.audio.pause();
        this.failed = true;
        this.browser(utterance, reason);
      };
      const c = this.config();
      if (c.source === 'browser' || this.failed) {
        this.browser(utterance, c.source === 'browser' ? 'Phone voice selected.' : 'PC speech unavailable.');
        return;
      }
      this.controller = new AbortController();
      this.timeout = setTimeout(() => this.controller.abort(), 12000);
      try {
        if (!c.url || !c.key || !c.edgeVoice) throw new Error('Configure and connect the PC first.');
        const base = new URL(c.url);
        if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Use an HTTP or HTTPS PC address.');
        if (root.location?.protocol === 'https:' && base.protocol !== 'https:') throw new Error('The hosted page needs an HTTPS PC address.');
        this.report('Preparing Edge audio…');
        const response = await this.fetcher(c.url.replace(/\/$/, '') + '/api/speech', {
          method: 'POST', signal: this.controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
          body: JSON.stringify({ text: utterance.text, voice: c.edgeVoice, rate: utterance.rate })
        });
        if (!response.ok) throw new Error('PC speech request failed (' + response.status + ').');
        const blob = await response.blob();
        if (token !== this.generation) return;
        clearTimeout(this.timeout);
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = URL.createObjectURL(blob);
        this.audio.src = this.url;
        this.audio.onended = () => { if (token === this.generation) utterance.onend(); };
        this.audio.onerror = () => {
          if (token !== this.generation) return;
          fallback('Edge audio could not play.');
        };
        await this.audio.play();
        if (token === this.generation && !fellBack) this.report('Edge · ' + c.edgeVoice);
      } catch (error) {
        if (token !== this.generation) return;
        clearTimeout(this.timeout);
        if (error.name === 'NotAllowedError') {
          this.audio.onended = this.audio.onerror = null;
          utterance.onerror({ error: 'Tap Play again to allow audio, or switch to phone voice.' });
          return;
        }
        fallback(error.name === 'AbortError' ? 'PC speech timed out.' : error.message);
      }
    }
  }
  if (typeof module !== 'undefined') module.exports = { EdgeSpeech };
  else root.EdgeSpeech = EdgeSpeech;
})(globalThis);
