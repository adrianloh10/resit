/* Resit AI fallback relay — Vercel serverless function.
   Holds the Anthropic API key server-side (env var) so the public PWA
   never sees it. The app sends a receipt photo; Claude Haiku reads it
   and returns structured fields. Dependency-free: calls the Messages
   API over raw HTTPS. */

const CATEGORIES = ["Food", "Groceries", "Fuel", "Transport", "Shopping", "Bills", "Health", "Entertainment", "Other"];

const SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string", description: "Shop/vendor brand name, cleaned (no SDN BHD, no reg numbers)" },
    total: { anyOf: [{ type: "number" }, { type: "null" }], description: "Final amount paid in RM" },
    date: { anyOf: [{ type: "string" }, { type: "null" }], description: "Receipt date as YYYY-MM-DD, null if unreadable" },
    time: { anyOf: [{ type: "string" }, { type: "null" }], description: "Receipt time as HH:MM 24h, null if unreadable" },
    category: { type: "string", enum: CATEGORIES },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "number" }
        },
        required: ["name", "price"],
        additionalProperties: false
      }
    },
    readable: { type: "boolean", description: "false if the image is not a receipt or is unreadable" }
  },
  required: ["merchant", "total", "date", "time", "category", "items", "readable"],
  additionalProperties: false
};

const ALLOWED_ORIGINS = ["https://adrianloh10.github.io", "http://localhost:8902"];

function cors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { image, mediaType, secret } = req.body || {};
  if (!process.env.RESIT_SECRET || secret !== process.env.RESIT_SECRET) {
    return res.status(401).json({ error: "Wrong access code" });
  }
  if (!image || typeof image !== "string" || image.length > 6_000_000) {
    return res.status(400).json({ error: "Missing or oversized image" });
  }

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        system:
          "You read Malaysian receipts and invoices (printed or handwritten, English/Malay/Chinese). " +
          "Extract the fields exactly as specified by the schema. " +
          "total = the final amount the customer paid (after tax, service charge and rounding) in RM. " +
          "Invoice books often write ringgit and sen in separate columns: '2269 | 00' means 2269.00. " +
          "Dates may appear as dd/mm/yy, dd.mm.yy or dd MON yyyy - convert to YYYY-MM-DD, assuming 20xx for 2-digit years. " +
          "merchant = the shop's brand name, cleaned of corporate suffixes (SDN BHD, registration numbers). " +
          "Pick the category that best fits the merchant and items.",
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType || "image/jpeg", data: image }
            },
            { type: "text", text: "Extract the expense fields from this receipt." }
          ]
        }],
        output_config: { format: { type: "json_schema", schema: SCHEMA } }
      })
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.json().catch(() => ({}));
      const detail = errBody && errBody.error ? String(errBody.error.message || "") : "";
      const msg = apiRes.status === 401 ? "API key invalid - check ANTHROPIC_API_KEY in Vercel"
        : apiRes.status === 429 ? "Rate limited - try again in a minute"
        : /credit|billing/i.test(detail) ? "Out of API credit - top up at console.anthropic.com"
        : "AI reading failed";
      return res.status(502).json({ error: msg });
    }

    const data = await apiRes.json();
    const text = (data.content || []).find(b => b.type === "text");
    if (!text) return res.status(502).json({ error: "No readable result" });
    return res.status(200).json(JSON.parse(text.text));
  } catch (err) {
    return res.status(502).json({ error: "AI reading failed" });
  }
}
