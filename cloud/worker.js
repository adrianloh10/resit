/* Resit cloud receipt reader — Cloudflare Worker.
 *
 * Public, multi-user replacement for the owner-only Claude-inbox pipeline.
 * The phone POSTs a receipt photo; this Worker calls Google Gemini (key kept
 * server-side as a secret) and returns the SAME JSON shape the app's
 * mergeAIResult() already consumes. Nothing is stored: the image is processed
 * in memory and discarded. The only thing written to the database is an
 * anonymous per-device daily counter (abuse / cost protection).
 *
 * Secrets (set with `wrangler secret put`, never in this file or git):
 *   GEMINI_API_KEY     — primary reader (Google Gemini)
 *   FALLBACK_API_KEY   — optional; enables the failover reader
 *   TURNSTILE_SECRET   — optional; if set, requests must carry a valid token
 *   PRO_UNLOCK         — master code; gates /mint and /revoke
 * Vars (wrangler.toml): ALLOW_ORIGINS, DAILY_CAP, RATE_LIMIT_PER_MIN,
 *   GEMINI_MODEL, FALLBACK_URL, FALLBACK_MODEL (OpenAI-compatible provider
 *   serving an open vision model, e.g. DeepInfra/Together/OpenRouter + Qwen-VL).
 * Binding: DB (D1) — optional; if absent, both the daily quota and the
 *   per-minute rate limit are skipped (fail-open, same as the original quota).
 *
 * Reading is provider-agnostic: Gemini is tried first; on ANY failure
 * (outage, quota, key problem, junk output) the request fails over to the
 * open-model provider when configured. Both outputs pass through one
 * normalizer so the app always receives the same JSON shape. With no
 * fallback configured, behaviour is identical to before.
 */

const CATEGORIES = ["Food", "Groceries", "Fuel", "Transport", "Shopping", "Bills", "Health", "Entertainment", "Other"];

/* Gemini responseSchema (OpenAPI subset): uppercase types, `nullable` instead
   of anyOf. Same fields the app expects back. */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    merchant: { type: "STRING" },
    total: { type: "NUMBER", nullable: true },
    date: { type: "STRING", nullable: true },
    time: { type: "STRING", nullable: true },
    category: { type: "STRING", enum: CATEGORIES },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { name: { type: "STRING" }, price: { type: "NUMBER" } },
        required: ["name", "price"]
      }
    },
    readable: { type: "BOOLEAN" }
  },
  required: ["merchant", "total", "date", "time", "category", "items", "readable"]
};

const SYSTEM_PROMPT =
  "You read Malaysian receipts and invoices (printed or handwritten, English/Malay/Chinese). " +
  "Extract the fields exactly as specified by the schema. " +
  "total = the final amount the customer paid (after tax, service charge and rounding) in RM. " +
  "Invoice books often write ringgit and sen in separate columns: '2269 | 00' means 2269.00. " +
  "Dates may appear as dd/mm/yy, dd.mm.yy or dd MON yyyy - convert to YYYY-MM-DD, assuming 20xx for 2-digit years. " +
  "If a screenshot shows a transaction date and a separate event/show date, use the transaction date. " +
  "merchant = the shop's brand name, cleaned of corporate suffixes (SDN BHD, registration numbers). " +
  "Pick the category that best fits the merchant and items. " +
  "Always fill merchant and total first; list AT MOST 20 line items (the total matters more than a complete item list). " +
  "Set readable=false if the image is not a receipt or is too unclear to read.";

/* One normalizer for every provider: whatever comes back is coerced into the
   exact shape the app consumes, defensively typed and capped. */
