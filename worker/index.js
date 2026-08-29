/**
 * AI Playground proxy — Cloudflare Worker
 *
 * Responsibilities:
 *  - Hold the real new-api key as a Worker secret (never sent to the browser).
 *  - Enforce N requests/minute per IP AND per browser session (Durable Object windows).
 *  - Restrict which models the public can poke (ALLOWED_MODELS).
 *  - CORS-lock to the GitHub Pages origin(s).
 *  - Stream SSE responses straight through.
 */

const WINDOW_SECONDS = 60;

// How long a single Turnstile pass keeps a browser session "verified" so we
// don't challenge the visitor on every request. After it lapses, the worker
// asks for a fresh token (same session re-verifies invisibly via managed mode).
const VERIFY_TTL_SECONDS = 1800;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // No browser sends a forged Origin; non-browsers (curl) send none.
    // Reject anything not on the allowlist. (Cosmetic gate, not real
    // security — the real gates are Turnstile + rate limit + restricted token.)
    // Same-origin GETs from browsers carry NO Origin header at all, so an
    // empty origin is allowed through.
    // On localhost (wrangler dev) the gate is skipped: miniflare rewrites the
    // browser's Origin to the route pattern, so a dev page can never present
    // its real origin. The deployed Worker's host is always chat.latency.cyou,
    // so this branch never runs in production.
    const isDevHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (!isDevHost && allowed.length > 0 && origin && !allowed.includes(origin)) {
      return json({ error: { message: 'Forbidden origin.' } }, 403, env, null);
    }

    if (request.method === 'OPTIONS') {
      return preflight(origin);
    }

    if (request.method !== 'POST' && request.method !== 'GET') {
      return json({ error: { message: 'Method not allowed.' } }, 405, env, origin);
    }

    // --- routes ----------------------------------------------------------
    let upstreamPath = null;
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      upstreamPath = '/v1/chat/completions';
    } else if (url.pathname === '/v1/models' && request.method === 'GET') {
      upstreamPath = '/v1/models';
    } else {
      return json({ error: { message: 'Unknown endpoint.' } }, 404, env, origin);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown-ip';
    const session = (request.headers.get('X-Session') || '').slice(0, 64) || ip;
    const max = Number(env.MAX_RPM || 10);

    // --- Turnstile human check: verify ONCE per session -----------------
    // Each /v1/* request used to need a fresh, single-use token, which forced
    // the widget to be reset (and the visitor re-checked) on EVERY request.
    // Now the first request in a session exchanges the token for a short-lived
    // "verified" grant. Later requests from the same session (same X-Session,
    // a UUID the page keeps in localStorage) skip the check until the grant
    // expires — visitors only re-verify after a refresh/new session, the grant
    // lapsing, or a rejected token.
    // Verified BEFORE the rate limiter so replayed/forged requests can't
    // burn a visitor's quota.
    if (env.TURNSTILE_SECRET_KEY) {
      const verified = await isSessionVerified(env, session);
      if (!verified) {
        const token = (request.headers.get('X-Turnstile') || '').slice(0, 2048);
        if (!token) {
          return json(
            { error: { message: 'Human verification required.', type: 'verification_error', code: 'missing_turnstile' } },
            403, env, origin
          );
        }
        const passed = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip);
        if (!passed) {
          return json(
            { error: { message: 'Human verification failed or expired.', type: 'verification_error', code: 'bad_turnstile' } },
            403, env, origin
          );
        }
        await markSessionVerified(env, session, VERIFY_TTL_SECONDS);
      }
    }

    // --- rate limit: chat only (models list is Turnstile-gated, cheap) ----
    if (upstreamPath === '/v1/chat/completions') {
      const [ipResult, sessionResult] = await Promise.all([
        checkLimit(env, 'ip:' + ip, max, WINDOW_SECONDS),
        checkLimit(env, 'session:' + session, max, WINDOW_SECONDS),
      ]);

      if (!ipResult.ok || !sessionResult.ok) {
        const retryAfter = Math.max(
          ipResult.ok ? sessionResult.reset : ipResult.reset,
          1
        );
        const body = {
          error: {
            message: `Rate limit reached: ${max} requests per minute. Try again in ~${retryAfter}s.`,
            type: 'rate_limit_error',
          },
        };
        return json(body, 429, env, origin, { 'Retry-After': String(retryAfter) });
      }
    }

    // --- model allowlist ---------------------------------------------------
    const allowlist = (env.ALLOWED_MODELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let bodyText;
    if (upstreamPath === '/v1/chat/completions') {
      bodyText = await request.text();
      let model;
      try {
        model = JSON.parse(bodyText).model;
      } catch {
        return json({ error: { message: 'Invalid JSON body.' } }, 400, env, origin);
      }
      if (allowlist.length > 0 && !allowlist.includes(model)) {
        return json(
          { error: { message: `Model '${model}' is not available on the playground.`, type: 'invalid_request_error' } },
          400,
          env,
          origin
        );
      }
    }

    // --- forward to new-api -------------------------------------------------
    const base = (env.UPSTREAM_BASE || '').replace(/\/+$/, '');
    if (!base) {
      return json({ error: { message: 'UPSTREAM_BASE not configured.' } }, 500, env, origin);
    }

    const headers = new Headers();
    headers.set('Authorization', 'Bearer ' + env.NEW_API_KEY);
    if (bodyText !== undefined) headers.set('Content-Type', 'application/json');

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(base + upstreamPath + url.search, {
        method: request.method,
        headers,
        body: bodyText,
      });
    } catch (e) {
      return json({ error: { message: 'Upstream unreachable.' } }, 502, env, origin);
    }
    // Copy upstream response, strip its CORS, attach ours.
    const outHeaders = new Headers(upstreamResponse.headers);
    outHeaders.delete('access-control-allow-origin');
    outHeaders.delete('access-control-allow-credentials');
    applyCors(outHeaders, origin);

    // /v1/models: only expose allowlisted models to the public.
    if (upstreamPath === '/v1/models' && allowlist.length > 0 && upstreamResponse.ok) {
      try {
        const data = await upstreamResponse.json();
        data.data = (data.data || []).filter((m) => allowlist.includes(m.id));
        return json(data, 200, env, origin);
      } catch {
        return json({ error: { message: 'Bad upstream models response.' } }, 502, env, origin);
      }
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: outHeaders,
    });
  },
};

