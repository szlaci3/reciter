/* Adapter keeps passage navigation/cancellation shared with browser speech. */
(function (root) {
  class EdgeSpeech {
    constructor(native, config, report, audio, fetcher = fetch, timers = globalThis) {
      Object.assign(this, { native, config, report, audio, fetcher, timers });
      this.generation = 0;
      this.failed = false;
      this.mode = null;
      this.paused = false;
      audio.onpause = () => {
        if (this.mode !== 'edge' || !audio.paused || audio.ended) return;
        this.paused = true; this.onPlaybackChange?.(true);
      };
      audio.onplay = () => {
        if (this.mode !== 'edge' || audio.paused) return;
        this.paused = false; this.onPlaybackChange?.(false);
      };
    }
    // Mobile audio interruptions do not always deliver a pause event. On return,
    // reconcile the media state, then check for a clock frozen by lost audio focus.
    reconcilePlayback() {
      this.timers.clearTimeout(this.returnTimer);
      if (this.mode === 'browser') {
        if (this.native?.paused) {
          this.paused = true; this.onPlaybackChange?.(true);
        }
        return;
      }
      if (this.mode !== 'edge' || this.audio.ended) return;
      if (this.audio.paused) {
        this.paused = true; this.onPlaybackChange?.(true); return;
      }
      if (this.paused) return;
      const token = this.generation, position = this.audio.currentTime;
      this.returnTimer = this.timers.setTimeout(() => {
        if (token !== this.generation || this.mode !== 'edge' || this.paused || this.audio.ended) return;
        if (this.audio.paused || this.audio.currentTime === position) {
          this.pause();
          this.onPlaybackChange?.(true);
          this.report('Playback interrupted. Tap Resume to continue.');
        }
      }, 1500);
    }
    clearReturnCheck() {
      this.timers.clearTimeout(this.returnTimer);
      this.returnTimer = null;
    }
    cancel() {
      this.clearReturnCheck();
      this.mode = null;
      this.paused = false;
      this.generation++;
      this.request?.abort();
      this.request = null;
      this.discardPrepared();
      this.audio.onended = this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
      this.native?.cancel();
      // SpeechSynthesis can remain paused even after its queue is canceled.
      this.native?.resume?.();
    }
    pause() {
      this.clearReturnCheck();
      this.paused = true;
      if (this.mode === 'edge') this.audio.pause();
      if (this.mode === 'browser') this.native.pause();
    }
    resume() {
      this.clearReturnCheck();
      this.paused = false;
      if (this.mode === 'edge') {
        const token = this.generation;
        this.audio.play()?.catch(() => {
          if (token !== this.generation || this.mode !== 'edge') return;
          this.paused = true; this.onPlaybackChange?.(true);
          this.report('Audio could not resume. Tap Resume to retry.');
        });
      }
      if (this.mode === 'browser') this.native.resume();
    }
    // Called synchronously from Play to unlock the reusable mobile audio element.
    unlock() {
      this.audio.src = 'data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQEAAACA';
      this.audio.play()?.catch(() => {});
    }
    browser(utterance, reason) {
      this.mode = 'browser';
      if (!this.native) {
        utterance.onerror({ error: 'Browser speech unavailable. Connect the PC and retry.' });
        return;
      }
      this.report(reason + ' Using ' + (utterance.voice?.name || 'browser default (Daniel unavailable)') + '.');
      try { this.native.speak(utterance); if (this.paused) this.native.pause(); }
      catch { utterance.onerror({ error: 'Phone speech failed. Tap Play or choose another phone voice.' }); }
    }
    audioKey(utterance, c) {
      return JSON.stringify([c.url, c.key, c.edgeVoice, utterance.text, utterance.rate]);
    }
    requestAudio(utterance, c) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const request = {
        key: this.audioKey(utterance, c),
        abort() { clearTimeout(timeout); controller.abort(); }
      };
      // Store failures as results so speculative requests never reject unhandled.
      request.result = (async () => {
        try {
          if (!c.url || !c.key || !c.edgeVoice) throw new Error('Configure and connect the PC first.');
          const base = new URL(c.url);
          if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Use an HTTP or HTTPS PC address.');
          if (root.location?.protocol === 'https:' && base.protocol !== 'https:') throw new Error('The hosted page needs an HTTPS PC address.');
          const response = await this.fetcher(c.url.replace(/\/$/, '') + '/api/speech', {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
            body: JSON.stringify({ text: utterance.text, voice: c.edgeVoice, rate: utterance.rate })
          });
          if (!response.ok) throw new Error('PC speech request failed (' + response.status + ').');
          return { blob: await response.blob() };
        } catch (error) {
          return { error };
        } finally { clearTimeout(timeout); }
      })();
      return request;
    }
    discardPrepared() {
      this.prepared?.abort();
      this.prepared = null;
    }
    async speak(utterance, next) {
      this.clearReturnCheck();
      const token = ++this.generation;
      this.mode = 'loading';
      this.paused = false;
      let fellBack = false;
      const fallback = reason => {
        if (fellBack || token !== this.generation) return;
        fellBack = true;
        this.discardPrepared();
        this.mode = 'browser';
        this.audio.onended = this.audio.onerror = null;
        this.audio.pause();
        this.failed = true;
        this.browser(utterance, reason);
      };
      const c = { ...this.config() };
      if (c.source === 'browser' || this.failed) {
        this.discardPrepared();
        this.browser(utterance, c.source === 'browser' ? 'Phone voice selected.' : 'PC speech unavailable.');
        return;
      }
      try {
        this.report('Preparing Edge audio…');
        if (this.prepared?.key !== this.audioKey(utterance, c)) this.discardPrepared();
        const request = this.prepared || this.requestAudio(utterance, c);
        this.prepared = null;
        this.request = request;
        const result = await request.result;
        if (this.request === request) this.request = null;
        if (token !== this.generation) return;
        if (result.error) throw result.error;
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = URL.createObjectURL(result.blob);
        this.audio.src = this.url;
        this.mode = 'edge';
        this.audio.onended = () => {
          if (token !== this.generation) return;
          this.mode = null; utterance.onend();
        };
        this.audio.onerror = () => {
          if (token !== this.generation) return;
          fallback('Edge audio could not play.');
        };
        if (!this.paused) await this.audio.play();
        if (token === this.generation && !fellBack) {
          this.report('Edge · ' + c.edgeVoice);
          // Only one upcoming chunk is retained; do not delay the first audio.
          if (next) this.prepared = this.requestAudio(next, c);
        }
      } catch (error) {
        if (token !== this.generation) return;
        // Pausing while play() is pending can reject it with AbortError.
        if (error.name === 'AbortError' && this.mode === 'edge' && this.paused) return;
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