function normalizeResult(o) {
  if (!o || typeof o !== "object") return null;
  const num = v => {
    const n = typeof v === "string" ? parseFloat(v.replace(/[^\d.-]/g, "")) : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const items = Array.isArray(o.items)
    ? o.items.slice(0, 20)
        .map(i => ({ name: String((i && i.name) || "").slice(0, 80), price: num(i && i.price) || 0 }))
        .filter(i => i.name)
    : [];
  return {
    merchant: String(o.merchant || "").slice(0, 60),
    total: num(o.total),
    date: typeof o.date === "string" && o.date ? o.date.slice(0, 10) : null,
    time: typeof o.time === "string" && o.time ? o.time.slice(0, 5) : null,
    category: CATEGORIES.includes(o.category) ? o.category : "Other",
    items,
    readable: o.readable !== false
  };
}

/* Primary reader: Google Gemini. Returns {ok, result} or {ok:false, msg}. */
async function readWithGemini(env, image, mediaType) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
      {
        method: "POST",
        /* Key via header, not the ?key= query string — a query-string secret
           is one Cloudflare Logpush/Trace/observability toggle (a config
           change, not a code change) away from landing in access logs;
           Google's API supports this header as a documented alternative
           (Phase 13 review, 2026-08-05). No logging is enabled today (the
           file's only console.* calls never emit the URL), so this is
           defense-in-depth, not a fix for an active leak. */
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{
            parts: [
              { inline_data: { mime_type: mediaType, data: image } },
              { text: "Extract the expense fields from this receipt." }
            ]
          }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            /* Hard per-receipt cost caps: bound the output length and keep
               the Gemini 3.x model's "thinking" at its cheapest tier, so no
               single scan can run up a large bill. ~640 tokens covers a
               receipt with up to ~20 line items (fields + JSON syntax).
               `temperature`/`thinkingBudget` were the pre-3.x fields for
               this (Gemini's July 2026 migration guide marks them
               deprecated on 3.x models) -- thinkingLevel:"minimal" is the
               3.x replacement, and is also Google's own recommendation for
               high-volume extraction/classification tasks like this one. */
            maxOutputTokens: 640,
            thinkingConfig: { thinkingLevel: "minimal" }
          }
        })
      }
    );
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      const detail = errBody && errBody.error ? String(errBody.error.message || "") : "";
      /* Google returns an invalid/revoked key as 400 INVALID_ARGUMENT ("API
         key not valid..."), not 401/403 — check the message too, or a dead
         key silently falls into the generic message below. A 404 means the
         model id itself is gone (retired/renamed), a different fix than a
         bad key. */
      const msg = r.status === 401 || r.status === 403 || /api key not valid|api_key_invalid/i.test(detail) ? "Reader key invalid"
        : r.status === 404 ? "Reader model unavailable"
        : r.status === 429 ? "Reader is busy — try again in a minute"
        : /quota|billing/i.test(detail) ? "Reader quota exhausted for today"
        : "Couldn't read the receipt";
      console.error("gemini_fail", model, r.status, detail.slice(0, 200));
      return { ok: false, msg };
    }
    const data = await r.json();
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = parts && parts.find(p => typeof p.text === "string");
    if (!text) return { ok: false, msg: "No readable result" };
    const result = normalizeResult(JSON.parse(text.text));
    if (!result) return { ok: false, msg: "No readable result" };
    return { ok: true, result };
  } catch (err) {
    console.error("gemini_exception", model, String((err && err.message) || err).slice(0, 200));
    return { ok: false, msg: "Couldn't read the receipt" };
  }
}

/* Failover reader: any OpenAI-compatible provider serving an open vision
   model (DeepInfra / Together / OpenRouter + Qwen-VL etc.). Same caps. */
function fallbackConfigured(env) {
  return !!(env.FALLBACK_URL && env.FALLBACK_MODEL && env.FALLBACK_API_KEY);
}

async function readWithFallback(env, image, mediaType) {
  try {
    const r = await fetch(env.FALLBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.FALLBACK_API_KEY
      },
      body: JSON.stringify({
        model: env.FALLBACK_MODEL,
        temperature: 0,
        max_tokens: 640,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT +
              " Respond with ONLY one JSON object — no markdown, no commentary — with keys:" +
              " merchant (string), total (number or null), date (string YYYY-MM-DD or null)," +
              " time (string HH:MM or null), category (one of " + CATEGORIES.join("/") + ")," +
              " items (array of {name, price}), readable (boolean)."
          },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:" + mediaType + ";base64," + image } },
              { type: "text", text: "Extract the expense fields from this receipt." }
            ]
          }
        ]
      })
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      const detail = errBody && errBody.error ? String(errBody.error.message || errBody.error) : "";
      console.error("fallback_fail", env.FALLBACK_MODEL, r.status, detail.slice(0, 200));
      return { ok: false, msg: "Couldn't read the receipt" };
    }
    const data = await r.json();
    let text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== "string" || !text.trim()) return { ok: false, msg: "No readable result" };
    /* Open models sometimes wrap JSON in code fences — strip them. */
    text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return { ok: false, msg: "No readable result" };
    const result = normalizeResult(JSON.parse(text.slice(start, end + 1)));
    if (!result) return { ok: false, msg: "No readable result" };
    return { ok: true, result };
  } catch (err) {
    console.error("fallback_exception", env.FALLBACK_MODEL, String((err && err.message) || err).slice(0, 200));
    return { ok: false, msg: "Couldn't read the receipt" };
  }
}

