# Reciter

Your daily learning, spoken.

Personal listening prototype using the browser's Web Speech API. No dependencies, API keys, paid speech service, or build step. Preferred voice: **Daniel, British English, pitch 1.4**, based on the user's successful phone test. Browser voice availability still depends on the device.

## Run

Open `index.html` in a desktop browser, or serve this folder with Python:

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

On Windows, `py -m http.server 8000 --bind 0.0.0.0` may be the available command. From a phone on the same trusted Wi-Fi, visit `http://<computer-LAN-IP>:8000`. The computer must remain on and its firewall must allow the server on the private network. Run the command inside `Reciter/` so only this folder is served. This is a local test server, not a public deployment; no hosting account is needed.

## Use

Paste text, separating passages with blank lines. Daniel is selected when exposed by the browser, unless another voice was saved. If unavailable, the page clearly reports that and allows voice selection. Pitch starts at 1.4; speed starts at 1.0 and passage breaks at two seconds. Preferences and text persist in browser storage when permitted.

Play starts the selected passage. Pause cancels the current short segment; Resume repeats that segment. Stop resets to the beginning of the selected passage. Previous, Next, and the passage selector navigate passages; navigation continues playback when already playing. Editing text stops playback and returns to the first passage. Replay starts from the beginning after completion.

Long passages are split into short utterances to reduce problems with lengthy browser speech. This can affect phrasing. Voice, pitch, and speed changes take effect at the next segment; the break setting takes effect at the next passage break. Text is not sent to an application backend, but a browser/OS voice may use a remote speech service. No paid API is configured.

## Phone acceptance checks

1. Confirm Daniel is selected and pitch is 1.4. Compare the same text with the successful earlier voice test.
2. Try several paragraphs and then a longer session. Check pronunciation, speed, phrasing, and pauses.
3. Pause mid-passage and during a break; resume. Test Stop, passage navigation, and editing during playback.
4. Reload and check saved text/preferences. Try without a connection to discover whether this voice works offline.
5. Separately test screen locking and switching apps. Record phone model, OS, browser, and observed behavior; background playback is not guaranteed by this prototype.
6. Try AirPods controls as a separate experiment. No Media Session integration or headset-control support is implemented yet.

## Validation

```sh
node --test speech.test.js
```

Tests exercise passage parsing, speech settings, cancellation races, passage breaks, pause/resume, navigation, and retries with a mock speech engine. Real voice quality and mobile behavior require device testing.

Preparation context and ongoing decision diary are in `../Prepare-reciter/`. Content curation, spaced repetition, and AI integration are future work.