// --- Durable Object: fixed-window counters --------------------------------

export class WindowLimiter {
  constructor(state) {
    this.state = state;
    this.buckets = null; // { key: { w: windowIndex, c: count } }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const nowSec = Math.floor(Date.now() / 1000);

    // --- verification grants (separate from rate-limit buckets) ----------
    // GET  /verified?session=<id>  -> { ok } whether the session still has a
    //                                 live Turnstile grant.
    // POST /verify  { session, ttl } -> (re)issue a grant for ttl seconds.
    if (url.pathname === '/verified' && request.method === 'GET') {
      const session = url.searchParams.get('session') || '';
      const grants = (await this.state.storage.get('v')) || {};
      return Response.json({ ok: (grants[session] || 0) > nowSec });
    }

    if (url.pathname === '/verify' && request.method === 'POST') {
      const body = await request.json();
      const session = (body.session || '').slice(0, 64);
      const ttl = Math.max(60, Number(body.ttl) || VERIFY_TTL_SECONDS);
      const grants = (await this.state.storage.get('v')) || {};
      grants[session] = nowSec + ttl;
      // Prune expired grants so the object never grows unbounded.
      for (const k of Object.keys(grants)) {
        if (grants[k] <= nowSec) delete grants[k];
      }
      this.state.waitUntil(this.state.storage.put('v', grants));
      return Response.json({ ok: true });
    }

    // --- rate limit (default route) ---------------------------------------
    const { key, max, window } = await request.json();
    const w = Math.floor(nowSec / window);

    if (!this.buckets) {
      this.buckets = (await this.state.storage.get('b')) || {};
    }
    let b = this.buckets[key];
    if (!b || b.w !== w) {
      b = { w, c: 0 };
    }

    let ok;
    if (b.c >= max) {
      ok = false;
    } else {
      b.c += 1;
      ok = true;
    }
    this.buckets[key] = b;

    // Prune stale windows so the object doesn't grow forever.
    if (Object.keys(this.buckets).length > 2000) {
      for (const k of Object.keys(this.buckets)) {
        if (this.buckets[k].w !== w) delete this.buckets[k];
      }
    }
    this.state.waitUntil(this.state.storage.put('b', this.buckets));

    const reset = (w + 1) * window - nowSec;
    return Response.json({ ok, reset });
  }
}

async function checkLimit(env, key, max, window) {
  const id = env.LIMITER.idFromName('playground');
  const stub = env.LIMITER.get(id);
  try {
    const res = await stub.fetch('https://limiter/check', {
      method: 'POST',
      body: JSON.stringify({ key, max, window }),
    });
    return await res.json();
  } catch {
    // Fail closed only on limiter crash would punish users; fail open is
    // acceptable because the new-api token itself is quota-limited.
    return { ok: true, reset: 0 };
  }
}

// --- Turnstile session grant helpers --------------------------------------

function getLimiterStub(env) {
  const id = env.LIMITER.idFromName('playground');
  return env.LIMITER.get(id);
}

async function isSessionVerified(env, session) {
  if (!session) return false;
  try {
    const stub = getLimiterStub(env);
    const res = await stub.fetch('https://limiter/verified?session=' + encodeURIComponent(session));
    const data = await res.json();
    return !!data.ok;
  } catch {
    // If the limiter is unreachable, fall back to requiring a fresh token so
    // the check fails closed (it will be re-verified and re-granted).
    return false;
  }
}

async function markSessionVerified(env, session, ttl) {
  if (!session) return;
  try {
    const stub = getLimiterStub(env);
    await stub.fetch('https://limiter/verify', {
      method: 'POST',
      body: JSON.stringify({ session, ttl }),
    });
  } catch {
    // Best-effort: the next request will re-verify and re-grant.
  }
}

// --- helpers ---------------------------------------------------------------

function applyCors(headers, origin) {
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
}

function preflight(origin) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Session, X-Turnstile',
    'Access-Control-Max-Age': '86400',
  });
  applyCors(headers, origin);
  return new Response(null, { status: 204, headers });
}

function json(payload, status, env, origin, extra = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (origin) applyCors(headers, origin);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(payload), { status, headers });
}

async function verifyTurnstile(secret, token, remoteip) {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip }),
    });
    const data = await res.json();
    return !!data.success;
  } catch {
    return false; // fail closed on verification outage
  }
}
