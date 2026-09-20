# Deploy the speech service to Render Free

The repository is prepared for a **Python web service on free compute**. No service has been created by this change. The frontend should be hosted independently (for example, Netlify's static hosting) so it can load and use Daniel while Render sleeps. No database, persistent disk, worker, paid API or Node backend is needed.

## Prepared configuration

[`render.yaml`](render.yaml) defines one web service, Python 3.14.4, `plan: free`, and automatic deployments disabled. Build: `pip install -r requirements.txt`. Start: `python server.py --public`. Health path: `/healthz`. The server binds to `0.0.0.0` and Render's `PORT`; TLS terminates at Render's HTTPS endpoint.

The Blueprint generates `RECITER_ACCESS_KEY` as a secret and asks for `RECITER_ALLOWED_ORIGINS`. Public mode refuses to start with a missing/short key or without an exact HTTPS frontend origin. It never reads `.reciter-token` or prints the cloud key. The normal Windows launcher still uses its four-letter LAN key.

The frontend refuses to send a cloud key over plain HTTP, even when the frontend itself is loaded from a local HTTP address.

The user deployed this configuration successfully at `https://reciter.onrender.com` and verified it from the Netlify frontend on mobile. The service's `/healthz`, authentication, CORS, voice loading and Edge speech path worked. A cold/waking service begins with Daniel and transitions to Sonia; this is expected. Local checks still cover the configured Python runtime and application behavior, not every Render control-plane detail.

## Deployment ownership

The canonical frontend is `https://reciter-fe.netlify.app`. Netlify automatically deploys the frontend after each Git push. The Python backend on Render requires a manual deployment. The Render Python process also serves a copy of the frontend at `https://reciter.onrender.com`; that copy can remain stale after a frontend Git push until the backend is manually redeployed. This is acceptable and expected. Use the Netlify address for normal listening and library data, and treat the Render root page as a secondary convenience/debug copy.

Keep the public Reciter repository available to the Netlify integration. Do not put private skills, secrets or private working notes in it. A skill moved to `Prepare-reciter` is private only if that repository itself is private; repository location alone does not change visibility. For genuinely private skills, use a private repository or a local/user skill directory outside either public deployment source.

## Billing and usage monitoring

The account requires **Billing Information** for this service, and the user must monitor it. The user reports an extra bandwidth charge of **$0.15 per 1 GB** beyond the included allowance. Usage metrics may be delayed by up to **two hours**, so the dashboard is not a real-time spending alarm. Review the account billing page and service usage regularly, especially after testing or extended listening.

Current reported usage at the time of deployment verification:

| Metric | Usage | Allowance/context |
| --- | ---: | --- |
| Included Bandwidth | 2 MB | 5 GB |
| HTTP Responses | 2 MB | Included in the bandwidth figure above |
| WebSocket Responses | 0 MB | None used |
| Service-Initiated | 0 MB | None used |
| Service-Initiated (Private Link) | 0 MB | None used |

These figures are a snapshot supplied by the user, not a guaranteed current dashboard value. Keep the service's bandwidth and billing limits in mind before large listening tests or sharing the URL. This application does not configure an account-level spending cap.

## Deployment steps

1. Choose the frontend's stable HTTPS address. Set `RECITER_ALLOWED_ORIGINS` to that origin, such as `https://your-reciter.netlify.app`, without a path. Multiple exact origins can be comma-separated. Wildcards and HTTP origins are rejected in public mode. This choice does not move library data: export/import is needed when changing frontend origins.
2. Make the prepared commit available in the **standalone Reciter repository** on your Git provider. In Render, create a Blueprint from that repository and its root `render.yaml`. If deploying from a parent repository instead, select `Reciter/render.yaml` and configure the service root directory as `Reciter` (with build/start commands relative to that directory).
3. In the preview, confirm **one Free web service**, no paid resources, and automatic deployments disabled. Supply the frontend origin when prompted. Keep the plan Free and check the workspace's current bandwidth allowance/billing settings before activation; the supplied research reports 5 GB/month and possible bandwidth charges with a payment method attached. This configuration does not set an account-wide spending cap.
4. Deploy and wait for `/healthz` to return `{"status":"ok"}` at the assigned `https://…onrender.com` address. Health checks test the process only; they do not contact Microsoft or establish speech availability. Do not create scheduled keep-alive pings.
5. Privately copy the generated `RECITER_ACCESS_KEY` from Render's environment settings. In the independently hosted Reciter page, open **Speech service connection**, paste the Render HTTPS service address and the **full** key, and choose Automatic. The password field preserves case, digits, `_` and `-`; credentials remain in that browser tab's session storage, not in exported backups or frontend builds.
6. Tap Connect or Play. Test voice loading and Sonia playback from the actual deployment; Microsoft's unofficial Edge speech service may behave differently from a cloud network. On a cold start, the app plays Daniel/the selected phone voice while checking readiness, then switches at an unread segment boundary once matching audio is ready. A refresh repeats this warm-up; a ready service can start a different document with Sonia. iPhone may require another tap to authorize audio.

The same Python process can serve its allowlisted frontend files, but a fresh visit to that Render URL must wait for the server to wake. To test the frontend there, add its exact HTTPS origin to `RECITER_ALLOWED_ORIGINS`; incoming proxy headers are deliberately not used to expand the origin allowlist. Prefer an independent static frontend for everyday use.

## Optional deployment verification

After installing `requirements.txt`, run:

```powershell
.\.venv\Scripts\python.exe live_smoke.py --url https://your-service.onrender.com --origin https://your-reciter.netlify.app
```

The script prompts for the cloud key without echoing it (or reads `RECITER_ACCESS_KEY` if already set privately in the shell). It checks unauthenticated health, rejection of unauthenticated API calls, CORS preflight, voice listing, and MP3 generation from one fixed generic sentence. It sends no library material and saves no audio or key. The first health request permits 90 seconds for a cold start. This check does contact Microsoft and consumes a small amount of service usage.

For a local check, omit `--url`; this starts an isolated test server and uses the same generic sentence. Neither form is a substitute for phone listening and permission tests.

## Operating notes

- Restarts/sleep clear the in-memory voice catalogue and audio cache; the browser library stays in IndexedDB. The app reloads the catalogue during readiness checks.
- Rotate a leaked key in Render's environment settings and restart/redeploy the service. Paste the replacement into each browser tab that needs access. Never put it in a frontend build variable, Git, a URL or a screenshot.
- A 401 means check the full key; a 403 from the browser often means its exact frontend origin is missing. Startup configuration errors appear in the service log without printing the key. A passing health check followed by 502 from the speech API means the process is running but the upstream speech request failed.
- The app gives startup about 87 seconds across bounded attempts. If the service takes longer, Daniel continues; Connect can retry without stopping it. Verify a real idle/sleep/wake cycle and the iPhone transition before calling deployment complete.
