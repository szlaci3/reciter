# Reciter

Your daily learning, spoken.

Personal listening prototype with PC-hosted **edge-tts** and automatic browser-speech fallback. The usual setup is a running PC and a phone on the same Wi-Fi. No paid API key is needed. `edge-tts` uses Microsoft's online service through an unofficial integration; its future availability is not guaranteed.

## Start on Windows

From this folder in PowerShell:

```powershell
.\start.ps1
```

The launcher installs dependencies into `.venv` if needed and starts the server on port 8000. Keep the terminal open. If script execution is restricted, run the equivalent commands individually:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py
```

1. Open `http://<PC-LAN-IP>:8000` on the phone using the same trusted Wi-Fi. Use `ipconfig` on the PC to find its Wi-Fi/Ethernet IPv4 address. Windows Firewall must allow this Python service on your private network.
2. Expand **PC connection**, enter that same address, and type the **four lowercase letters** printed in the terminal. The key is stored in `.reciter-token` on the PC and in session storage for the browser tab. It is not included in the public build. Existing long keys are replaced automatically on server restart; restart the service and reload the phone page after updating.
3. Tap **Connect / retry Edge**, choose an Edge voice, then **Play**. The initial choice is British English Sonia. Ryan, Thomas, Libby, and Maisie were also returned by the live voice-list test.
4. Choose **Phone voice only** to switch manually. Daniel, British English, is the preferred phone voice at pitch 1.4. If unavailable, the page reports that and lets you choose another browser voice.

Text, address, source, voice selection, and playback settings persist in local browser storage when available. The access key survives reloads in the same tab through session storage; you may need to enter it again in a new session.

## Playback and fallback

Automatic mode requests MP3 audio from the PC. The PC sends the requested text to Microsoft's speech service. An unavailable PC, failed synthesis, authentication failure, or request timeout triggers phone speech for the same segment. The failed PC is not retried for every subsequent segment; a fresh Play or Connect attempt retries it. A PC restart may require Connect again to reload its voice catalogue.

Switching source stops playback; press Play to restart the current passage with the selected source. Pause preserves the current Edge audio position, and Resume continues from that position, including within a word. Phone speech uses the browser's native pause/resume, whose behavior needs device testing. Stop followed by Play restarts the current passage. Pausing during preparation keeps the resulting audio paused; pausing between passages waits for Resume before starting the next passage. Previous/Next and the passage selector navigate passages. Editing text stops playback and resets the position. Browser pitch starts at 1.4; Edge uses natural pitch. Speed applies to both engines. Speech remains divided into short segments (up to 220 characters), so transitions may affect phrasing.

The server keeps up to 100 generated segments in memory, keyed by text, voice, and speed. Restarting the server clears this cache. It does not save user audio or text to disk. Browser voices themselves may require internet.

While Edge audio plays, the browser prepares one upcoming segment, including the first segment of the next passage. At the boundary it reuses that request or completed audio instead of starting a new request. This is intended to reduce the reported 2–3-second loading gaps between 7–12-second chunks. The first segment still needs loading time; slow preparation can still cause a wait. The configured passage pause remains. Stop, navigation, and text/source changes discard the buffer; changed voice, speed, or connection settings prevent reuse of mismatched audio. A failed preparation leaves current audio playing and triggers phone fallback only if that failed segment is subsequently needed.

This change awaits a phone listening check. It does not provide sample-accurate gapless playback: each chunk is still a separate audio source, so iOS controls may briefly change at boundaries and mid-sentence intonation may remain. Document length increases the number of boundaries, not the amount of text sent in each request.

Mobile browsers can require another tap before audio starts, including after an asynchronous fallback. If playback is blocked, tap Play again or select Phone voice only. Where supported, Media Session play/pause controls use the same functions as the buttons. Edge audio play/pause events also synchronize the UI when the headset controls the audio directly. Resume does not replace the audio source or request the segment again. Double-tap Next/Previous mapping is deferred. Screen locking and longer background sessions still need device testing.

User-verified behavior on the tested phone differs by speech source:

| Behavior | Female Edge voice | Daniel (phone/browser speech) |
| --- | --- | --- |
| AirPod one-tap pause/resume during an established listening session | Works, including switching between button and headset controls | Does not respond to one tap |
| One-tap Replay after the document finishes | Works; restarts the document | Not established; one-tap controls do not work in the reported test |
| Starting a YouTube video | Silences Reciter | Daniel keeps speaking |
| Returning after YouTube interrupts Reciter | Shows Resume; the on-screen button works | The reported Edge interruption flow does not apply |

With the female Edge voice, one tap still does not start playback on a freshly loaded page or resume after returning from YouTube before touching the controls. Use the on-screen Play/Resume button in those cases. The attempted headset-readiness change did not resolve these limitations and was reverted. For Daniel, use the on-screen controls and pause or stop Reciter before starting YouTube. Edge plays generated audio through an HTML audio element; Daniel uses browser speech synthesis, so their headset and interruption behavior can differ.

When returning to Reciter, the page checks for interrupted playback. If Edge audio is paused, or its playback position remains frozen for 1.5 seconds after returning, the interface offers Resume while retaining the current audio and position. The user confirmed this fix works with the female Edge voice. Playback that is still advancing continues normally. Phone speech is reconciled only when the browser reports it paused; this does not make Daniel stop when YouTube starts. An interruption that silences audio while its reported position continues advancing cannot be detected by this check.

## Later: Netlify or Vercel frontend, PC speech service

Yes: hosting the frontend independently means it can load and use Daniel while the PC is off. Build public files with:

```powershell
python build.py
```

Deploy **only `dist/`** as a static site. The build contains only the five frontend assets; no Python server, virtual environment, access key, or tests. No hosting deployment is performed by this implementation.

For Edge speech from that hosted HTTPS site, the PC service also needs a reachable **HTTPS endpoint** (for example, an appropriately configured tunnel or HTTPS reverse proxy). A plain LAN HTTP address is not sufficient for this implementation's hosted-page connection. The endpoint must be reachable from the phone's network. Hosting the frontend does not itself expose the PC service, and the frontend does not discover the PC automatically.

Start the PC helper allowing the exact frontend origin:

```powershell
.\.venv\Scripts\python.exe server.py --origin https://your-reciter-site.netlify.app
```

Enter the PC's HTTPS endpoint and access key in the hosted frontend, then Connect. Multiple `--origin` arguments are supported. A tunnel/reverse proxy and deployment are not configured yet. API calls require the key, and cross-origin browser calls are restricted to configured origins. Keep the key private and do not put it in source control or build settings exposed to browsers.

When the PC is off, the hosted website continues with the phone voice. This does not imply offline website support: an internet connection is still needed to load the hosted frontend.

## Verification

On Windows the service uses Python's selector event loop to avoid the Proactor socket-cleanup traceback (`ConnectionResetError: WinError 10054`) seen after a remote connection closes. Exceptions are not globally suppressed. Restart the PC service after updating to activate this change.

```powershell
node --test speech.test.js edge-speech.test.js
.\.venv\Scripts\python.exe -m unittest test_server -v
```

Tests cover passage playback, cancellation races, phone fallback, manual selection, audio completion, mobile playback rejection, authentication, CORS, input validation, restricted static serving, and audio caching. Mocked tests cannot verify voice quality or mobile permissions.

Optional live check (sends one generic sample sentence to Microsoft):

```powershell
.\.venv\Scripts\python.exe live_smoke.py
```

Live verification on 2026-09-19 successfully listed British neural voices and generated 32,112 bytes of Sonia MP3 audio through the service. No browser interaction or listening-quality test was performed.