function corsHeaders(origin, allowList) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (allowList.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const data = await r.json();
    return !!data.success;
  } catch (e) {
    return false;
  }
}

async function ensureLicenseTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS license_keys (key TEXT PRIMARY KEY, label TEXT, revoked INTEGER DEFAULT 0, created_at TEXT, used_at TEXT, device_id TEXT)"
  ).run();
}

/* RESIT-XXXX-XXXX-XXXX from an unambiguous alphabet (no 0/O/1/I). */
function mintKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map(b => alphabet[b % alphabet.length]);
  return "RESIT-" + chars.slice(0, 4).join("") + "-" + chars.slice(4, 8).join("") + "-" + chars.slice(8, 12).join("");
}

/* Quota is charged only for SUCCESSFUL reads: check the cap up front, but
   bump the counter after a provider answers — a burst of failures (blur,
   outage) can no longer lock a device out for the day. */
async function quotaExceeded(db, deviceId, cap) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare("SELECT count FROM device_quota WHERE device_id=?1 AND day=?2").bind(deviceId, day).first();
  return (row ? row.count : 0) >= cap;
}
async function bumpQuota(db, deviceId) {
  const day = new Date().toISOString().slice(0, 10);
  await db.prepare(
    "INSERT INTO device_quota(device_id, day, count) VALUES(?1, ?2, 1) " +
    "ON CONFLICT(device_id, day) DO UPDATE SET count = count + 1"
  ).bind(deviceId, day).run();
}

/* Per-device burst guard (Phase 17): a fixed-window per-minute counter,
   independent of the daily cost cap above — protects against a rapid-fire
   burst hammering the provider regardless of whether the daily count would
   still allow it. Charged on every attempt that reaches this point (not
   just successful reads), unlike the daily quota, since the point is
   request RATE, not cost. Table is lazily created (same "no migration
   ever needed" reasoning as license_keys/shared_rules) rather than added to
   schema.sql, since device_quota's one-time-manual-apply is the exception
   here, not the rule. */
async function ensureRateTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS device_rate (device_id TEXT NOT NULL, minute_bucket INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(device_id, minute_bucket))"
  ).run();
}
async function rateLimited(db, deviceId, cap) {
  const minute = Math.floor(Date.now() / 60000);
  const row = await db.prepare("SELECT count FROM device_rate WHERE device_id=?1 AND minute_bucket=?2").bind(deviceId, minute).first();
  return (row ? row.count : 0) >= cap;
}
async function bumpRate(db, deviceId) {
  const minute = Math.floor(Date.now() / 60000);
  await db.prepare(
    "INSERT INTO device_rate(device_id, minute_bucket, count) VALUES(?1, ?2, 1) " +
    "ON CONFLICT(device_id, minute_bucket) DO UPDATE SET count = count + 1"
  ).bind(deviceId, minute).run();
  /* Opportunistic sweep so the table can't grow unbounded — cheap (a handful
     of stale rows at most) since it only ever deletes buckets a couple of
     minutes old, run inline so no separate cron/cleanup job is needed. */
  await db.prepare("DELETE FROM device_rate WHERE minute_bucket < ?1").bind(minute - 2).run();
}

/* Constant-time string compare so a === short-circuit can't leak the secret
   byte-by-byte via timing (security review, 1.9.0). */
