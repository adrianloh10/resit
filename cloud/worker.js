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
 * Vars (wrangler.toml): ALLOW_ORIGINS, DAILY_CAP, GEMINI_MODEL,
 *   FALLBACK_URL, FALLBACK_MODEL (OpenAI-compatible provider serving an open
 *   vision model, e.g. DeepInfra/Together/OpenRouter + Qwen-VL).
 * Binding: DB (D1) — optional; if absent, quota is skipped.
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
  const model = env.GEMINI_MODEL || "gemini-flash-lite-latest";
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
            temperature: 0,
            /* Hard per-receipt cost caps: bound the output length and switch
               OFF the model's "thinking" tokens, so no single scan can run up
               a large bill. ~640 tokens covers a receipt with up to ~20 line
               items (fields + JSON syntax). */
            maxOutputTokens: 640,
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      }
    );
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      const detail = errBody && errBody.error ? String(errBody.error.message || "") : "";
      const msg = r.status === 401 || r.status === 403 ? "Reader key invalid"
        : r.status === 429 ? "Reader is busy — try again in a minute"
        : /quota|billing/i.test(detail) ? "Reader quota exhausted for today"
        : "Couldn't read the receipt";
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
    if (!r.ok) return { ok: false, msg: "Couldn't read the receipt" };
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowList = (env.ALLOW_ORIGINS || "https://adrianloh10.github.io,http://localhost:8902,https://localhost,http://localhost,capacitor://localhost,ionic://localhost")
      .split(",").map(s => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowList);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return json({ ok: true, service: "resit-relay" }, 200, cors);
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "Origin not allowed" }, 403, cors);

    /* ---- Pro licensing ----
       /unlock  {code, deviceId}      app redeems or re-verifies a key
       /mint    {secret, label}       owner creates a key (PRO_UNLOCK gates it)
       /revoke  {secret, code}        owner disables a key
       Keys live in the same D1 database; the table is created lazily so no
       manual migration is ever needed. The PRO_UNLOCK secret itself also still
       works as the owner's master code. */
    const path = new URL(request.url).pathname.replace(/\/+$/, "");

    if (path.endsWith("/unlock")) {
      let u;
      try { u = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400, cors); }
      const code = u && typeof u.code === "string" ? u.code.trim() : "";
      if (!code) return json({ error: "Invalid code" }, 403, cors);
      if (env.PRO_UNLOCK && code === env.PRO_UNLOCK) return json({ ok: true }, 200, cors);
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

    if (path.endsWith("/mint") || path.endsWith("/revoke")) {
      let u;
      try { u = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400, cors); }
      if (!env.PRO_UNLOCK || !u || u.secret !== env.PRO_UNLOCK) return json({ error: "Not allowed" }, 403, cors);
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

    let quota = null; /* set only when a successful read should be counted */
    if (env.DB && deviceId && typeof deviceId === "string") {
      const cap = parseInt(env.DAILY_CAP || "20", 10);
      try {
        if (await quotaExceeded(env.DB, deviceId.slice(0, 64), cap))
          return json({ error: "Daily limit reached — read on-device or enter it manually" }, 429, cors);
        quota = { db: env.DB, id: deviceId.slice(0, 64) };
      } catch (e) { /* quota table missing/erroring must not block reading */ }
    }

    /* Provider chain: Gemini first, open-model failover second. Either can be
       absent; the app sees one consistent JSON shape or one clean error. */
    const mt = mediaType || "image/jpeg";
    let primary = { ok: false, msg: "Reader not configured" };
    if (env.GEMINI_API_KEY) {
      primary = await readWithGemini(env, image, mt);
      if (primary.ok) {
        if (quota) try { await bumpQuota(quota.db, quota.id); } catch (e) {}
        return json(primary.result, 200, cors);
      }
    }
    if (fallbackConfigured(env)) {
      const fb = await readWithFallback(env, image, mt);
      if (fb.ok) {
        if (quota) try { await bumpQuota(quota.db, quota.id); } catch (e) {}
        return json(fb.result, 200, cors);
      }
    }
    return json({ error: primary.msg }, 502, cors);
  }
};
