# Deployment & Maintenance Guide

**Live site:** https://chat.latency.cyou
**Repo:** https://github.com/Dawood898/ai-playground
**Worker:** `playground-proxy` (Cloudflare account `beetlesmpfun@gmail.com`)

Everything is free tier. Last verified: 2026-08-28. Dashboard paths below
match Cloudflare's August 2026 UI — if a menu moved, the deep links still work.

---

## How it fits together

```
Visitor's browser
   │  https://chat.latency.cyou
   ▼
Cloudflare Worker "playground-proxy"
   ├── /            → serves docs/index.html (the page itself)
   ├── /v1/models   → Turnstile-gated, LIVE list (whatever this key sees)
   └── /v1/chat/completions
         1. Turnstile human check (every /v1/* route)
         2. Rate limit: 10 req/min per IP AND per session tab (chat only)
         3. Model allowlist check (empty = every model allowed)
         4. Forwards to https://api.latency.cyou with your secret key
```

The Turnstile check on **every** `/v1/*` route is what locks the domain down:
it only answers the playground page, never a raw API. `curl` with any key
gets `403 Human verification required` — each request needs a fresh,
single-use token minted by the widget on chat.latency.cyou (tokens are bound
to that hostname and to the requester's IP). The workers.dev mirror URL is
disabled too (`workers_dev = false`), so there is exactly one entry point.

Your real new-api key lives **only** inside Cloudflare as a Worker secret
(`NEW_API_KEY`). It is never in this repo, never in the page, never in the
browser. The page and the API are same-origin, so no CORS headaches.

Two files matter:

| File | What it controls | How to publish |
|---|---|---|
| `worker/wrangler.toml` | models, rate limit, upstream URL, allowed origins | `npx wrangler deploy --config worker/wrangler.toml` |
| `docs/index.html` | the whole page (looks + behavior) | same deploy command (assets are uploaded with it) |

---

## First-time setup (already done — reference only)

1. Install Node.js ≥ 18 from https://nodejs.org (LTS).
2. `git clone https://github.com/Dawood898/ai-playground` and `cd ai-playground`
3. `npx wrangler login` — a browser tab opens; click **Allow**.
4. `echo "sk-YOUR-KEY" | npx wrangler secret put NEW_API_KEY --config worker/wrangler.toml`
5. `npx wrangler deploy --config worker/wrangler.toml`
   — the first deploy of `chat.latency.cyou` as a custom domain automatically
   creates the DNS record and the TLS certificate. No dashboard clicking needed.

---

## The model list is LIVE (empty allowlist)

`worker/wrangler.toml` → `ALLOWED_MODELS = ""` is the **live mode**: the
Worker does NOT filter. `/v1/models` returns exactly what the new-api token
can see right now, and any model id passes the chat check. The page dropdown
and the public API therefore never show a stale or dead model — when new-api
adds/removes a model, the playground follows automatically. The list churns
basically daily, so hardcoding ids (the old behavior) is now deliberately
avoided.

To see all ids your key can currently use (PowerShell):

```powershell
curl.exe -s https://api.latency.cyou/v1/models -H "Authorization: Bearer sk-YOUR-KEY" | ConvertFrom-Json | ForEach-Object { $_.data.id }
```

To **pin** to a fixed list again (e.g. you found a model you don't want the
public poking), set `ALLOWED_MODELS` to a comma-separated list (no spaces):

```toml
ALLOWED_MODELS = "deepseek-v4-flash,glm-5.3-flash,qwen3.8-flash"
```

Then republish:

```powershell
npx wrangler deploy --config worker/wrangler.toml
```

Non-empty allowlist filters `/v1/models` AND rejects other models in chat —
one source of truth. Empty allowlist = live passthrough. The page cares
about neither: it renders whatever `/v1/models` returns.

## Change the rate limit

`worker/wrangler.toml` → `MAX_RPM = "10"` → redeploy (same command as above).
It's a fixed 60-second window counted twice: once per visitor IP, once per
browser tab (session id in localStorage). Only `/v1/chat/completions` counts
against it — the model list is Turnstile-gated but free.

## Rotate / replace the new-api key

```powershell
echo "sk-NEW-KEY" | npx wrangler secret put NEW_API_KEY --config worker/wrangler.toml
```

Takes effect immediately, no redeploy needed.

## Change allowed origins

Only needed if you serve the page from another domain.
`worker/wrangler.toml` → `ALLOWED_ORIGINS = "https://chat.latency.cyou"` →
add comma-separated origins → redeploy.

---

## Turnstile human check (configured — reference)

**Status: live.** The widget `playground` (Managed mode, hostname
`chat.latency.cyou`) is created, its secret is uploaded as the
`TURNSTILE_SECRET_KEY` Worker secret, and the sitekey is hardcoded in
`docs/index.html` (`TURNSTILE_SITEKEY = '0x4AAAAAAEfWe-UOt9lYfMGB'`).
Every `/v1/*` request must carry a fresh token from that widget or the
Worker answers `403 missing_turnstile`.

If you ever need to recreate it (dashboard — Cloudflare, Aug 2026 UI):

1. Open https://dash.cloudflare.com/?to=/:account/turnstile
   (or: log in → right sidebar **Turnstile**).
2. Click **Add widget** → **Widget name**: `playground`,
   **Hostname management**: `chat.latency.cyou`, **Widget mode**: **Managed**.
3. Copy both strings shown: the **Sitekey** (`0x4...`) and the **Secret key** (`0x4...`).
4. Secret → Cloudflare (PowerShell, from the `ai-playground` folder):

```powershell
echo "PASTE-SECRET-KEY" | npx wrangler secret put TURNSTILE_SECRET_KEY --config worker/wrangler.toml
```

5. Sitekey → the page: open `docs/index.html`, find the line

```js
const TURNSTILE_SITEKEY = '0x4AAAAAAEfWe-UOt9lYfMGB';
```

replace the value, save, then:

```powershell
git add docs/index.html
git commit -m "turnstile sitekey update"
git push
npx wrangler deploy --config worker/wrangler.toml
```

### Verify

Open https://chat.latency.cyou in a normal browser, send a message. It should
answer. In DevTools → Network, the chat request carries an `X-Turnstile`
header. If you set the secret but forgot the sitekey (or vice versa), sends
fail with "Human verification required" — fix whichever half is missing.

Note: tokens expire after 5 minutes and are single-use; the page resets the
widget after every request (including the models fetch on load), so a user
who idles just presses send again.

To **disable** the check again (e.g. for debugging):
`npx wrangler secret delete TURNSTILE_SECRET_KEY --config worker/wrangler.toml`.
The Worker skips the check when the secret is absent. Don't forget to
re-upload it — without it the domain is a public API endpoint again.

---

## Editing the page (docs/index.html)

Single file, zero build step, zero dependencies. The `<style>` block is
organized by section (tokens → aurora → glass → chat → …). The `<script>`
block starts with a `CONFIG` section (`API`, `TURNSTILE_SITEKEY`).

Publish changes:

```powershell
npx wrangler deploy --config worker/wrangler.toml
```

(Commit + push to GitHub afterwards so the repo matches production.)

## UI features (docs/index.html)

All behavior is client-side; nothing needs a backend change to tweak.

- **Stop button.** The send button is a submit that stays enabled while a
  stream is in flight. It gains the `stop` class → red, icon swaps to a
  square, label reads **Stop**. Clicking it calls
  `AbortController.abort()`; the partial stream stays in the bubble, the
  role label flips to **Stopped**, and a partial turn is still pushed to
  history.
- **TTFT + live tokens/s.** `t0 = performance.now()` before the fetch.
  The first SSE delta (content OR hidden `reasoning_content`) sets TTFT;
  token rate = chars/4 heuristic, updated per chunk and shown in the
  `.live-stats` bar (TTFT and Speed). Reasoning tokens count toward the
  rate but are never displayed (only `delta.content` renders in the bubble).
- **Live RPM counter + countdown.** `#rpm` shows `N / 10 left` plus a
  `0:59`-style countdown (`#rpmClock`). The window starts fresh (60 s) on
  every page load, so a refresh resets both the count and the timer. It's
  a local estimate — the server (Durable Object) is the authority.
- **Force Turnstile on every refresh.** The widget renders with
  `appearance:'always'` (always visible, never hidden). `loadModels()` and
  the `pageshow` / `visibilitychange` handlers call `refreshTurnstile()`
  (a reset), so bfcache restores and tab refocus re-run the human check
  instead of reusing a stale token.
- **Live model dropdown.** The select is populated by `loadModels()` from
  `/v1/models`; with the empty allowlist that's the full live list.
- **Removed dead tools.** Attach / Web / Options buttons and their no-op
  listeners are gone; only **Clear** remains on the toolbar.
- **Branding.** Header title links to https://latency.cyou/; the footer
  credits "provided by @zealot.bond on discord · made with ♥".

## Local development

```powershell
npx wrangler dev --config worker/wrangler.toml
```

Open http://localhost:8787 — the dev Worker serves the page **and** the API
from one port (assets are bundled), so no second server is needed. The page
detects `localhost` and stays same-origin.

`worker/.dev.vars` (gitignored, never commit) holds the throwaway key. Keep
`TURNSTILE_SECRET_KEY` commented out there: with no secret the Worker skips
the human check locally, which is the only way to test the chat path without
a real browser on the real hostname.

Two gotchas learned the hard way:

- **Origin gate vs miniflare.** `wrangler dev` rewrites the browser's
  `Origin: http://localhost:8787` to the route pattern
  (`http://chat.latency.cyou`), so the Worker can't see the dev page's real
  origin. The gate therefore skips requests whose *host* is
  `localhost`/`127.0.0.1` (see `isDevHost` in `worker/index.js`). The
  deployed Worker's host is always `chat.latency.cyou`, so production is
  unaffected. To let the browser exercise the origin gate locally, add a
  dev-only `ALLOWED_ORIGINS` override in `.dev.vars` (it overrides
  `[vars]` locally and is gitignored):
  `ALLOWED_ORIGINS=http://chat.latency.cyou,https://chat.latency.cyou`
- **Automation can't pass Turnstile — that's the feature.** Headless Chrome
  never renders the widget, and a CDP-attached real browser gets Cloudflare's
  managed challenge. So the positive end-to-end path (token → chat) can only
  be verified by a human in a normal browser at https://chat.latency.cyou.
  Locally, verify wiring with the secret skipped.

---

## Where things live in the Cloudflare dashboard (Aug 2026)

| Thing | Deep link | Menu path |
|---|---|---|
| Worker code / settings | https://dash.cloudflare.com/?to=/:account/workers/services/view/playground-proxy | **Workers & Pages** → `playground-proxy` |
| Secrets | same page → **Settings** tab → **Variables and Secrets** → **Secrets** → *Edit* | |
| Live logs | Worker page → **Observability** tab | |
| Requests / errors / analytics | Worker page → **Metrics** tab | |
| Custom domain | Worker page → **Settings** → **Domains & Routes** | |
| Turnstile widgets | https://dash.cloudflare.com/?to=/:account/turnstile | sidebar **Turnstile** |
| DNS for latency.cyou | https://dash.cloudflare.com/?to=/:zone/dns | select zone **latency.cyou** → **DNS** → *Records* |

The `chat.latency.cyou` DNS record was created automatically by the custom
domain route (orange-clouded CNAME). Don't delete it manually or the site 502s.

## Quotas (free plan)

- Workers: 100,000 requests/day, 10 ms CPU per request (network wait doesn't
  count — streaming chat is fine).
- Durable Object (the rate counter): included, single global `WindowLimiter`.
- Turnstile: unlimited, free.
- Custom domain: free.

If you ever exceed 100k requests/day, the paid Workers plan is $5/mo.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `530` / site down | DNS record deleted or proxied off | re-add via **Domains & Routes** or redeploy |
| "Forbidden origin" 403 | page served from a domain not in `ALLOWED_ORIGINS` | add origin, redeploy |
| "Model not available" | only if `ALLOWED_MODELS` is non-empty and the id isn't in it (or not on your key) | empty the allowlist for live mode, or add the id, redeploy |
| 429 immediately on every send | clock-skewed fixed window or shared NAT IP | wait 60 s; if persistent, raise `MAX_RPM` |
| Chat fails only after Turnstile setup | sitekey/secret mismatch or wrong hostname on widget | widget hostnames must include `chat.latency.cyou` |
| Old code still served | asset cache | hard refresh (Ctrl+Shift+R); assets are content-hashed so deploys are instant |

## Security notes

- The Worker key should be a **dedicated** new-api token with its own quota
  cap, not your main account key. Set the quota in new-api's token page.
- Origin check and rate limit are friction, not fortification — anyone can
  run curl. The real protection is: dedicated token + quota + Turnstile +
  10 rpm. That's the right posture for a public playground.
- `.dev.vars` and any real secret must never enter git (`.gitignore` covers it).
