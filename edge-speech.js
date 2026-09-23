/* Adapter keeps passage navigation/cancellation shared with browser speech. */
(function (root) {
  const parsing = typeof module !== 'undefined' ? require('./speech.js') : root.ReciterSpeech;
  class EdgeSpeech {
    static validAccessKey(key) {
      return /^(?:[a-z]{4}|[A-Za-z0-9_-]{32,128})$/.test(key);
    }
    constructor(native, config, report, audio, fetcher = fetch, timers = globalThis) {
      Object.assign(this, { native, config, report, audio, fetcher, timers });
      this.generation = 0;
      this.failed = false;
      this.mode = null;
      this.paused = false;
      this.sessionStarted = false;
      audio.onpause = () => {
        if (this.mode !== 'edge' || !audio.paused || audio.ended) return;
        this.paused = true; this.onPlaybackChange?.(true);
      };
      audio.onplay = () => {
        if (this.mode !== 'edge' || audio.paused) return;
        this.paused = false; this.onPlaybackChange?.(false);
      };
    }
    segmentText(text) {
      this.beginSession();
      return this.config().source === 'browser' || this.failed
        ? parsing.segments(text) : parsing.edgeSegments(text);
    }
    connectionKey(c) { return JSON.stringify([c.url, c.key]); }
    beginPassage() {
      this.beginSession();
      if (this.config().source === 'browser' || this.connection || !this.failed) return;
      // Retry the selected voice on the first unread chunk of each passage.
      // Keep failures latched within a passage and leave active warm-up alone.
      this.discardPrepared();
      this.browserNext = null;
      this.failed = false;
      this.recovering = false;
    }
    beginSession() {
      const c = this.config();
      if (!c.warmup || c.source === 'browser' || this.sessionStarted) return;
      this.sessionStarted = true;
      if (this.readyKey === this.connectionKey(c) && Date.now() - this.readyAt < 60000) {
        this.failed = false;
        this.recovering = false;
        return;
      }
      this.connect();
    }
    cancelConnection() {
      const run = this.connection;
      this.connection = null;
      run?.controller?.abort();
      this.timers.clearTimeout(run?.timeout);
      this.timers.clearTimeout(run?.retry);
      run?.wake?.();
    }
    async connect() {
      this.cancelConnection();
      const c = { ...this.config() }, run = {};
      this.connection = run;
      this.failed = true;
      this.recovering = true;
      this.readyKey = null;
      const current = () => this.connection === run && this.connectionKey(this.config()) === this.connectionKey(c);
      const terminal = message => Object.assign(new Error(message), { terminal: true });
      try {
        const address = new URL(c.url);
        if (!['http:', 'https:'].includes(address.protocol)) throw terminal('Use an HTTP or HTTPS service address.');
        if ((root.location?.protocol === 'https:' || c.key?.length >= 32) && address.protocol !== 'https:') {
          throw terminal('Use an HTTPS service address with a hosted page or cloud access key.');
        }
        if (!EdgeSpeech.validAccessKey(c.key)) throw terminal('Enter the service access key: four lowercase letters for your PC, or the full cloud key.');
        this.report('Starting speech service… Phone speech is available while it wakes.');
        // Six bounded requests plus five short delays allow about 87 seconds
        // for a sleeping host. This is independent of speech-request timeouts.
        for (let attempt = 0; attempt < 6 && current(); attempt++) {
          run.controller = new AbortController();
          run.timeout = this.timers.setTimeout(() => run.controller.abort(), 12000);
          try {
            const response = await this.fetcher(c.url.replace(/\/$/, '') + '/api/voices', {
              signal: run.controller.signal, headers: { Authorization: 'Bearer ' + c.key }
            });
            run.controller.signal.throwIfAborted();
            if (!current()) return false;
            if (!response.ok) {
              await response.body?.cancel();
              if ([400, 401, 403, 404].includes(response.status)) throw terminal('Connection failed (' + response.status + '). Check the service address, access key and allowed origin.');
              throw new Error('Speech service unavailable (' + response.status + ').');
            }
            const list = await response.json();
            run.controller.signal.throwIfAborted();
            if (!current()) return false;
            if (!Array.isArray(list) || !list.length || list.some(v => !v ||
                typeof v.name !== 'string' || !v.name || typeof v.locale !== 'string' || typeof v.gender !== 'string')) {
              throw terminal('The service returned an invalid voice catalogue.');
            }
            this.onVoices?.(list);
            this.readyKey = this.connectionKey(c); this.readyAt = Date.now();
            this.failed = false;
            this.report(this.mode === 'browser' ? 'Edge ready. Preparing the next segment; phone speech continues.' : 'Edge voices ready. Press Play to listen.');
            if (this.mode === 'browser') this.prepareRecovery();
            return true;
          } catch (error) {
            if (!current()) return false;
            if (error.terminal || attempt === 5) throw error;
          } finally { this.timers.clearTimeout(run.timeout); }
          await new Promise(resolve => {
            run.wake = resolve;
            run.retry = this.timers.setTimeout(resolve, 3000);
          });
        }
      } catch (error) {
        if (current()) this.report(error.message + ' Continuing with phone speech. Press Connect to retry.');
      } finally {
        if (this.connection === run) this.connection = null;
      }
      return false;
    }
    prepareRecovery() {
      this.discardPrepared();
      if (!this.failed && this.browserNext) this.prepared = this.requestAudio(this.browserNext, { ...this.config() });
    }
    finishSession() {
      this.cancelConnection();
      this.sessionStarted = false;
      this.browserNext = null;
      this.recovering = false;
      this.discardPrepared();
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
      this.finishSession();
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
        utterance.onerror({ error: 'Browser speech unavailable. Connect the speech service and retry.' });
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
      let timeout;
      const request = {
        key: this.audioKey(utterance, c),
        abort() { clearTimeout(timeout); controller.abort(); }
      };
      // Store failures as results so speculative requests never reject unhandled.
      request.result = (async () => {
        try {
          if (!c.url || !c.key || !c.edgeVoice) throw new Error('Configure and connect the speech service first.');
          const base = new URL(c.url);
          if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Use an HTTP or HTTPS service address.');
          if ((root.location?.protocol === 'https:' || c.key.length >= 32) && base.protocol !== 'https:') {
            throw new Error('A hosted page or cloud access key needs an HTTPS service address.');
          }
          for (let attempt = 1; attempt <= 2; attempt++) {
            controller.signal.throwIfAborted();
            // Each attempt gets its own timeout: a slow 502 must not consume
            // the second attempt's allowance. Stop still cancels both attempts.
            timeout = setTimeout(() => controller.abort(), 12000);
            try {
              const response = await this.fetcher(c.url.replace(/\/$/, '') + '/api/speech', {
                method: 'POST', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
                body: JSON.stringify({ text: utterance.text, voice: c.edgeVoice, rate: utterance.rate })
              });
              controller.signal.throwIfAborted();
              if (response.status === 502 && attempt === 1) {
                await response.body?.cancel();
                continue;
              }
              if (!response.ok) throw new Error('Edge speech request failed (' + response.status + ')' +
                (attempt === 2 ? ' after 2 attempts.' : '.'));
              return { blob: await response.blob() };
            } finally { clearTimeout(timeout); }
          }
        } catch (error) {
          return { error };
        } finally { clearTimeout(timeout); }
      })().then(result => { request.completed = result; return result; });
      return request;
    }
    discardPrepared() {
      this.prepared?.abort();
      this.prepared = null;
    }
    async speak(utterance, next) {
      this.beginSession();
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
        this.readyKey = null;
        this.browser(utterance, reason);
      };
      const c = { ...this.config() };
      // During recovery, never hold up Daniel for an unfinished MP3. Only
      // consume audio for this exact unread segment once it is already ready.
      if (c.source !== 'browser' && this.recovering && !this.failed) {
        if (this.prepared?.key !== this.audioKey(utterance, c)) this.discardPrepared();
        if (this.prepared?.completed?.error) {
          this.failed = true; this.readyKey = null;
        } else if (this.prepared?.completed?.blob) {
          this.recovering = false;
        } else {
          this.browserNext = next;
          this.browser(utterance, 'Edge is preparing.');
          this.prepareRecovery();
          return;
        }
      }
      if (c.source === 'browser' || this.failed) {
        this.discardPrepared();
        this.browserNext = next;
        this.browser(utterance, c.source === 'browser' ? 'Phone voice selected.' : this.connection ? 'Speech service is waking.' : 'Edge speech unavailable.');
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
          this.readyAt = Date.now();
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
        fallback(error.name === 'AbortError' ? 'Edge speech timed out.' : error.message);
      }
    }
  }
  if (typeof module !== 'undefined') module.exports = { EdgeSpeech };
  else root.EdgeSpeech = EdgeSpeech;
})(globalThis);