function safeEqual(a, b) {
  a = String(a == null ? "" : a); b = String(b == null ? "" : b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* The PRO_UNLOCK-gated endpoints (rulesExport, diagModels, diagProbe,
   /mint, /revoke, /unlock) compared the caller's code against the secret
   with safeEqual (good, constant-time) but nothing ever counted or
   throttled repeated failed attempts — unlike the receipt-reader path, a
   wrong guess cost nothing, so the secret could be brute-forced at
   whatever rate the caller wanted (found in Phase 13's full review,
   2026-08-05). Reuses the reader path's own rate-limit table, keyed
   per-IP and per-bucket-label so one endpoint's traffic can't starve
   another's budget. Fails OPEN on a DB error (same policy as the reader's
   rate limit) so a database hiccup can't lock the owner out of their own
   admin tools. */
async function adminRateLimited(request, env, label, cap) {
  if (!env.DB) return false;
  try {
    await ensureRateTable(env.DB);
    const ip = request.headers.get("CF-Connecting-IP") || "noip";
    const key = "admin:" + label + ":" + ip.slice(0, 64);
    if (await rateLimited(env.DB, key, cap)) return true;
    await bumpRate(env.DB, key);
    return false;
  } catch (e) { return false; }
}

/* ---- Shared learning pool (no personal data) ----
   Devices that opted into cloud reading AND sharing upload, at most weekly, the
   AI-derived rules their on-device reader learned from a cloud read: an OCR
   "garbled" shop token, the "clean" name printed on the receipt, and the
   total-line "hint" keyword. We store only the aggregate
   (garbled, clean, hint, week, seen_count) -- NEVER a device id, amount, date,
   image, location, or any timestamp beyond the server-computed ISO week. The
   table is created lazily (same pattern as license_keys), so no migration is
   ever needed. */
async function ensureRulesTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS shared_rules (garbled TEXT, clean TEXT, hint TEXT, week TEXT, seen INTEGER, PRIMARY KEY(garbled, clean, hint, week))"
  ).run();
}

/* ISO-8601 year-week ("YYYY-Www"), computed server-side so the client never
   sends a timestamp. Zero-padded and monotonic with time, so lexical
   comparison (week >= minWeek) selects a trailing window correctly, even
   across a year boundary (e.g. "2025-W52" < "2026-W01"). */
function isoYearWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;          /* Mon=1..Sun=7 */
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);  /* Thursday of this ISO week */
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + "-W" + String(weekNo).padStart(2, "0");
}

/* GET /rules/export?code=<PRO_UNLOCK>&weeks=N -- owner-only curation dump.
   Gated exactly like /unlock (wrong/absent code -> the same "Invalid code"
   403). Returns the last N weeks (default 2), ordered by seen DESC. */
async function rulesExport(request, env, cors) {
  if (await adminRateLimited(request, env, "owner", 5)) return json({ error: "Too many attempts — try again in a minute" }, 429, cors);
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim();
  if (!env.PRO_UNLOCK || !safeEqual(code, env.PRO_UNLOCK)) return json({ error: "Invalid code" }, 403, cors);
  if (!env.DB) return json({ error: "No database bound" }, 500, cors);
  let weeks = parseInt(url.searchParams.get("weeks") || "2", 10);
  if (!Number.isFinite(weeks) || weeks < 1) weeks = 2;
  if (weeks > 26) weeks = 26;
  try {
    await ensureRulesTable(env.DB);
    const minWeek = isoYearWeek(new Date(Date.now() - (weeks - 1) * 7 * 86400000));
    const res = await env.DB.prepare(
      "SELECT garbled, clean, hint, week, seen FROM shared_rules WHERE week >= ?1 ORDER BY seen DESC, garbled ASC LIMIT 2000"
    ).bind(minWeek).all();
    return json({ ok: true, weeks, since: minWeek, rules: (res && res.results) || [] }, 200, cors);
  } catch (e) {
    return json({ error: "Export failed" }, 500, cors);
  }
}

/* GET /diag/models?code=<PRO_UNLOCK> -- owner-only. Asks Google directly
   which models GEMINI_API_KEY can actually see (key validity + access, not
   guessed from docs). Same gate as /rules/export; never returns the key
   itself. Diagnostic tool born from the 2026-07-24 502 incident. */
