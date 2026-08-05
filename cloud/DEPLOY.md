# Resit cloud reader — deploy guide

This turns on "snap a receipt → auto-filled" for **other people**, not just you.
Claude has written all the code (`worker.js`, `wrangler.toml`, `schema.sql`).
Your part is the account/key/click steps below — **no coding**, ~30 minutes,
and it costs **RM 0** (no card needed for the prototype).

There is **one** thing only you can do at the end: tell Claude your Worker URL
(or paste it into the app's Settings → Advanced → "Cloud reader URL"). Until
then the app just uses on-device reading and nothing changes.

> Heads-up: this prototype uses Gemini's **free tier**. Google may use free-tier
> submissions to improve its products, so keep this to **your own testing /
> trusted friends** for now. Before any real strangers use it, do the one paid
> step in "Going live" at the bottom.

---

## What you'll create (all free)
1. A **Cloudflare** account (runs the reader + the anonymous counter).
2. A **Google AI Studio** account (the actual receipt reader = Gemini).

---

## Step 1 — Get a Gemini API key (Google AI Studio)
1. Go to **https://aistudio.google.com** and sign in with your Google account.
2. Click **Get API key** → **Create API key**.
3. Copy the key (starts with `AIza...`). Keep it somewhere safe for Step 5.
   **Do not paste it into chat or commit it anywhere.**

## Step 2 — Create a Cloudflare account
1. Go to **https://dash.cloudflare.com/sign-up** and create a free account.
   No credit card required.

## Step 3 — Create the database (D1)
1. In the Cloudflare dashboard: **Storage & Databases → D1 SQL Database → Create**.
2. Name it exactly **`resit-quota`** and create it.
3. Open it and copy its **Database ID** (a long id on the database page).
4. Tell Claude that ID (it's not secret), or paste it yourself into
   `resit/cloud/wrangler.toml` replacing `PASTE_DATABASE_ID_AFTER_CREATING`,
   then commit + push.
5. In the D1 database's **Console** tab, paste the contents of
   `resit/cloud/schema.sql` and run it (creates the `device_quota` table).

## Step 4 — Deploy the Worker from GitHub (no Node needed)
1. Dashboard: **Workers & Pages → Create → Workers → Import a repository**
   (a.k.a. "Connect to Git").
2. Authorize GitHub and pick the **`adrianloh10/resit`** repo.
3. Set the **root directory** to `cloud` (so it uses `resit/cloud/wrangler.toml`).
4. Deploy. Cloudflare builds it in the cloud — your Windows PC needs nothing.

## Step 5 — Add the secret key
1. Open the new Worker → **Settings → Variables and Secrets**.
2. Add a **Secret** named **`GEMINI_API_KEY`** with the value from Step 1.
   (Add it as a *Secret*, not a plain variable, so it stays hidden.)
3. **Do NOT add `TURNSTILE_SECRET` yet** — the bot-check widget comes in a later
   phase; setting it now would block all reads.
4. Re-deploy (Cloudflare usually prompts to deploy after adding a secret).

## Step 6 — Hand the URL back
1. Copy your Worker URL — it looks like
   **`https://resit.<your-subdomain>.workers.dev`** (matches `name = "resit"` in `wrangler.toml`).
2. Either:
   - **Tell Claude the URL** and it will bake it into the app (`CLOUD_OCR_URL`)
     so it's on for everyone, **or**
   - **Test it yourself first:** in the Resit app → Settings → Advanced →
     "Cloud reader URL", paste the URL, tap **Test connection** (should say
     "Connected — cloud reader is ready"). Then a new toggle **"Smarter receipt
     reading (cloud)"** appears in Settings; turn it on and snap a hard-to-read
     receipt.

That's the prototype — live, multi-user, RM 0/month.

## Shared learning pool (no personal data)
The Worker also pools anonymous reading rules so every device's reader improves.
Apps that opted into cloud reading + sharing `POST /rules` (at most weekly) the
`{garbled, clean, hint}` tokens they learned — never ids, amounts, dates, or
images; the Worker stores only `(garbled, clean, hint, week, seen_count)` in a
lazily-created `shared_rules` table. To review the pool for curation, run
`curl "https://resit.adrianloh10.workers.dev/rules/export?code=<PRO_UNLOCK>&weeks=2"`
(same master code as `/mint`; wrong code → `Invalid code`).

---

## Going live (later, before real strangers use it)
1. **Move Gemini to paid** so submissions are never used for training: in Google
   AI Studio / Google Cloud, enable billing on the project and add a card. This
   is the single most important step before a public launch.
2. Set a **budget alert** in Google Cloud and a usage alert in Cloudflare.
3. Ask Claude to add **Turnstile** (a one-tap human check) for stronger abuse
   protection — then you'll create a Turnstile widget, set `TURNSTILE_SECRET`,
   and Claude wires the widget into the app.

## Alternative: deploy from the command line (only if you prefer)
Requires installing Node.js once. Then, from `resit/cloud/`:
```
npm install -g wrangler
wrangler login
wrangler d1 create resit-quota          # paste the id into wrangler.toml
wrangler d1 execute resit-quota --remote --file=schema.sql
wrangler secret put GEMINI_API_KEY      # paste the key when prompted
wrangler deploy
```

## Costs
- Prototype: **RM 0** (Cloudflare Workers/D1 free, Gemini free band ~1,000
  reads/day shared, GitHub Pages free). No card.
- At real scale: only Gemini bills, ~US$0.0003–0.0004 per receipt; roughly
  RM 5–150/month at ~1,000 active users. Cloudflare stays free at that size.
