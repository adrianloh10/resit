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
 *   GEMINI_API_KEY     — required
 *   TURNSTILE_SECRET   — optional; if set, requests must carry a valid token
 * Vars (wrangler.toml): ALLOW_ORIGINS, DAILY_CAP, GEMINI_MODEL
 * Binding: DB (D1) — optional; if absent, quota is skipped.
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
  "Set readable=false if the image is not a receipt or is too unclear to read.";

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

async function checkAndBumpQuota(db, deviceId, cap) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare("SELECT count FROM device_quota WHERE device_id=?1 AND day=?2").bind(deviceId, day).first();
  const used = row ? row.count : 0;
  if (used >= cap) return false;
  await db.prepare(
    "INSERT INTO device_quota(device_id, day, count) VALUES(?1, ?2, 1) " +
    "ON CONFLICT(device_id, day) DO UPDATE SET count = count + 1"
  ).bind(deviceId, day).run();
  return true;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowList = (env.ALLOW_ORIGINS || "https://adrianloh10.github.io,http://localhost:8902")
      .split(",").map(s => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowList);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return json({ ok: true, service: "resit-relay" }, 200, cors);
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "Origin not allowed" }, 403, cors);
    if (!env.GEMINI_API_KEY) return json({ error: "Reader not configured" }, 500, cors);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400, cors); }
    const { image, mediaType, deviceId, turnstileToken } = body || {};
    if (!image || typeof image !== "string" || image.length > 6_000_000) {
      return json({ error: "Missing or oversized image" }, 400, cors);
    }

    if (env.TURNSTILE_SECRET) {
      const ok = await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, request.headers.get("CF-Connecting-IP"));
      if (!ok) return json({ error: "Couldn't verify you're human — reload and try again" }, 403, cors);
    }

    if (env.DB && deviceId && typeof deviceId === "string") {
      const cap = parseInt(env.DAILY_CAP || "20", 10);
      try {
        const allowed = await checkAndBumpQuota(env.DB, deviceId.slice(0, 64), cap);
        if (!allowed) return json({ error: "Daily limit reached — read on-device or enter it manually" }, 429, cors);
      } catch (e) { /* quota table missing/erroring must not block reading */ }
    }

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
                { inline_data: { mime_type: mediaType || "image/jpeg", data: image } },
                { text: "Extract the expense fields from this receipt." }
              ]
            }],
            generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 }
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
        return json({ error: msg }, 502, cors);
      }

      const data = await r.json();
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = parts && parts.find(p => typeof p.text === "string");
      if (!text) return json({ error: "No readable result" }, 502, cors);
      let result;
      try { result = JSON.parse(text.text); } catch (e) { return json({ error: "No readable result" }, 502, cors); }
      return json(result, 200, cors);
    } catch (err) {
      return json({ error: "Couldn't read the receipt" }, 502, cors);
    }
  }
};