async function diagModels(request, env, cors) {
  if (await adminRateLimited(request, env, "owner", 5)) return json({ error: "Too many attempts — try again in a minute" }, 429, cors);
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim();
  if (!env.PRO_UNLOCK || !safeEqual(code, env.PRO_UNLOCK)) return json({ error: "Invalid code" }, 403, cors);
  if (!env.GEMINI_API_KEY) return json({ error: "No Gemini key configured" }, 500, cors);
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return json({ ok: false, keyValid: false, status: r.status, detail: data && data.error ? data.error.message : "" }, 200, cors);
    }
    const names = Array.isArray(data.models) ? data.models.map(m => m.name).filter(Boolean) : [];
    return json({
      ok: true,
      keyValid: true,
      configuredModel: env.GEMINI_MODEL || null,
      configuredModelListed: names.includes("models/" + (env.GEMINI_MODEL || "")),
      flashModels: names.filter(n => /flash/i.test(n))
    }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 200, cors);
  }
}

/* 1x1 white JPEG -- smallest possible real image, used only to fire a
   real (tiny, capped) generateContent call per candidate model. */
const PROBE_IMAGE = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

/* GET /diag/probe?code=<PRO_UNLOCK> -- owner-only. models.list says a model
   is "in the catalog" but says nothing about whether THIS key/project can
   actually call it (2026-07-24 incident: gemini-2.5-flash-lite was listed
   but 404'd on generateContent). This fires one real, capped call per
   candidate and reports the true per-model status. */
