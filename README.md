# Reciter

Your daily learning, spoken.

Personal listening prototype with PC-hosted **edge-tts** and automatic browser-speech fallback. The usual setup is a running PC and a phone on the same Wi-Fi. No paid API key is needed. `edge-tts` uses Microsoft's online service through an unofficial integration; its future availability is not guaranteed.

## Render deployment preparation

See [Deploy to Render Free](DEPLOY-RENDER.md) for the prepared Blueprint, environment settings, and deployment checks. `render.yaml` configures a free Python service with a generated cloud access key, an explicit HTTPS frontend origin, Render's port, and `/healthz`. Automatic deployment is disabled. No cloud service has been created yet.

Public startup (`--public`, Render's `RENDER=true`, or a configured `RECITER_ACCESS_KEY`) requires a 32–128-character URL-safe access key and at least one HTTPS origin in `RECITER_ALLOWED_ORIGINS` or `--origin`. Generate a random key; a long human password is not equivalent. Cloud keys stay in server environment settings and browser session storage, and are never printed by server startup or placed in the static build. The normal PC launcher keeps its four-letter LAN key. Host the frontend independently for Daniel to work while Render sleeps.

## Start on Windows

From this folder in PowerShell:

```powershell
.\start.ps1
```

Stop the server with **Ctrl+C**. On Windows, an idle-loop wake-up checks for console interrupts every 250 ms; shutdown allows active requests up to 3 seconds to finish. If Ctrl+C appears unresponsive, press **Esc** first to exit terminal text selection, then try again. An older, already-running server needs to be stopped once (close its dedicated terminal window if necessary) and relaunched to use this fix.

The launcher installs dependencies into `.venv` if needed and starts the server on port 8000. Keep the terminal open. If script execution is restricted, run the equivalent commands individually:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py
```

1. Open `http://<PC-LAN-IP>:8000` on the phone using the same trusted Wi-Fi. Use `ipconfig` on the PC to find its Wi-Fi/Ethernet IPv4 address. Windows Firewall must allow this Python service on your private network.
2. Expand **Speech service connection**, enter that same address, and type the **four lowercase letters** printed in the terminal. The LAN key is stored in `.reciter-token` on the PC and in session storage for the browser tab. It is not included in the public build. Cloud deployments instead use the full generated environment key.
3. Tap **Connect / retry Edge**, choose an Edge voice, then **Play**. The initial choice is British English Sonia. Ryan, Thomas, Libby, and Maisie were also returned by the live voice-list test.
4. Choose **Phone voice only** to switch manually. Daniel, British English, is the preferred phone voice at pitch 1.4. If unavailable, the page reports that and lets you choose another browser voice.

Documents persist in IndexedDB; address, source, voice selection, and playback preferences remain in local storage. The access key survives reloads in the same tab through session storage; you may need to enter it again in a new session.

## Content library

**Reload the same phone page for the library and backup controls.** The storage upgrade preserves existing documents. The PC server must already include the buffered static-response fix described below. No Node/npm installation is needed to run the Windows speech service or use the library.

Choose a colored document card to open its title and text in the editor and load it into the existing player. **New document** creates an empty document ready for editing. Titles, text and topic tags save automatically; wait for **Saved on this device** before closing the page. Editing text or changing documents stops playback and resets the passage. Renaming, tagging, searching and sorting preserve the current playback position. The last selected document opens again on reload; playback position is not saved across reloads.

Each document has a stable ID, title, text, identity color, creation/modification timestamps, and a revision used to detect conflicting edits from another tab. The twelve dark colors all support white text at a contrast ratio of at least 4.5:1. Colors persist after renaming, editing, and reloading; all palette colors are used before reuse. Cards start in creation order. **Sort by** offers oldest/newest created, recently updated, and title A–Z. **Search** matches all entered words across title, full text and tags, ignoring case. **Topic** filters by a tag; search and topic filters work together. Filtering does not change the open document. View controls reset on reload.

Enter comma-separated **Topic tags** in the editor. Empty and repeated tags are removed, ignoring case; tags do not control document identity colors. **Duplicate** saves pending edits, then opens an independent copy with its own ID and a different color from the source, retaining the text and tags.

**Move to Trash** retains the document and its color. Choose **Show → Trash** and open a card to view/listen to its read-only contents, **Restore** it, or **Delete permanently**. Permanent deletion is available only in Trash and asks for confirmation naming the document. Trash is never automatically emptied. Restore retains the original ID, creation date, content, tags and color. Trashing or deleting the selected document opens another active document if available; otherwise the editor and player are empty until you choose or create one. Emptying the library does not reimport the old pasted text.

Database version 2 adds tags and Trash metadata to existing records without replacing their IDs, text, colors, timestamps or revisions. Saves, duplicates, Trash/restore and deletion use revision checks and transactions so stale tabs cannot silently overwrite or delete newer changes. Failed actions retain the document and can be retried; retrying permanent deletion asks for confirmation again. Backup and transfer are available below the library cards.

The previous saved text becomes the first document once, without removing its original local-storage copy. If no saved text exists, the initial welcome text becomes the first document. Database saves are serialized; switching documents waits for pending edits to save. Save failures retain the visible draft and block switching, with a **Retry** action. Conflicting edits from another tab are not overwritten silently: copy the draft before reloading. If IndexedDB is unavailable at startup, the previous text remains available for listening, but the page explicitly reports that editing will not be saved.

The library belongs to this browser profile and website origin (scheme, address, and port). It does not sync to another device or follow a move to a different PC address or Netlify. Clearing browser data, browser storage eviction, or ending a private-browsing session can remove it. Use Export database to keep a separate backup and Import/Add to transfer it to another browser or device. Hosting the frontend independently and offline page loading are still separate future work.

## Backup and transfer

Open **Backup and transfer** below the library cards:

- **Export database** saves pending edits and prepares a snapshot of all documents, including Trash. Tap **Save backup file** to save the JSON file in Files/Downloads. Preparing the link does not itself save a file outside the browser. A newly prepared export replaces the earlier download link.
- **Import database** validates a chosen backup and shows the incoming/current document and Trash counts. **Replace library…** then asks for final confirmation before replacing the entire library, including Trash. Export the current library first if you want to retain a recoverable copy. Empty backups can replace the library with an empty one.
- **Add to database** shows new documents, identical matches and conflicts. Existing documents remain unchanged. Matching IDs with identical title, text, tags, color, dates and Trash state are skipped (internal revisions are ignored). For differing matching IDs, choose **Keep both** (default) or **Keep existing**. Keep both creates imported copies with new IDs, different colors from the existing documents and an “(imported copy)” title suffix. Other content and Trash state are retained. Repeating Keep both can create further copies; the preview shows conflicts each time. Documents with different IDs are treated as separate, even if their text matches.

Backups preserve IDs, titles, text, tags, identity colors, timestamps, Trash state and selected document. Imported conflict copies get new identities as described above. Voice preferences, PC addresses/access keys, audio and the old localStorage text copy are not exported or replaced. Importing stops playback and refreshes the editor; export/review does not stop it. Add retains the current selection when available; replacement uses the backup's selection. Files are read locally and never sent to the speech service.

Files must use the Reciter JSON format (`format: "reciter-library"`, `version: 1`, `schemaVersion: 2`, numeric `exportedAt`, `selectedId`, and `documents`). Validation checks every document, unique IDs, field types, dates, revisions, readable dark colors, tags and the selection reference. Limits are 25 MiB and 10,000 documents; an additive result must also remain exportable within those limits. Unsupported versions and malformed files are rejected before import.

Imports commit in one database transaction: storage/quota failures roll back the document, selection and metadata changes. Editing the library after preview invalidates the review, so select the file again. Replacement advances internal revisions and a library generation marker to prevent stale tabs from overwriting restored data; those tabs must reload, preserving any unsaved draft first. The imported library is marked migrated, so an empty import does not resurrect the old pasted text. These operations transfer files; they do not provide automatic sync.

## Playback and fallback

Automatic mode now uses the selected phone voice immediately while checking an unverified or idle speech service in the background. Daniel remains the preferred phone voice when available. Connection checks make at most six attempts, each capped at 12 seconds, separated by three seconds (about 87 seconds total, subject to browser timer throttling). Authentication/address errors and invalid voice catalogues stop retries. Phone voice only makes no connection requests, including on page load or Connect.

Once the service returns its voice catalogue, Reciter prepares the next unread segment's Edge audio while phone speech continues. It switches only at a segment boundary with matching audio already available; otherwise the phone reads the next segment too. Current passage boundaries remain fixed so changing engines does not skip or repeat text. Pause retains phone playback; readiness alone does not start Edge audio. Stop, navigation, text/document changes, source/address/key changes and completion cancel pending connection work. Connect can retry during playback without stopping it. A successful connection is reused for new playback for up to one minute after readiness or successful Edge playback; older connections are checked again.

After connection retries are exhausted, phone speech continues. Use Connect to retry in the same listening session, or Stop then Play for a new attempt. A failed speech request after Edge has taken over still uses the existing latched fallback described below; this change does not repeatedly reconnect after every speech error. iPhone may request another tap when moving from phone speech to Edge: the existing playback-permission message asks for Play to retry the unread segment. This handoff still needs device verification.

The warm-up flow is a frontend change; reload the existing page to use it. The subsequent Render preparation also changes Python startup and adds `/healthz`, so restart the service to use those backend changes. To listen during a future Render wake-up on a fresh visit, host the static frontend independently. Strong environment-key authentication and deployment configuration are prepared; actual cloud deployment is pending. The four-letter key remains for the trusted LAN service.

Automatic mode requests MP3 audio from the PC. The PC sends the requested text to Microsoft's speech service. HTTP 502 from a speech request is retried once with identical text and settings: two attempts total, each with a 12-second client timeout. This applies to upcoming audio preparation as well as the current segment. If the retry fails, the existing phone fallback handles the same segment; authentication/validation errors, network failures, and client timeouts are not retried by this rule. Stop cancels pending work and prevents further attempts. The failed PC is not retried for every subsequent segment; a fresh Play or Connect attempt retries it. A PC restart may require Connect again to reload its voice catalogue.

Switching source stops playback; press Play to restart the current passage with the selected source. Pause preserves the current Edge audio position, and Resume continues from that position, including within a word. Phone speech uses the browser's native pause/resume, whose behavior needs device testing. Stop followed by Play restarts the current passage. Pausing during preparation keeps the resulting audio paused; pausing between passages waits for Resume before starting the next passage. Previous/Next and the passage selector navigate passages. Editing text stops playback and resets the position. Browser pitch starts at 1.4; Edge uses natural pitch. Speed applies to both engines.

Edge groups complete sentences into chunks with a target of 300 characters. A longer sentence stays intact up to a hard limit of 900 characters. Above that limit, it prefers the last comma, semicolon, or colon followed by whitespace within the first 900 characters, provided it occurs after character 450; otherwise it splits at whitespace where possible. These limits were halved as a listening experiment: shorter recordings may help reliability, but increase requests and audible chunk transitions. Numeric Wikipedia citations and closing quotes stay with the sentence, and common abbreviations are treated conservatively. Sentence detection is heuristic, so unusual punctuation may still produce imperfect boundaries. Phone-only playback retains the original 220-character chunks. If Edge fails within a passage, that passage's existing boundaries stay fixed to avoid skipping or repeating text during fallback; subsequent passages use shorter phone chunks. Voice and speed changes apply to the next chunk.

The server keeps up to 100 generated segments in memory, keyed by text, voice, and speed. Restarting the server clears this cache. It does not save user audio or text to disk. Browser voices themselves may require internet.

While Edge audio plays, the browser prepares one upcoming segment, including the first segment of the next passage. At the boundary it reuses that request or completed audio instead of starting a new request. This is intended to reduce the reported 2–3-second loading gaps between 7–12-second chunks. The first segment still needs loading time; slow preparation can still cause a wait. The configured passage pause remains. Stop, navigation, and text/source changes discard the buffer; changed voice, speed, or connection settings prevent reuse of mismatched audio. A failed preparation leaves current audio playing and triggers phone fallback only if that failed segment is subsequently needed.

The user confirmed that preparing the next chunk reduced gaps to roughly 300–700 ms and that sentence-aware grouping makes transitions sound more natural. Longer sessions still showed stops and an occasional switch to Daniel. The 502 retry is a candidate improvement awaiting a phone retest, not a verified fix for every stop. A zero-second passage gap now advances directly without scheduling a break timer; positive gaps retain their intentional delay. If playback stops again, record the status/connection messages, Play versus Resume button, and whether the phone was locked before refreshing.

Playback is not sample-accurate or gapless: each chunk is still a separate audio source, so pauses and brief iOS control changes may remain between chunks. First-audio preparation may take longer for longer chunks. Document length increases the number of boundaries, not the amount of text sent in each request.

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

Deploy **only `dist/`** as a static site. The build contains the frontend assets, local Dexie bundle, and its license; no Python server, virtual environment, access key, database contents, or tests. No hosting deployment is performed by this implementation.

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
npm ci
npm test
.\.venv\Scripts\python.exe -m unittest test_server -v
```

Tests cover passage playback, cancellation races, phone fallback, manual selection, audio completion, mobile playback rejection, authentication, CORS, input validation, restricted static serving, and audio caching. Mocked tests cannot verify voice quality or mobile permissions.

Library tests use Dexie with an in-memory IndexedDB implementation and a simulated DOM to check migration, reopening, save ordering/failure/retry, multi-tab conflicts, identity colors/contrast, safe text rendering, and player integration. Actual phone layout and browser persistence require a device check. `npm run vendor` refreshes the committed unminified `dexie.js` and `dexie.LICENSE` from the pinned npm dependency; runtime pages load the local files, not a CDN. The minified bundle downloaded successfully on the user's phone but failed with `SyntaxError: Unexpected token ')'`; the replacement is checked against ES5 syntax. Restart the PC server after this replacement so it serves the new filename. No database reset is needed. Continue building static files with `python build.py`.

Optional live check (sends one generic sample sentence to Microsoft):

```powershell
.\.venv\Scripts\python.exe live_smoke.py
```

Live verification on 2026-09-19 successfully listed British neural voices and generated 32,112 bytes of Sonia MP3 audio through the service. No browser interaction or listening-quality test was performed.


Startup diagnostics include the script error line/column and a short source excerpt when available. A fresh fetch of the same script URL reports whether its normalized source fingerprint matches the bundled version; this checks the new response, not the original failed execution. `npm run vendor` also updates the expected fingerprint in `index.html`. The iOS 26.6 startup failure was resolved by the buffered-response server fix below; preserve unsaved text before reloading and keep the same site address/browser so existing storage remains accessible.


The phone subsequently returned a different Dexie source fingerprint with unchanged length and a displaced function. The PC server now sends allowlisted static files as buffered immutable bytes, bypassing the suspected Windows selector-loop/sendfile transfer path. **Restart `start.ps1` for this server fix**, then reload the same Edge page after copying unsaved text. Failure diagnostics show `delivery buffered-v1` when this server code is active. The user confirmed mobile startup works in both Edge and Chrome. No database reset or Dexie version change was involved.

## Daily learning packages

Import a JSON learning package under **Daily listening**. Review and apply it, then open its dated card to see Must / Should / Can topics. Tap a topic to listen, or use the package Play button to start the first unfinished topic. Playback continues through the sections; a completed package can be replayed. The bottom player and package button control the same audio.

Progress saves automatically. Reopening restores the current spoken-segment boundary without autoplay; a short fragment may repeat. Export listening progress and give that JSON file to the preparation skill in Codex. Ratings and full source versions stay there.

Reimporting a package updates matching topics. Unchanged text retains progress; changed text starts afresh. Trash updates are explicit. For corrections, use the preparation skill so the full and shortened versions agree. Conflicting mobile edits are preserved and reported.

Database backups now include packages and progress (schema 3); older schema-2 backups remain importable. **Import learning package** is separate from backup **Add to database**, which retains its existing conflict choices.

For this update, reload the static frontend. Restart the local Python server or manually deploy Render to serve the new JavaScript files from those origins. Real iPhone playback and file-picker verification remains necessary.
