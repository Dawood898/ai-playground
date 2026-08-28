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
   ├── /v1/models   → filtered list of allowed models
   └── /v1/chat/completions
         1. Turnstile human check (if configured)
         2. Rate limit: 10 req/min per IP AND per session tab
         3. Model allowlist check
         4. Forwards to https://api.latency.cyou with your secret key
```

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

## Change the model list

Edit `worker/wrangler.toml`, line `ALLOWED_MODELS = "..."` — comma-separated,
no spaces needed. Model ids must exist on your new-api instance for this key.

To see all ids your key can currently use (PowerShell):

```powershell
curl.exe -s https://api.latency.cyou/v1/models -H "Authorization: Bearer sk-YOUR-KEY" | ConvertFrom-Json | ForEach-Object { $_.data.id }
```

Then republish:

```powershell
npx wrangler deploy --config worker/wrangler.toml
```

The `/v1/models` endpoint and the dropdown both follow this list — one source
of truth.

## Change the rate limit

`worker/wrangler.toml` → `MAX_RPM = "10"` → redeploy (same command as above).
It's a fixed 60-second window counted twice: once per visitor IP, once per
browser tab (session id in localStorage).

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

## Turnstile human check (the one manual step)

The Worker skips the human check until a secret exists, so the site works
right now without it. To enable:

### 1. Create the widget (dashboard — Cloudflare, Aug 2026 UI)

1. Open https://dash.cloudflare.com/?to=/:account/turnstile
   (or: log in → right sidebar **Turnstile**).
2. Click **Add widget**.
3. Fill in:
   - **Widget name**: `playground`
   - **Hostname management**: `chat.latency.cyou`
   - **Widget mode**: **Managed** (invisible unless suspicious)
4. Click **Create**.
5. Copy both strings shown: the **Sitekey** (`0x4...`) and the **Secret key** (`0x4...`).

### 2. Install them

Secret → Cloudflare (PowerShell, from the `ai-playground` folder):

```powershell
echo "PASTE-SECRET-KEY" | npx wrangler secret put TURNSTILE_SECRET_KEY --config worker/wrangler.toml
```

Sitekey → the page: open `docs/index.html`, find the line

```js
const TURNSTILE_SITEKEY = '1x00000000000000000000AA';
```

replace `1x00000000000000000000AA` with your real sitekey, save, then:

```powershell
git add docs/index.html
git commit -m "real turnstile sitekey"
git push
npx wrangler deploy --config worker/wrangler.toml
```

### 3. Verify

Open https://chat.latency.cyou in a normal browser, send a message. It should
answer. Then in DevTools → Network, the chat request carries an `X-Turnstile`
header. If you set the secret but forgot the sitekey (or vice versa), sends
fail with "Human verification required" — fix whichever half is missing.

Note: tokens expire after 5 minutes and are single-use; the page auto-refreshes
the widget, so a user who idles just presses send again.

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

## Local development

```powershell
# Terminal 1 — the Worker locally (uses worker/.dev.vars for test keys)
npx wrangler dev --config worker/wrangler.toml

# Terminal 2 — the page, pointed at localhost:8787 automatically
npx serve docs
```

Open http://localhost:3000 (serve's port). The page detects `localhost` and
talks to `http://localhost:8787` instead of the real API. `worker/.dev.vars`
holds a throwaway key + Cloudflare's global test Turnstile keys; it is
gitignored and must never be committed.

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
| "Model not available" | id not in `ALLOWED_MODELS` or not on your key | check id against upstream `/v1/models` |
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