async function diagProbe(request, env, cors) {
  if (await adminRateLimited(request, env, "owner", 5)) return json({ error: "Too many attempts — try again in a minute" }, 429, cors);
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim();
  if (!env.PRO_UNLOCK || !safeEqual(code, env.PRO_UNLOCK)) return json({ error: "Invalid code" }, 403, cors);
  if (!env.GEMINI_API_KEY) return json({ error: "No Gemini key configured" }, 500, cors);
  const candidates = [
    "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest",
    "gemini-2.0-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"
  ];
  const results = {};
  for (const m of candidates) {
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: PROBE_IMAGE } }, { text: "What color is this image? One word." }] }],
            generationConfig: { maxOutputTokens: 20 }
          })
        }
      );
      const body = await r.json().catch(() => ({}));
      results[m] = r.ok
        ? { status: r.status, ok: true }
        : { status: r.status, ok: false, detail: String((body && body.error && body.error.message) || "").slice(0, 150) };
    } catch (e) {
      results[m] = { status: 0, ok: false, detail: String((e && e.message) || e).slice(0, 150) };
    }
  }
  return json({ ok: true, results }, 200, cors);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowList = (env.ALLOW_ORIGINS || "https://adrianloh10.github.io,http://localhost:8902,https://localhost,http://localhost,capacitor://localhost,ionic://localhost")
      .split(",").map(s => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowList);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") {
      /* Owner-only curation export lives on GET (called by curl with a code
         query param, no Origin); every other GET is the health probe. */
      const gpath = new URL(request.url).pathname.replace(/\/+$/, "");
      if (gpath.endsWith("/rules/export")) return rulesExport(request, env, cors);
      if (gpath.endsWith("/diag/models")) return diagModels(request, env, cors);
      if (gpath.endsWith("/diag/probe")) return diagProbe(request, env, cors);
      return json({ ok: true, service: "resit" }, 200, cors);
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);

    const path = new URL(request.url).pathname.replace(/\/+$/, "");

    /* /mint and /revoke are owner-only admin actions authenticated by the
       PRO_UNLOCK secret in the body (checked below) -- called from curl/
       PowerShell per LICENSE-KEYS.md, which sends no Origin header at all
       (only browsers set that automatically). Must run BEFORE the origin
       gate below, or the documented admin workflow 403s with "Origin not
       allowed" before ever reaching the real auth check (found live,
       2026-07-24, minting a key via the documented PowerShell snippet). */
    if (path.endsWith("/mint") || path.endsWith("/revoke")) {
      if (await adminRateLimited(request, env, "owner", 5)) return json({ error: "Too many attempts — try again in a minute" }, 429, cors);
      let u;
      try { u = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400, cors); }
      if (!env.PRO_UNLOCK || !u || !safeEqual(u.secret, env.PRO_UNLOCK)) return json({ error: "Not allowed" }, 403, cors);
      if (!env.DB) return json({ error: "No database bound" }, 500, cors);
      await ensureLicenseTable(env.DB);
      if (path.endsWith("/mint")) {
        const key = mintKey();
        await env.DB.prepare("INSERT INTO license_keys(key, label, created_at) VALUES(?1, ?2, ?3)")
          .bind(key, String((u.label || "")).slice(0, 80), new Date().toISOString()).run();
        return json({ ok: true, key }, 200, cors);
      }
      const res2 = await env.DB.prepare("UPDATE license_keys SET revoked=1 WHERE key=?1").bind(String(u.code || "").trim()).run();
      return json({ ok: true, revoked: res2.meta.changes > 0 }, 200, cors);
    }

    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "Origin not allowed" }, 403, cors);

    /* ---- Pro licensing (continued) ----
       /unlock  {code, deviceId}      app redeems or re-verifies a key
       Keys live in the same D1 database; the table is created lazily so no
       manual migration is ever needed. The PRO_UNLOCK secret itself also still
       works as the owner's master code. */
    if (path.endsWith("/unlock")) {
      /* /unlock also serves real license-key redemption/re-verification
         (see comment above), not just the owner's master code, so it gets
         the reader path's own more generous per-minute cap rather than the
         strict owner-only one used by /mint, /revoke, and the diag/export
         endpoints — enough to stop brute-forcing PRO_UNLOCK without
         throttling a real customer re-checking their key. */
      if (await adminRateLimited(request, env, "unlock", parseInt(env.RATE_LIMIT_PER_MIN || "10", 10)))
        return json({ error: "Too many attempts — try again in a minute" }, 429, cors);
      let u;
      try { u = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400, cors); }
      const code = u && typeof u.code === "string" ? u.code.trim() : "";
      if (!code) return json({ error: "Invalid code" }, 403, cors);
      if (env.PRO_UNLOCK && safeEqual(code, env.PRO_UNLOCK)) return json({ ok: true }, 200, cors);
      /* A transient store problem must NEVER read as "Invalid code" — the app
         permanently downgrades on that message. */
      if (!env.DB) return json({ error: "Temporarily unavailable" }, 503, cors);
      try {
        await ensureLicenseTable(env.DB);
        const row = await env.DB.prepare("SELECT revoked FROM license_keys WHERE key=?1").bind(code).first();
        if (row && !row.revoked) {
          await env.DB.prepare("UPDATE license_keys SET used_at=COALESCE(used_at, ?1), device_id=?2 WHERE key=?3")
            .bind(new Date().toISOString(), String(u.deviceId || "").slice(0, 64), code).run();
          return json({ ok: true }, 200, cors);
        }
      } catch (e) {
        return json({ error: "Temporarily unavailable" }, 503, cors);
      }
      return json({ error: "Invalid code" }, 403, cors);
    }

    /* ---- Shared learning pool ----
       POST /rules {rules:[{garbled,clean,hint}], appVer}
       Same Origin gate as the reader (already enforced above). Validate hard
       (<=25 rules, each field a string <=64 chars, control chars stripped),
       then UPSERT the aggregate. Nothing personal is stored and no body is ever
       logged. Best-effort by design: a DB error still answers {ok:true} so a
       sharing hiccup can never break a scan on the client. */
    if (path.endsWith("/rules")) {
      let u;
      try { u = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400, cors); }
      const list = u && Array.isArray(u.rules) ? u.rules : null;
      if (!list || list.length > 25) return json({ error: "Bad request" }, 400, cors);
      /* "" for a missing field (lenient); null for a wrong type or an
         over-long value (rejected). */
      const sane = s => {
        if (s == null) return "";
        if (typeof s !== "string") return null;
        let out = "";
        for (const ch of s) { const c = ch.charCodeAt(0); if (c > 31 && c !== 127 && (c < 128 || c > 159)) out += ch; }
        const t = out.trim();
        return t.length > 64 ? null : t;
      };
      const clean = [];
      for (const r of list) {
        if (!r || typeof r !== "object") return json({ error: "Bad request" }, 400, cors);
        const g = sane(r.garbled), c = sane(r.clean), h = sane(r.hint);
        if (g === null || c === null || h === null) return json({ error: "Bad request" }, 400, cors);
        if (g && c) clean.push({ garbled: g, clean: c, hint: h });   /* skip empty-core rows silently */
      }
      if (env.DB && clean.length) {
        try {
          await ensureRulesTable(env.DB);
          const week = isoYearWeek(new Date());
          const stmt = env.DB.prepare(
            "INSERT INTO shared_rules(garbled, clean, hint, week, seen) VALUES(?1,?2,?3,?4,1) " +
            "ON CONFLICT(garbled, clean, hint, week) DO UPDATE SET seen = seen + 1"
          );
          await env.DB.batch(clean.map(x => stmt.bind(x.garbled, x.clean, x.hint, week)));
        } catch (e) { /* sharing must never break the client */ }
      }
      return json({ ok: true }, 200, cors);
    }

    if (!env.GEMINI_API_KEY && !fallbackConfigured(env)) return json({ error: "Reader not configured" }, 500, cors);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400, cors); }
    const { image, mediaType, deviceId, turnstileToken } = body || {};
    /* Cap input size (base64). The app downscales to 1280px @ q0.8
       (~150-400KB); rejecting anything larger bounds the input-token cost and
       blocks oversized uploads from a direct caller. */
    if (!image || typeof image !== "string" || image.length > 2_500_000) {
      return json({ error: "Missing or oversized image" }, 400, cors);
    }

    if (env.TURNSTILE_SECRET) {
      const ok = await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, request.headers.get("CF-Connecting-IP"));
      if (!ok) return json({ error: "Couldn't verify you're human — reload and try again" }, 403, cors);
    }

    /* Quota keys: ALWAYS check/bump the Cloudflare edge IP (which the client
       cannot forge) as a hard backstop, in ADDITION to the caller's deviceId
       when present — not instead of it. This comment used to claim IP was
       "ALWAYS" the fallback, but the code only used it when deviceId was
       ABSENT, not when it was rotated: a script could send a freshly-random
       deviceId on every request and land in a brand-new zero-count bucket
       every time, evading both the rate limit and the daily cap entirely
       from one IP (found in Phase 13's full review, 2026-08-05 — the
       previous behavior contradicted this comment's own stated intent).
       A request is now blocked if EITHER key is over its cap; a successful
       read bumps both. */
    let quota = null; /* set only when a successful read should be counted */
    if (env.DB) {
      const ip = request.headers.get("CF-Connecting-IP") || "noip";
      const keys = ["ip:" + ip.slice(0, 64)];
      if (deviceId && typeof deviceId === "string" && deviceId.trim()) keys.push("d:" + deviceId.slice(0, 64));
      /* Rate limit first (cheap burst guard, checked before the cost-tracking
         daily cap): a device tripping this recovers within a minute, so it
         gets its own `code` — the app stays silent on this one rather than
         showing the daily "resumes tomorrow" notice for a transient block. */
      const rateCap = parseInt(env.RATE_LIMIT_PER_MIN || "10", 10);
      try {
        await ensureRateTable(env.DB);
        let blocked = false;
        for (const k of keys) { if (await rateLimited(env.DB, k, rateCap)) { blocked = true; break; } }
        if (blocked) return json({ error: "Reading too fast — reading on-device for a moment", code: "rate_limited" }, 429, cors);
        for (const k of keys) await bumpRate(env.DB, k);
      } catch (e) { /* rate table missing/erroring must not block reading */ }

      const cap = parseInt(env.DAILY_CAP || "30", 10);
      try {
        let overCap = false;
        for (const k of keys) { if (await quotaExceeded(env.DB, k, cap)) { overCap = true; break; } }
        if (overCap) return json({ error: "Daily limit reached — read on-device or enter it manually", code: "daily_cap" }, 429, cors);
        quota = { db: env.DB, ids: keys };
      } catch (e) { /* quota table missing/erroring must not block reading */ }
    }

    /* Provider chain: Gemini first, open-model failover second. Either can be
       absent; the app sees one consistent JSON shape or one clean error. */
    const mt = mediaType || "image/jpeg";
    let primary = { ok: false, msg: "Reader not configured" };
    if (env.GEMINI_API_KEY) {
      primary = await readWithGemini(env, image, mt);
      if (primary.ok) {
        if (quota) try { for (const k of quota.ids) await bumpQuota(quota.db, k); } catch (e) {}
        return json(primary.result, 200, cors);
      }
    }
    if (fallbackConfigured(env)) {
      const fb = await readWithFallback(env, image, mt);
      if (fb.ok) {
        if (quota) try { for (const k of quota.ids) await bumpQuota(quota.db, k); } catch (e) {}
        return json(fb.result, 200, cors);
      }
    }
    return json({ error: primary.msg }, 502, cors);
  }
};
