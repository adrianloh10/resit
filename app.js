/* Resit — snap receipts, track spending. All data stays on-device. */

const APP_VERSION = self.RESIT_VERSION || "v?"; /* set once in version.js; sw.js shares it */

const $ = id => document.getElementById(id);
/* sessionStorage can THROW when the user blocks site data — never let that
   brick startup or any flow; a failed read just behaves like "not set". */
function safeSession(op, key, val) {
  try {
    if (op === "get") return sessionStorage.getItem(key);
    if (op === "set") sessionStorage.setItem(key, val);
    if (op === "remove") sessionStorage.removeItem(key);
  } catch (e) { return null; }
  return null;
}
const CATS = window.ReceiptOCR.CATEGORIES;
const CAT_COLOR = Object.fromEntries(CATS.map(c => [c.name, c.color]));
/* Own-property check — a category string like "constructor" must not pull
   functions off Object.prototype through bare object lookups. */
const hasOwn = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const isRealCategory = c => typeof c === "string" && hasOwn(CAT_COLOR, c);

/* A second classification axis, independent of category: who the spend is for.
   Each gets its own earth-tone accent. Default for new/old expenses: Personal. */
const SCOPES = ["Personal", "Shared", "Company"];
const SCOPE_CLASS = { Personal: "scope-personal", Shared: "scope-shared", Company: "scope-company" };
const SCOPE_FILL = { Personal: "var(--teal)", Shared: "var(--gold)", Company: "var(--sienna-red)" };
const SCOPE_TAG = { Personal: "t-personal", Shared: "t-shared", Company: "t-company" };
const scopeOf = e => (e && SCOPES.includes(e.scope)) ? e.scope : "Personal";

/* Geometric line-art icons per category (stroke = currentColor). */
const CAT_ICONS = {
  Food: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 3v7a2.5 2.5 0 0 0 5 0V3M8.5 3v18"/><path d="M17 3c-1.6 2-2.2 4.6-2.2 7 0 2 .9 3.2 2.2 3.2V21"/></svg>`,
  Groceries: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="19.5" r="1.4"/><circle cx="16.5" cy="19.5" r="1.4"/><path d="M3 4h2l2.3 10a2 2 0 0 0 2 1.6h6.9a2 2 0 0 0 1.9-1.5L20 8H6"/></svg>`,
  Fuel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v16M4 21h10M6.5 6.5h5v4h-5z"/><path d="M13 10h2a1.5 1.5 0 0 1 1.5 1.5v5a1.25 1.25 0 0 0 2.5 0V9.8a2 2 0 0 0-.6-1.4L17 7"/></svg>`,
  Transport: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="13" rx="2.4"/><path d="M5 11h14M8.5 20l.8-3M15.5 20l-.8-3"/><circle cx="9" cy="14.2" r=".6"/><circle cx="15" cy="14.2" r=".6"/></svg>`,
  Shopping: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 8h11.2l-1 12a1.6 1.6 0 0 1-1.6 1.5H9a1.6 1.6 0 0 1-1.6-1.5z"/><path d="M9 10.5V7a3 3 0 0 1 6 0v3.5"/></svg>`,
  Bills: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/></svg>`,
  Health: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20S4.8 15.6 3 11.3A5 5 0 0 1 12 7a5 5 0 0 1 9 4.3C19.2 15.6 12 20 12 20z"/></svg>`,
  Entertainment: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4"/></svg>`,
  Other: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.6 12.6 20a1.8 1.8 0 0 1-2.6 0L3.6 13.6a1.8 1.8 0 0 1 0-2.6L11 3.6a1.8 1.8 0 0 1 1.3-.6H19a1.8 1.8 0 0 1 1.8 1.8v6.5c0 .5-.2 1-.6 1.3z"/><circle cx="15.5" cy="8.5" r="1.3"/></svg>`
};
const catIcon = c => hasOwn(CAT_ICONS, c) ? CAT_ICONS[c] : CAT_ICONS.Other;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let state = {
  view: "home",
  monthOffset: 0,
  expenses: [],
  budget: 3000,
  editing: null,
  ocrCancelled: false,
  merchantCats: {},
  merchantNames: {},
  totalHints: {},
  merchantScopes: {},
  catBudgets: {},
  currency: "RM",   /* display only — no conversion */
  recurring: [],    /* monthly expense templates */
  theme: "light",
  aiUrl: "",
  aiSecret: "",
  ghToken: "",
  deviceId: "",
  cloudConsent: "",  /* "", "yes", "no" — explicit opt-in for cloud reading */
  pro: false,        /* Pro entitlement (unlimited cloud reads) */
  ghProven: false,   /* ghToken verified against the private inbox repo */
  skipResults: [],   /* deleted-while-pending expenses whose results to discard */
  scanDay: "",       /* local "YYYY-MM-DD" the free scan counter belongs to */
  scanCount: 0,      /* scanned receipts used today (free tier: 1/day) */
  lastBackupAt: null,
  backupNudgeSnooze: "",
  licenseKey: "",
  lastKeyCheck: "",
  search: "",
  filterCat: "",
  scopeFilter: "",  /* "", "Personal", "Shared", "Company" */
  syncStatus: "",   /* "", "syncing", "ok", "auth", "offline" */
  lastSyncAt: null
};

/* ---------- Claude inbox (free — processed by Claude Code on the PC) ----------
   Every scanned receipt's photo is queued to the private resit-inbox repo.
   Claude reads them when it runs and writes results/; we poll, apply, and
   delete. Photos are named <photoId>__<expenseId>.jpg so results can be
   matched back to the saved expense. */

const GH_REPO = "adrianloh10/resit-inbox";

/* Public cloud receipt reader (Cloudflare Worker). Empty until deployed — when
   empty, the app simply uses on-device OCR only (nothing changes). After deploy
   (see resit/cloud/DEPLOY.md) paste the Worker URL here. A user-set "advanced"
   override URL in Settings takes precedence, so it can be tested before baking
   the URL in. */
const CLOUD_OCR_URL = "https://resit.adrianloh10.workers.dev";
function cloudEndpoint() { return (state.aiUrl && state.aiUrl.trim()) || CLOUD_OCR_URL; }

/* ---------- Freemium ----------
   Free = ONE scanned receipt per day. Scans 2-5 can be unlocked by watching a
   rewarded ad WHERE ADS EXIST (the native Android/iOS builds — a PWA cannot
   show rewarded ads, so on the web the option simply doesn't appear and free
   users go manual after scan 1). Beyond 5, or to skip ads entirely: Pro.
   Pro = unlimited scans (cloud reads still bounded by the Worker's daily cap).
   The native shell exposes window.ResitAds = { available(), showRewarded() }
   (AdMob rewarded video) — wired in Phase A; absent on the web.
   PAY_URL is the checkout link (Stripe / LemonSqueezy) — fill it after you set
   up a payment account; until then the upgrade button shows "coming soon". */
const FREE_SCANS_PER_DAY = 1;
const AD_SCANS_PER_DAY = 4;   /* scans 2-5, one rewarded ad each */
const PAY_URL = "";
const PRICE_LABEL = "RM 6.99 / month or RM 79 / year";
/* Local-time day key (toISOString would flip the day near midnight UTC+8). */
function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
/* Pro: paid entitlement — or a PROVEN owner install. ghProven is only set
   after the token successfully reads the owner's PRIVATE inbox repo (a random
   string gets 401, a stranger's own PAT gets 404), so pasting text into the
   token field cannot unlock Pro. */
function isPro() { return !!state.pro || !!state.ghProven; }
function scansToday() { return state.scanDay === todayKey() ? (state.scanCount || 0) : 0; }
function scanAllowed() { return isPro() || scansToday() < FREE_SCANS_PER_DAY; }
/* Rewarded-ad unlock: available only where the native shell provides ads and
   the user is inside the ad-unlockable band (scans 2-5). */
function adsAvailable() {
  try { return !!(window.ResitAds && window.ResitAds.available && window.ResitAds.available()); }
  catch (e) { return false; }
}
function adUnlockAvailable() {
  return !isPro() && adsAvailable() &&
    scansToday() >= FREE_SCANS_PER_DAY &&
    scansToday() < FREE_SCANS_PER_DAY + AD_SCANS_PER_DAY;
}
/* Show the rewarded ad; resolves true only when the reward was earned. */
async function watchAdForScan() {
  try {
    toast("Loading ad…");
    const earned = await window.ResitAds.showRewarded();
    return earned === true;
  } catch (e) { toast("Ad couldn't load — try again later"); return false; }
}
async function bumpScanUsed() {
  const k = todayKey();
  if (state.scanDay !== k) { state.scanDay = k; state.scanCount = 0; }
  state.scanCount = (state.scanCount || 0) + 1;
  await DB.setSetting("scanDay", state.scanDay);
  await DB.setSetting("scanCount", state.scanCount);
}

function showUpgrade(reason) {
  const ov = $("upgrade-overlay");
  if (!ov) return;
  const r = $("upgrade-reason"); if (r) r.textContent = reason || "";
  const p = $("upgrade-price"); if (p) p.textContent = PRICE_LABEL;
  ov.hidden = false;
}

/* Pilot entitlement: a code the owner gives paying users, verified server-side
   by the Worker (so the secret never ships in the public app). Cost is also
   bounded by the Worker's per-device daily cap, so a leaked code can't run up
   the bill. Replace with per-user license keys once a payment webhook exists. */
async function unlockPro() {
  const code = (prompt("Enter your unlock code") || "").trim();
  if (!code) return;
  const url = cloudEndpoint();
  if (!url) { toast("Cloud isn't set up yet"); return; }
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/unlock", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceId: state.deviceId })
    });
    if (res.ok) {
      state.pro = true;
      await DB.setSetting("pro", true);
      state.licenseKey = code;
      await DB.setSetting("licenseKey", code);
      const ov = $("upgrade-overlay"); if (ov) ov.hidden = true;
      renderPlan();
      toast("Pro unlocked — thank you!");
    } else {
      toast("That code didn't work");
    }
  } catch (e) { toast("Couldn't verify the code"); }
}

function renderPlan() {
  const status = $("plan-status");
  const btn = $("plan-btn");
  if (isPro()) {
    if (status) status.textContent = "Pro — unlimited receipt scans. Thank you!";
    if (btn) btn.hidden = true;
  } else {
    if (status) status.textContent = "Free — " + FREE_SCANS_PER_DAY + " scanned receipt per day (" +
      (scanAllowed() ? "available today" : "used today — manual entry until tomorrow") + "), unlimited manual entries. " +
      "Pro adds unlimited scans and claims tracking.";
    if (btn) { btn.hidden = false; btn.textContent = "Upgrade to Pro"; }
  }
}

function ghHeaders() {
  return { Authorization: "Bearer " + state.ghToken, Accept: "application/vnd.github+json" };
}

async function queuePhotoForClaude(expenseId, file) {
  if (!state.ghToken || !file) return;
  try {
    const b64 = await fileToJpegBase64(file, 1600);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await DB.addPhoto({ id, expenseId, b64, status: "queued", createdAt: new Date().toISOString() });
    syncInbox();
  } catch (e) { /* photo conversion failed — expense is still saved */ }
}

function setSyncStatus(s) {
  state.syncStatus = s;
  if (s === "ok") state.lastSyncAt = new Date().toISOString();
  renderSyncStatus();
}

function renderSyncStatus() {
  const el = $("sync-status");
  if (!el) return;
  if (!state.ghToken) { el.textContent = ""; return; }
  const when = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" }) : "";
  const map = {
    syncing: "Checking with Claude…",
    ok: "Synced" + (when ? " · " + when : ""),
    auth: "Reconnect needed — check your token",
    error: "Couldn't reach Claude — will retry",
    offline: "Offline — will retry when online",
    "": ""
  };
  el.textContent = map[state.syncStatus] || "";
  el.className = "sync-status" + (state.syncStatus === "auth" || state.syncStatus === "error" ? " bad" : "");
}

/* Cloud-reading opt-in row in Settings. Hidden entirely until a reader URL
   exists (so nothing about it shows before the backend is deployed). */
function renderCloudSetting() {
  const wrap = $("cloud-field");
  if (!wrap) return;
  if (!cloudEndpoint()) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const on = state.cloudConsent === "yes";
  const btn = $("cloud-toggle");
  const status = $("cloud-status");
  if (btn) btn.textContent = on ? "Turn off" : "Turn on";
  if (status) status.textContent = on
    ? "On — hard-to-read receipts are read in the cloud, then discarded."
    : "Off — everything stays on your phone.";
}

let inboxSyncing = false;
async function syncInbox() {
  if (!state.ghToken || inboxSyncing) return;
  if (!navigator.onLine) { setSyncStatus("offline"); return; }
  inboxSyncing = true;
  setSyncStatus("syncing");
  let result = "ok";
  try {
    const photos = await DB.getAllPhotos();
    for (const p of photos.filter(x => x.status === "queued")) {
      const res = await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/inbox/" + p.id + "__" + p.expenseId + ".jpg", {
        method: "PUT",
        headers: ghHeaders(),
        body: JSON.stringify({ message: "receipt " + p.id, content: p.b64 })
      });
      if (res.ok || res.status === 422) {
        p.status = "uploaded";
        delete p.b64;
        await DB.updatePhoto(p);
      } else {
        result = (res.status === 401 || res.status === 403) ? "auth" : "error";
        break;
      }
    }
    const fetchOk = await fetchClaudeResults();
    if (fetchOk === "auth") result = "auth";
    else if (fetchOk === false && result === "ok") result = "error";
    setSyncStatus(result);
  } catch (e) {
    /* Never report success on a thrown error — surface offline vs. a real fault. */
    setSyncStatus(navigator.onLine ? "error" : "offline");
  } finally {
    inboxSyncing = false;
  }
}

/* Settings "Check for Claude's updates" button + pull-to-refresh. */
async function manualSync() {
  if (!state.ghToken) { toast("Set up the Claude inbox first"); return; }
  if (!navigator.onLine) { toast("You're offline"); return; }
  state._lastApplied = 0;
  await syncInbox();
  if (state.syncStatus === "auth") toast("Couldn't connect — check your token");
  else if (state.syncStatus === "error") toast("Couldn't reach Claude — will retry shortly");
  else if (state.syncStatus === "offline") toast("You're offline");
  else if (!state._lastApplied) {
    /* fetchClaudeResults already toasts when it fills something; only speak up
       here when nothing was applied. */
    const waiting = state.expenses.filter(e => e.pending).length;
    toast("Up to date" + (waiting > 0 ? " — " + waiting + " still waiting for Claude" : ""));
  }
}

async function fetchClaudeResults() {
  const res = await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/results", { headers: ghHeaders() });
  if (res.status === 401 || res.status === 403) return "auth";
  if (!res.ok) return res.status === 404 ? true : false; /* 404 = no results dir yet, that's fine */
  const files = (await res.json()).filter(f => f.name.endsWith(".json"));
  let applied = 0;
  for (const f of files) {
    try {
      const fr = await fetch(f.url, { headers: ghHeaders() });
      if (!fr.ok) continue;
      const meta = await fr.json();
      const data = JSON.parse(decodeURIComponent(escape(atob(meta.content.replace(/\s/g, "")))));
      /* Only consume (delete) the result once it's actually applied. If it was
         skipped — e.g. that expense is open in the editor — leave it for the
         next sync so we don't drop Claude's data or the user's edit. */
      if (!(await applyClaudeResult(data))) continue;
      applied++;
      await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/results/" + f.name, {
        method: "DELETE",
        headers: ghHeaders(),
        body: JSON.stringify({ message: "applied " + f.name, sha: meta.sha })
      });
      if (data.photoId) { try { await DB.deletePhoto(data.photoId); } catch (e) {} }
    } catch (e) { /* skip malformed result */ }
  }
  state._lastApplied = applied;
  if (applied) {
    toast("Claude filled in " + applied + " receipt" + (applied > 1 ? "s" : ""));
    renderCurrent();
  }
  return true;
}

async function applyClaudeResult(data) {
  /* The user deleted this receipt while it was pending — consume the result
     without recreating the expense. */
  const skipKey = String(data.expenseId);
  if (state.skipResults.includes(skipKey)) {
    state.skipResults = state.skipResults.filter(k => k !== skipKey);
    DB.setSetting("skipResults", state.skipResults);
    return true;
  }
  /* Don't clobber an expense the user is editing right now — skip and retry
     on the next sync (the result file is left in place by the caller). */
  if (state.editing && data.expenseId != null && String(state.editing.id) === String(data.expenseId)) {
    return false;
  }
  let e = state.expenses.find(x => String(x.id) === String(data.expenseId));
  let created = false;
  /* Self-heal: if the pending expense is missing (storage hiccup, reinstall),
     recreate it from Claude's result — the uploaded photo means the data
     is never lost. */
  if (!e) {
    e = { amount: 0, merchant: "Receipt", category: "Other", scope: "Personal", date: new Date().toISOString(), items: [], note: "", pending: true, createdAt: new Date().toISOString() };
    created = true;
  }
  if (typeof data.total === "number" && data.total > 0 && data.total < 100000) {
    e.amount = Math.round(data.total * 100) / 100;
  }
  if (data.merchant && String(data.merchant).length >= 2) {
    const preferred = state.merchantNames[brandOf(normMerchant(data.merchant))];
    e.merchant = preferred || String(data.merchant).slice(0, 60);
  }
  if (isRealCategory(data.category)) e.category = data.category;
  if (data.date && /^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) {
    const t = /^\d{1,2}:\d{2}$/.test(String(data.time || "")) ? data.time : "12:00";
    const d = new Date(data.date + "T" + t);
    if (!isNaN(d) && d <= new Date() && d.getFullYear() >= 2015) e.date = d.toISOString();
  }
  if (Array.isArray(data.items)) {
    const items = data.items
      .filter(i => i && typeof i.name === "string" && typeof i.price === "number" && i.price > 0)
      .slice(0, 25)
      .map(i => ({ name: String(i.name).slice(0, 40), price: Math.round(i.price * 100) / 100 }));
    if (items.length) e.items = items;
  }
  e.pending = false;
  if (created) {
    e.id = await DB.addExpense(e);
    state.expenses.push(e);
  } else {
    await DB.updateExpense(e);
  }
  return true;
}

/* ---------- Theme ---------- */

const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  const resolved = state.theme === "auto" ? (darkMedia.matches ? "dark" : "light") : state.theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved === "dark" ? "dark" : "only light";
  const mt = $("meta-theme");
  if (mt) mt.setAttribute("content", resolved === "dark" ? "#221B12" : "#F4EDDE");
  const ms = $("meta-scheme");
  if (ms) ms.setAttribute("content", resolved === "dark" ? "dark" : "only light");
}

function renderThemeChips() {
  const row = $("theme-chips");
  row.innerHTML = "";
  for (const t of ["auto", "light", "dark"]) {
    const b = document.createElement("button");
    const sel = state.theme === t;
    b.className = "chip" + (sel ? " selected" : "");
    b.textContent = t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark";
    b.addEventListener("click", async () => {
      state.theme = t;
      await DB.setSetting("theme", t);
      applyTheme();
      renderThemeChips();
    });
    row.appendChild(b);
  }
}

function renderCatBudgets() {
  const wrap = $("cat-budgets");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const c of CATS) {
    const row = document.createElement("label");
    row.className = "cat-budget-row";
    const name = document.createElement("span");
    name.className = "cat-budget-name";
    name.innerHTML = `<span class="cat-dot" style="background:${c.color}"></span>${c.name}`;
    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "decimal";
    input.min = "0";
    input.step = "10";
    input.placeholder = "—";
    input.className = "cat-budget-input";
    input.value = state.catBudgets[c.name] || "";
    input.addEventListener("change", async () => {
      const v = parseFloat(input.value) || 0;
      if (v > 0) state.catBudgets[c.name] = v; else delete state.catBudgets[c.name];
      await DB.setSetting("catBudgets", state.catBudgets);
    });
    row.append(name, input);
    wrap.appendChild(row);
  }
}

/* ---------- Learned merchant -> category memory ---------- */

function normMerchant(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/* Generic first words that don't identify a brand ("Restoran X" vs "Restoran Y"). */
const BRAND_STOPWORDS = new Set(["restoran", "restaurant", "kedai", "pasar", "pasaraya", "klinik", "clinic", "farmasi", "pharmacy", "stesen", "the", "cafe", "kafe", "warung", "gerai", "mr", "new", "old", "one"]);

function brandOf(norm) {
  for (const t of norm.split(" ")) {
    if (t.length >= 3 && !BRAND_STOPWORDS.has(t) && /[a-z]/.test(t)) return t;
  }
  return norm;
}

function learnedCategory(merchant) {
  const n = normMerchant(merchant);
  if (!n) return null;
  if (state.merchantCats[n]) return state.merchantCats[n];
  const brand = brandOf(n);
  for (const [k, v] of Object.entries(state.merchantCats)) {
    if (k.length >= 4 && (n.includes(k) || k.includes(n))) return v;
    if (brand.length >= 4 && brandOf(k) === brand) return v;
  }
  return null;
}

function rememberMerchantCategory(merchant, category) {
  const n = normMerchant(merchant);
  if (!n || !category) return;
  if (state.merchantCats[n] === category) return;
  state.merchantCats[n] = category;
  DB.setSetting("merchantCats", state.merchantCats);
}

/* Learn merchant -> Personal/Shared/Company. Applied (Pro) after the same
   scope is saved twice in a row for a brand. */
function rememberMerchantScope(merchant, scope) {
  const b = brandOf(normMerchant(merchant));
  if (!b || b.length < 3 || !SCOPES.includes(scope)) return;
  const cur = state.merchantScopes[b];
  state.merchantScopes[b] = cur && cur.scope === scope ? { scope, n: cur.n + 1 } : { scope, n: 1 };
  DB.setSetting("merchantScopes", state.merchantScopes);
}

function scopeRuleFor(merchant) {
  const rule = state.merchantScopes[brandOf(normMerchant(merchant || ""))];
  return rule && rule.n >= 2 && SCOPES.includes(rule.scope) ? rule.scope : null;
}

/* Everything the app has learned, shown in Settings so it can be unlearned. */
function renderRules() {
  const wrap = $("rules-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  const add = (key, text, map, setting) => {
    const row = document.createElement("div");
    row.className = "rule-row";
    const span = document.createElement("span");
    span.textContent = text;
    const x = document.createElement("button");
    x.className = "item-del";
    x.textContent = "✕";
    x.setAttribute("aria-label", "Forget this rule");
    x.addEventListener("click", async () => { delete map[key]; await DB.setSetting(setting, map); renderRules(); });
    row.append(span, x);
    wrap.appendChild(row);
  };
  for (const [k, v] of Object.entries(state.merchantCats)) add(k, k + " → " + v, state.merchantCats, "merchantCats");
  for (const [k, v] of Object.entries(state.merchantScopes)) { if (v.n >= 2) add(k, k + " → " + v.scope, state.merchantScopes, "merchantScopes"); }
  for (const [k, v] of Object.entries(state.merchantNames)) add(k, k + " → “" + v + "”", state.merchantNames, "merchantNames");
  if (!wrap.children.length) {
    const p = document.createElement("p");
    p.className = "settings-sub";
    p.textContent = "Nothing learned yet — rules appear as you save and correct expenses.";
    wrap.appendChild(p);
  }
}

/* ---------- Learning from corrections ----------
   When a scanned field is corrected before saving, remember the lesson:
   - the name you prefer for this shop
   - which line of this shop's receipts carries the real total */

function learnFromCorrections(e, record) {
  if (!e.fromReceipt) return;
  const parsedBrand = brandOf(normMerchant(e._parsedMerchant || ""));
  if (parsedBrand.length >= 3 && record.merchant && record.merchant !== e._parsedMerchant) {
    state.merchantNames[parsedBrand] = record.merchant;
    DB.setSetting("merchantNames", state.merchantNames);
  }
  if (e._rawText && record.amount > 0 && Math.abs((e._parsedTotal || 0) - record.amount) > 0.005) {
    const f = record.amount.toFixed(2);
    const variants = [f, f.replace(".", " "), f.replace(".", ","), f.replace(/\.00$/, "")];
    let hintLine = null;
    for (const line of e._rawText.split("\n")) {
      if (variants.some(v => v && line.includes(v))) { hintLine = line; break; }
    }
    if (hintLine && parsedBrand.length >= 3) {
      const kw = (hintLine.match(/[A-Za-z][A-Za-z .]{3,24}/) || [""])[0].trim().toLowerCase();
      if (kw.length >= 4) {
        state.totalHints[parsedBrand] = kw;
        DB.setSetting("totalHints", state.totalHints);
        toast("Learned where " + (record.merchant || "this shop") + " prints its total");
      }
    }
  }
}

function applyLearnedTotalHint(parsed) {
  const brand = brandOf(normMerchant(parsed.merchant || ""));
  const hint = state.totalHints[brand];
  if (!hint || !parsed.rawText) return;
  const line = parsed.rawText.split("\n").find(l => l.toLowerCase().includes(hint));
  if (!line) return;
  const amt = window.ReceiptOCR.amountFromLine(line);
  if (amt && (parsed.total === null || (parsed.totalConf || 0) <= 1)) {
    parsed.total = amt;
  }
}

function viewedMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + state.monthOffset, 1);
}

/* Amounts always carry the display currency (second arg kept for old call
   sites; it no longer changes anything). */
function fmtRM(n, _withSign) {
  const s = (Math.round(n * 100) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return state.currency + " " + s;
}

/* Timezone-safe "YYYY-MM" for a LOCAL date (toISOString would shift near midnight). */
function monthKeyOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

/* Monthly expense templates: catch up any months due since each template's
   lastMonth, one entry per month on the template's day (clamped to the month). */
async function materializeRecurring() {
  try {
    if (!state.recurring.length) return;
    const now = new Date();
    const curKey = monthKeyOf(now);
    let added = 0, changed = false;
    for (const t of state.recurring) {
      let guard = 0;
      while (t.lastMonth < curKey && guard++ < 6) {
        const [y, mo] = t.lastMonth.split("-").map(Number); /* mo is 1-based */
        const nxt = new Date(y, mo, 1); /* first day of the following month */
        const dim = new Date(nxt.getFullYear(), nxt.getMonth() + 1, 0).getDate();
        const when = new Date(nxt.getFullYear(), nxt.getMonth(), Math.min(t.day || 1, dim), 9, 0);
        if (when > now) break; /* this month's day hasn't arrived yet */
        const rec = {
          amount: t.amount, merchant: t.merchant, category: t.category,
          scope: t.scope || "Personal",
          claimStatus: t.scope === "Company" ? "to-claim" : "",
          date: when.toISOString(), items: [], note: t.note || "",
          pending: false, recurringAuto: true, createdAt: new Date().toISOString()
        };
        rec.id = await DB.addExpense(rec);
        state.expenses.push(rec);
        t.lastMonth = monthKeyOf(nxt);
        /* Persist immediately — if the app dies mid-loop, the entry that was
           just added must not be re-added on the next launch. */
        await DB.setSetting("recurringTemplates", state.recurring);
        changed = true; added++;
      }
    }
    if (added) {
      renderCurrent();
      toast("Added " + added + " monthly expense" + (added > 1 ? "s" : ""));
    }
  } catch (e) { /* never block startup on this */ }
}

function renderRecurringList() {
  const wrap = $("recurring-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  state.recurring.forEach((t, idx) => {
    const row = document.createElement("div");
    row.className = "rule-row";
    const span = document.createElement("span");
    span.textContent = t.merchant + " · " + fmtRM(t.amount, true) + " · day " + (t.day || 1);
    const x = document.createElement("button");
    x.className = "item-del";
    x.textContent = "✕";
    x.setAttribute("aria-label", "Stop repeating");
    x.addEventListener("click", async () => {
      state.recurring.splice(idx, 1);
      await DB.setSetting("recurringTemplates", state.recurring);
      renderRecurringList();
      toast("Stopped — existing entries stay");
    });
    row.append(span, x);
    wrap.appendChild(row);
  });
  if (!state.recurring.length) {
    const p = document.createElement("p");
    p.className = "settings-sub";
    p.textContent = "None yet.";
    wrap.appendChild(p);
  }
}

/* If an action-toast (e.g. a pending undo-delete) is still waiting when a new
   toast arrives, commit its expiry work first so nothing is silently dropped. */
function flushToastAction() {
  const t = $("toast");
  if (t._onExpire) { const f = t._onExpire; t._onExpire = null; f(); }
}

function toast(msg) {
  const t = $("toast");
  flushToastAction();
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* Toast with a tappable action ("Deleted — Undo"). onExpire runs when the
   toast times out (or is displaced) without the action being tapped. */
function toastAction(msg, actionLabel, onAction, onExpire, ms) {
  const t = $("toast");
  flushToastAction();
  clearTimeout(t._timer);
  t.textContent = msg + " ";
  const b = document.createElement("button");
  b.className = "toast-action";
  b.textContent = actionLabel;
  t._onExpire = onExpire || null;
  b.addEventListener("click", () => {
    if (!t._onExpire && !onExpire) { /* already resolved */ }
    t._onExpire = null;
    clearTimeout(t._timer);
    t.hidden = true;
    onAction();
  });
  t.appendChild(b);
  t.hidden = false;
  t._timer = setTimeout(() => {
    t.hidden = true;
    flushToastAction();
  }, ms || 5000);
}

/* ---------- Rendering ---------- */

function monthExpenses() {
  const m = viewedMonth();
  return state.expenses
    .filter(e => { const d = new Date(e.date); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/* "RM X to claim" — outstanding Shared/Company money across ALL months (owed
   money doesn't reset monthly), with a per-month mark-claimed shortcut. */
function renderClaimLine() {
  const el = $("claim-line");
  if (!el) return;
  if (!isPro()) { el.hidden = true; return; } /* claims are Pro */
  const owed = state.expenses.filter(e => e.claimStatus === "to-claim" && !e.pending).reduce((s, e) => s + e.amount, 0);
  if (!(owed > 0)) { el.hidden = true; return; }
  $("claim-line-text").textContent = fmtRM(owed, true) + " to claim back";
  $("claim-mark-btn").hidden = !monthExpenses().some(e => e.claimStatus === "to-claim" && !e.pending);
  el.hidden = false;
}

function renderHome() {
  const m = viewedMonth();
  const now = new Date();
  const sameYear = m.getFullYear() === now.getFullYear();
  $("month-label").textContent = MONTH_NAMES[m.getMonth()] + (sameYear ? "" : " " + m.getFullYear());

  const allExps = monthExpenses();
  renderScopeFilter();

  /* The Personal/Shared/Company filter narrows everything below it, including
     the headline total. "" = All. */
  const scoped = state.scopeFilter ? allExps.filter(e => scopeOf(e) === state.scopeFilter) : allExps;
  const total = scoped.reduce((s, e) => s + e.amount, 0);
  const bare = fmtRM(total).slice(state.currency.length + 1);
  const [whole, cents] = bare.split(".");
  $("month-total").innerHTML = `<span class="cur-prefix">${escapeHtml(state.currency)}</span> ${whole}<span class="cents">.${cents}</span>`;

  /* Hero: REMAINING | TOTAL BUDGET columns + a status bar with the verdict
     written inside it ("You are ON TRACK" / "PACING HIGH" / "OVER BUDGET").
     With a type filter active, the bar shows that type's share instead. */
  const fill = $("budget-fill");
  const track = $("budget-track");
  const status = $("track-status");
  const cols = $("hero-cols");
  if (state.scopeFilter) {
    if (cols) cols.hidden = true;
    const monthTotal = allExps.reduce((s, e) => s + e.amount, 0);
    const share = monthTotal > 0 ? Math.round((total / monthTotal) * 100) : 0;
    if (track) track.hidden = false;
    fill.style.width = share + "%";
    fill.classList.remove("over");
    fill.style.background = SCOPE_FILL[state.scopeFilter];
    if (status) status.textContent = state.scopeFilter.toUpperCase() + " · " + share + "% OF MONTH";
  } else {
    fill.style.background = "";
    if (state.budget > 0) {
      if (cols) {
        cols.hidden = false;
        const left = state.budget - total;
        $("hero-remaining").textContent = left >= 0 ? fmtRM(left) : "−" + fmtRM(-left);
        $("hero-remaining-col").classList.toggle("neg", left < 0);
        $("hero-budget").textContent = state.currency + " " + state.budget.toLocaleString("en-MY");
      }
      if (track) track.hidden = false;
      const pct = Math.min(100, (total / state.budget) * 100);
      fill.style.width = pct + "%";
      fill.classList.toggle("over", total > state.budget);
      if (status) {
        /* Pacing verdicts only make sense for the CURRENT month; finished
           months get a past-tense verdict and future months a neutral one. */
        let label;
        if (state.monthOffset < 0) {
          label = total > state.budget ? "ENDED OVER BUDGET" : "ENDED UNDER BUDGET";
        } else if (state.monthOffset > 0) {
          label = "UPCOMING MONTH";
        } else {
          label = "You are ON TRACK";
          if (total > state.budget) label = "OVER BUDGET";
          else if (now.getDate() >= 3) {
            const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            if ((total / now.getDate()) * dim > state.budget) label = "PACING HIGH";
          }
        }
        status.textContent = label;
      }
    } else {
      if (cols) cols.hidden = true;
      if (track) track.hidden = true;
    }
  }
  renderClaimLine();

  /* Possible-duplicate detection: same merchant + amount + day. Flag all but
     the first in each group — non-destructive, just a visual hint. */
  const dupIds = new Set();
  const groups = {};
  for (const e of scoped) {
    if (!(e.amount > 0)) continue;
    const key = e.amount.toFixed(2) + "|" + (e.merchant || "").trim().toLowerCase() + "|" + new Date(e.date).toDateString();
    (groups[key] = groups[key] || []).push(e);
  }
  for (const arr of Object.values(groups)) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => new Date(a.createdAt || a.date) - new Date(b.createdAt || b.date));
    arr.slice(1).forEach(e => dupIds.add(e.id));
  }

  renderFilterChips(scoped);
  const unusualIds = computeUnusualIds();

  /* Search + category filter further narrow the (already scope-filtered) list. */
  const q = state.search.trim().toLowerCase();
  const matchesQuery = e =>
    (e.merchant || "").toLowerCase().includes(q) ||
    (e.note || "").toLowerCase().includes(q) ||
    (e.category || "").toLowerCase().includes(q) ||
    (e.items || []).some(i => (i.name || "").toLowerCase().includes(q));
  let exps = scoped;
  if (q) exps = exps.filter(matchesQuery);
  if (state.filterCat) exps = exps.filter(e => e.category === state.filterCat);

  /* When searching, also look OUTSIDE the viewed month so "that hardware shop
     from March" doesn't mean swiping month by month. */
  let others = [];
  if (q) {
    others = state.expenses.filter(e => {
      const d = new Date(e.date);
      return !(d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth());
    });
    if (state.scopeFilter) others = others.filter(e => scopeOf(e) === state.scopeFilter);
    if (state.filterCat) others = others.filter(e => e.category === state.filterCat);
    others = others.filter(matchesQuery)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 20);
  }

  const ledger = $("ledger");
  ledger.innerHTML = "";
  const empty = $("empty-note");
  if (!allExps.length && !others.length) {
    empty.hidden = false;
    /* First-run onboarding copy only when the app is truly empty; an empty
       other month just says so. */
    empty.innerHTML = state.expenses.length === 0
      ? "No expenses yet.<br>Tap the camera to snap your first receipt."
      : "Nothing in " + MONTH_NAMES[m.getMonth()] + (m.getFullYear() === now.getFullYear() ? "" : " " + m.getFullYear()) + ".";
  } else if (!exps.length && !others.length) {
    empty.hidden = false;
    empty.innerHTML = "No matches" + (q ? " for “" + escapeHtml(state.search.trim()) + "”" : "") + ".";
  } else {
    empty.hidden = true;
  }

  let lastDay = "";
  for (const e of exps) {
    const d = new Date(e.date);
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const label = document.createElement("p");
      label.className = "day-label";
      const today = new Date();
      const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
      let prefix = d.toDateString() === today.toDateString() ? "Today · "
        : d.toDateString() === yesterday.toDateString() ? "Yesterday · " : "";
      label.textContent = prefix + d.toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short" });
      ledger.appendChild(label);
    }
    const dup = dupIds.has(e.id) ? `<span class="dup-flag">duplicate?</span>` : "";
    const claim = !isPro() ? "" : e.claimStatus === "to-claim" ? `<span class="claim-pill to">to claim</span>`
      : e.claimStatus === "claimed" ? `<span class="claim-pill done">claimed ✓</span>` : "";
    const odd = unusualIds.has(e.id) ? `<span class="odd-pill">higher than usual</span>` : "";
    const camera = e.photo ? `<span class="has-photo" aria-hidden="true">▦ </span>` : "";
    const sc = scopeOf(e);
    /* "Category | TYPE" account tag, colour-coded. */
    const tag = `<span class="acct-tag ${SCOPE_TAG[sc]}">${escapeHtml(e.category)} | ${sc.toUpperCase()}</span>`;
    const amountHtml = e.pending
      ? `<span class="entry-amount waiting">waiting…</span>`
      : `<span class="entry-amount">${fmtRM(e.amount)}</span>`;
    /* A pending receipt older than a day is probably stuck — invite a manual fill. */
    const stale = e.pending && Date.now() - new Date(e.createdAt || e.date).getTime() > 86400000;
    const pending = e.pending ? `<span class="mut">${stale ? "still waiting — tap to fill it in yourself" : "waiting for Claude"}</span>` : "";
    const note = e.note ? `<span class="mut">${escapeHtml(e.note)}</span>` : "";
    const row = document.createElement("button");
    row.className = "entry";
    row.innerHTML = `
      <span class="cat-icon">${catIcon(e.category)}</span>
      <span class="entry-main">
        <span class="entry-merchant">${camera}<span class="merchant-name">${escapeHtml(e.merchant || "Expense")}</span></span>
        <span class="entry-cat">${tag}${claim}${odd}${dup}${pending}${note}</span>
      </span>
      ${amountHtml}`;
    row.addEventListener("click", () => openConfirmSheet(e));
    ledger.appendChild(row);
  }

  /* Matches from other months, with a month tag; tap opens the expense. */
  if (others.length) {
    const label = document.createElement("p");
    label.className = "day-label";
    label.textContent = "In other months";
    ledger.appendChild(label);
    for (const e of others) {
      const d = new Date(e.date);
      const sc = scopeOf(e);
      const row = document.createElement("button");
      row.className = "entry";
      row.innerHTML = `
        <span class="cat-icon">${catIcon(e.category)}</span>
        <span class="entry-main">
          <span class="entry-merchant"><span class="merchant-name">${escapeHtml(e.merchant || "Expense")}</span></span>
          <span class="entry-cat"><span class="acct-tag ${SCOPE_TAG[sc]}">${escapeHtml(e.category)} | ${sc.toUpperCase()}</span><span class="mut">${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}</span></span>
        </span>
        <span class="entry-amount">${fmtRM(e.amount)}</span>`;
      row.addEventListener("click", () => openConfirmSheet(e));
      ledger.appendChild(row);
    }
  }

  const pl = $("pending-line");
  if (pl) {
    const n = state.expenses.filter(e => e.pending).length;
    pl.hidden = n === 0;
    if (n > 0) pl.textContent = n + " receipt" + (n > 1 ? "s" : "") + " waiting for Claude — not yet in the total";
  }
}

function renderFilterChips(monthExps) {
  const row = $("filter-chips");
  if (!row) return;
  const present = [...new Set(monthExps.map(e => e.category))];
  const cats = CATS.filter(c => present.includes(c.name)).map(c => c.name);
  row.innerHTML = "";
  const mk = (label, value) => {
    const b = document.createElement("button");
    b.className = "chip small-chip" + (state.filterCat === value ? " selected" : "");
    b.textContent = label;
    b.addEventListener("click", () => { state.filterCat = state.filterCat === value ? "" : value; renderHome(); });
    row.appendChild(b);
  };
  if (state.filterCat) mk("All", "");
  for (const c of cats) mk(c, c);
}

/* Personal / Shared / Company filter pills — tap to filter the list and the
   headline total. */
function renderScopeFilter(targetId, rerender) {
  const row = $(targetId || "scope-filter");
  if (!row) return;
  const redo = rerender || renderHome;
  row.innerHTML = "";
  const mk = (label, value, cls) => {
    const b = document.createElement("button");
    b.className = "scope-chip " + cls + (state.scopeFilter === value ? " selected" : "");
    b.innerHTML = `<span class="scope-chip-name">${label}</span>`;
    b.addEventListener("click", () => { state.scopeFilter = (state.scopeFilter === value) ? "" : value; redo(); });
    row.appendChild(b);
  };
  mk("All", "", "scope-all");
  for (const s of SCOPES) mk(s, s, SCOPE_CLASS[s]);
}

function renderScopeChips() {
  const e = state.editing;
  if (!e) return;
  const chips = $("scope-chips");
  if (!chips) return;
  const cur = scopeOf(e);
  chips.innerHTML = "";
  for (const s of SCOPES) {
    const b = document.createElement("button");
    const sel = s === cur;
    b.className = "chip scope-opt " + SCOPE_CLASS[s] + (sel ? " selected" : "");
    b.textContent = s;
    b.addEventListener("click", () => {
      state.editing.scope = s;
      state.editing.userPickedScope = true; /* manual choice beats auto-rules */
      /* New Company expenses default to "to claim" (Pro); Personal never claims. */
      if (isPro() && s === "Company" && !state.editing.id && !state.editing.claimStatus) state.editing.claimStatus = "to-claim";
      renderScopeChips();
      renderClaimChips();
    });
    chips.appendChild(b);
  }
}

/* Claim status picker — only meaningful for Shared/Company expenses. */
function renderClaimChips() {
  const e = state.editing;
  const label = $("claim-label"), row = $("claim-chips");
  if (!label || !row) return;
  /* Claims are a Pro feature (and only meaningful for Shared/Company). */
  const show = !!e && scopeOf(e) !== "Personal" && isPro();
  label.hidden = !show;
  row.hidden = !show;
  /* Don't wipe claimStatus here — toggling scope back and forth must not
     destroy it; saveExpense clears it for Personal at save time. */
  if (!show) return;
  row.innerHTML = "";
  const cur = e.claimStatus || "";
  for (const [val, lbl] of [["", "Not a claim"], ["to-claim", "To claim"], ["claimed", "Claimed"]]) {
    const b = document.createElement("button");
    b.className = "chip" + (cur === val ? " selected" : "");
    b.textContent = lbl;
    b.addEventListener("click", () => { e.claimStatus = val; renderClaimChips(); });
    row.appendChild(b);
  }
}

/* Recurring-charge radar (Pro, fully on-device): a brand with 3+ charges of
   similar amount (median ±15%) spaced roughly monthly (median gap 21-40 days)
   is a subscription/regular. */
function detectRecurring() {
  const groups = {};
  for (const e of state.expenses) {
    if (e.pending || !(e.amount > 0)) continue;
    const b = brandOf(normMerchant(e.merchant));
    if (!b || b.length < 3) continue;
    (groups[b] = groups[b] || []).push(e);
  }
  const out = [];
  for (const [brand, list] of Object.entries(groups)) {
    if (list.length < 3) continue;
    list.sort((a, b) => new Date(a.date) - new Date(b.date));
    const amounts = list.map(e => e.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const similar = list.filter(e => Math.abs(e.amount - median) <= median * 0.15);
    if (similar.length < 3) continue;
    const gaps = [];
    for (let i = 1; i < similar.length; i++) gaps.push((new Date(similar[i].date) - new Date(similar[i - 1].date)) / 86400000);
    gaps.sort((a, b) => a - b);
    const mgap = gaps[Math.floor(gaps.length / 2)];
    if (mgap < 21 || mgap > 40) continue;
    const latest = similar[similar.length - 1];
    const prevAmt = similar[similar.length - 2].amount;
    out.push({ brand, merchant: latest.merchant, amount: latest.amount, count: similar.length, increased: latest.amount > prevAmt * 1.02, prevAmount: prevAmt });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/* Respects the Personal/Shared/Company filter so every insights aggregate
   (trend, YTD, chart) answers for the selected scope. */
function totalForMonth(year, monthIndex) {
  return state.expenses.reduce((s, e) => {
    if (state.scopeFilter && scopeOf(e) !== state.scopeFilter) return s;
    const d = new Date(e.date);
    return d.getFullYear() === year && d.getMonth() === monthIndex ? s + e.amount : s;
  }, 0);
}

function renderInsights() {
  const m = viewedMonth();
  const now = new Date();
  $("ins-month-label").textContent = MONTH_NAMES[m.getMonth()] + (m.getFullYear() === now.getFullYear() ? "" : " " + m.getFullYear());

  const allExps = monthExpenses();
  renderScopeFilter("ins-scope-filter", renderInsights);
  const exps = state.scopeFilter ? allExps.filter(e => scopeOf(e) === state.scopeFilter) : allExps;
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const body = $("insights-body");

  if (!exps.length) {
    body.innerHTML = `<p class="empty-note" style="margin-top:40px">Nothing ${state.scopeFilter ? "for " + state.scopeFilter : ""} this month yet.</p>`;
    return;
  }

  const byCat = {};
  for (const e of exps) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

  /* Top places grouped by BRAND (so OCR name variants of one shop merge),
     with visit counts and per-visit average. */
  const byBrand = {};
  for (const e of exps) {
    const b = brandOf(normMerchant(e.merchant)) || "unnamed";
    const g = byBrand[b] = byBrand[b] || { amt: 0, n: 0, name: e.merchant || "Unnamed", last: 0 };
    g.amt += e.amount; g.n++;
    const t = new Date(e.date).getTime();
    if (t >= g.last) { g.last = t; g.name = state.merchantNames[b] || e.merchant || "Unnamed"; }
  }
  const merchants = Object.values(byBrand).sort((a, b) => b.amt - a.amt).slice(0, 5);

  let html = `
    <div class="ins-total">
      <p class="big-amount" style="font-size:34px">${fmtRM(total)}</p>
    </div>`;

  /* Stacked Personal/Shared/Company strip (All view only). */
  if (!state.scopeFilter && total > 0) {
    const st = { Personal: 0, Shared: 0, Company: 0 };
    for (const e of exps) st[scopeOf(e)] += e.amount;
    const present = SCOPES.filter(s => st[s] > 0);
    if (present.length > 1) {
      html += `<div class="scope-strip">` + present.map(s =>
        `<i style="width:${(st[s] / total * 100).toFixed(1)}%;background:${SCOPE_FILL[s]}"></i>`).join("") + `</div>
        <p class="scope-strip-legend">` + present.map(s =>
        `<span class="${SCOPE_CLASS[s]}">${s} ${Math.round(st[s] / total * 100)}%</span>`).join(" · ") + `</p>`;
    }
  }

  /* Month-over-month + year-to-date */
  const prev = new Date(m.getFullYear(), m.getMonth() - 1, 1);
  const prevTotal = totalForMonth(prev.getFullYear(), prev.getMonth());
  let ytd = 0;
  for (let mi = 0; mi <= m.getMonth(); mi++) ytd += totalForMonth(m.getFullYear(), mi);
  let trend = "";
  if (prevTotal > 0) {
    const diff = total - prevTotal;
    const pct = Math.round(Math.abs(diff) / prevTotal * 100);
    const up = diff > 0;
    trend = `<span class="trend ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${pct}% vs ${MONTH_NAMES[prev.getMonth()].slice(0, 3)}</span>`;
  } else {
    trend = `<span class="trend flat">— no ${MONTH_NAMES[prev.getMonth()].slice(0, 3)} to compare</span>`;
  }
  html += `<div class="ins-trend-row">${trend}<span class="ytd">${m.getFullYear()} so far · ${fmtRM(ytd, true)}</span></div>`;

  /* Last 6 months mini chart, ending at the viewed month */
  const bars = [];
  let maxM = 0;
  for (let i = 5; i >= 0; i--) {
    const dd = new Date(m.getFullYear(), m.getMonth() - i, 1);
    const t = totalForMonth(dd.getFullYear(), dd.getMonth());
    bars.push({ label: MONTH_NAMES[dd.getMonth()].slice(0, 3), total: t, current: i === 0 });
    if (t > maxM) maxM = t;
  }
  html += `<p class="ins-section-label">Last 6 months</p><div class="trend-chart">`;
  for (const b of bars) {
    const h = maxM > 0 ? Math.max(3, Math.round(b.total / maxM * 64)) : 3;
    html += `<div class="trend-col">
      <span class="trend-val">${b.total > 0 ? Math.round(b.total).toLocaleString("en-MY") : ""}</span>
      <div class="trend-bar ${b.current ? "cur" : ""}" style="height:${h}px"></div>
      <span class="trend-lbl">${b.label}</span>
    </div>`;
  }
  html += `</div>`;

  /* Rhythm: a real month calendar — darker ink = more spent that day.
     Hover shows the amount (title); tapping shows it as a toast on phones. */
  const dim2 = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const perDay = Array(dim2 + 1).fill(0);
  for (const e of exps) perDay[new Date(e.date).getDate()] += e.amount;
  const maxDay = Math.max(...perDay);
  if (maxDay > 0) {
    const offset = (new Date(m.getFullYear(), m.getMonth(), 1).getDay() + 6) % 7; /* Monday-first */
    const mon3 = MONTH_NAMES[m.getMonth()].slice(0, 3);
    html += `<p class="ins-section-label">Monthly spend</p><div class="rhythm-grid">`;
    for (const h of ["M", "T", "W", "T", "F", "S", "S"]) html += `<span class="rh-head">${h}</span>`;
    for (let i = 0; i < offset; i++) html += `<span class="rh-day empty"></span>`;
    for (let d = 1; d <= dim2; d++) {
      const amt = perDay[d];
      const op = amt > 0 ? 0.10 + 0.80 * (amt / maxDay) : 0;
      const label = d + " " + mon3 + " · " + (amt > 0 ? fmtRM(amt) : "nothing spent");
      html += `<button type="button" class="rh-day${amt > 0 ? " spent" : ""}${op > 0.5 ? " deep" : ""}"` +
        ` style="--rh:${op.toFixed(2)}" title="${label}" data-label="${label}"><i>${d}</i></button>`;
    }
    html += `</div>`;
    let we = 0, weDays = 0, wd = 0, wdDays = 0;
    for (let d = 1; d <= dim2; d++) {
      const dow = new Date(m.getFullYear(), m.getMonth(), d).getDay();
      if (dow === 0 || dow === 6) { we += perDay[d]; weDays++; } else { wd += perDay[d]; wdDays++; }
    }
    if (we > 0 && wd > 0) {
      const ratio = (we / weDays) / (wd / wdDays);
      if (ratio > 1.3) html += `<p class="rhythm-cap">Weekends run ~${ratio.toFixed(1)}× weekdays</p>`;
      else if (ratio < 0.7) html += `<p class="rhythm-cap">Weekdays run ~${(1 / ratio).toFixed(1)}× weekends</p>`;
    }
  }

  /* Subscriptions & regulars — Pro radar (teaser row for free users). */
  if (isPro()) {
    const rec = detectRecurring();
    if (rec.length) {
      const monthly = rec.reduce((s, r) => s + r.amount, 0);
      html += `<p class="ins-section-label">Subscriptions &amp; regulars · ~${fmtRM(monthly, true)}/mo</p>`;
      for (const r of rec.slice(0, 8)) {
        html += `<div class="ins-row"><span class="ins-row-name">↻ ${escapeHtml(r.merchant)}${r.increased ? ` <span class="recur-up">↑ was ${fmtRM(r.prevAmount)}</span>` : ""}</span><span class="ins-row-val">${fmtRM(r.amount)}/mo</span></div>`;
      }
    }
  } else {
    html += `<p class="ins-section-label">Subscriptions &amp; regulars</p>
      <div class="ins-row"><span class="ins-row-name" style="color:var(--muted)">Spot charges that repeat every month</span><button class="settings-link" id="ins-radar-upgrade">Pro</button></div>`;
  }

  html += `<p class="ins-section-label">By category</p>`;
  for (const [cat, amt] of cats) {
    const pct = Math.round((amt / total) * 100);
    const cb = state.catBudgets[cat];
    const over = cb > 0 && amt > cb;
    /* Current-month pace check: flag a category heading past its budget. */
    let paceOver = false;
    const isCurMonth = m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth();
    if (cb > 0 && !over && isCurMonth && now.getDate() >= 3) {
      const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      paceOver = (amt / now.getDate()) * dim > cb;
    }
    const budgetNote = cb > 0 ? `<span class="cat-budget ${over ? "over" : paceOver ? "pace" : ""}">${over ? "over " + fmtRM(amt - cb, true) : paceOver ? "on pace to pass " + fmtRM(cb, true) : fmtRM(cb - amt, true) + " left"}</span>` : "";
    html += `
      <div class="cat-bar-row">
        <div class="cat-bar-head">
          <span class="cat-bar-name">${escapeHtml(cat)} ${budgetNote}</span>
          <span class="cat-bar-amt">${fmtRM(amt)} · ${pct}%</span>
        </div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${over ? "var(--rust)" : (CAT_COLOR[cat] || CAT_COLOR.Other)}"></div></div>
      </div>`;
  }

  html += `<p class="ins-section-label">Top places</p>`;
  for (const g of merchants) {
    const detail = g.n > 1 ? ` <span class="ins-row-sub">· ${g.n}× · ~${fmtRM(g.amt / g.n, true)} each</span>` : "";
    html += `<div class="ins-row ins-merchant-row" data-name="${escapeHtml(g.name)}"><span class="ins-row-name">${escapeHtml(g.name)}${detail}</span><span class="ins-row-val">${fmtRM(g.amt)}</span></div>`;
  }

  /* Worth a look — entries far above this shop's/category's usual price. */
  const unusualIds = computeUnusualIds();
  const odd = exps.filter(e => unusualIds.has(e.id)).slice(0, 3);
  if (odd.length) {
    html += `<p class="ins-section-label">Worth a look</p>`;
    for (const e of odd) {
      html += `<div class="ins-row"><span class="ins-row-name">${escapeHtml(e.merchant || "Expense")} <span class="ins-row-sub">· higher than usual</span></span><span class="ins-row-val">${fmtRM(e.amount)}</span></div>`;
    }
  }

  html += `<div class="home-settings-row"><button class="settings-link" id="ins-statement">Monthly statement</button><button class="settings-link" id="open-settings">Settings</button></div>`;
  body.innerHTML = html;
  $("open-settings").addEventListener("click", () => switchView("settings"));
  const st = $("ins-statement");
  if (st) st.addEventListener("click", () => { if (isPro()) openStatement(m); else showUpgrade("Monthly statements are a Pro feature."); });
  const ru = $("ins-radar-upgrade");
  if (ru) ru.addEventListener("click", () => showUpgrade("The recurring-charge radar is a Pro feature."));
  /* Tap a rhythm day -> show that day's spend (phones have no hover). */
  for (const day of body.querySelectorAll(".rh-day[data-label]")) {
    day.addEventListener("click", () => toast(day.dataset.label));
  }
  /* Tap a top place -> home, pre-filtered to that shop. */
  for (const row of body.querySelectorAll(".ins-merchant-row")) {
    row.addEventListener("click", () => {
      state.search = row.dataset.name || "";
      switchView("home");
      const bar = $("search-bar"), si2 = $("search-input");
      if (bar) bar.hidden = false;
      if (si2) si2.value = state.search;
      renderHome();
    });
  }
}

/* Entries priced far (3×+) above this shop's usual — or, lacking shop
   history, the category's usual. Catches typos, misreads and real spikes. */
function computeUnusualIds() {
  const byBrandAmts = {}, byCatAmts = {};
  for (const e of state.expenses) {
    if (e.pending || !(e.amount > 0)) continue;
    const b = brandOf(normMerchant(e.merchant));
    if (b) (byBrandAmts[b] = byBrandAmts[b] || []).push(e.amount);
    (byCatAmts[e.category] = byCatAmts[e.category] || []).push(e.amount);
  }
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const ids = new Set();
  for (const e of state.expenses) {
    if (e.pending || !(e.amount > 0)) continue;
    const b = brandOf(normMerchant(e.merchant));
    const ref = b && byBrandAmts[b] && byBrandAmts[b].length >= 3 ? med(byBrandAmts[b])
      : byCatAmts[e.category] && byCatAmts[e.category].length >= 5 ? med(byCatAmts[e.category]) : null;
    if (ref !== null && ref > 0 && e.amount > ref * 3) ids.add(e.id);
  }
  return ids;
}

/* Printable, paper-styled statement for the viewed month — opens in a new tab
   and triggers the print dialog (share sheet -> save as PDF on the phone). */
function openStatement(m) {
  const exps = state.expenses.filter(e => { const d = new Date(e.date); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth() && !e.pending; });
  if (!exps.length) { toast("Nothing this month to report"); return; }
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const title = MONTH_NAMES[m.getMonth()] + " " + m.getFullYear();
  const st = { Personal: 0, Shared: 0, Company: 0 };
  const byCat = {}, byMer = {};
  let toClaim = 0;
  for (const e of exps) {
    st[scopeOf(e)] += e.amount;
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    const k = e.merchant || "Unnamed";
    (byMer[k] = byMer[k] || { amt: 0, n: 0 }); byMer[k].amt += e.amount; byMer[k].n++;
    if (e.claimStatus === "to-claim") toClaim += e.amount;
  }
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, a]) => {
    const cb = state.catBudgets[c];
    return `<tr><td>${escapeHtml(c)}</td><td class="num">${fmtRM(a)}</td><td class="num">${cb > 0 ? fmtRM(cb) : "—"}</td><td class="num">${cb > 0 ? (a > cb ? "+" + fmtRM(a - cb) : fmtRM(a - cb)) : ""}</td></tr>`;
  }).join("");
  const merRows = Object.entries(byMer).sort((a, b) => b[1].amt - a[1].amt).slice(0, 10).map(([n, v]) =>
    `<tr><td>${escapeHtml(n)}</td><td class="num">${v.n}×</td><td class="num">${fmtRM(v.amt)}</td></tr>`).join("");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Resit — ${title}</title><style>
    body{font-family:Georgia,serif;background:#F4EDDE;color:#2C2318;max-width:640px;margin:0 auto;padding:36px 28px}
    h1{font-size:21px;font-weight:normal;margin:0}
    .sub{color:#78705E;font-size:13px;margin:4px 0 22px}
    .big{font-family:Consolas,monospace;font-size:34px;margin:6px 0 2px}
    table{width:100%;border-collapse:collapse;margin:8px 0 22px;font-size:13px}
    th{ text-align:left;color:#78705E;font-weight:normal;border-bottom:1px solid #B6AE9E;padding:4px 6px}
    td{padding:5px 6px;border-bottom:0.5px solid #DFD7C6}
    .num{text-align:right;font-family:Consolas,monospace}
    .sect{color:#78705E;font-size:11px;letter-spacing:.08em;text-transform:uppercase;margin:24px 0 2px}
    .foot{color:#A99D88;font-size:11px;margin-top:30px;text-align:center}
    @media print{body{background:#fff}}
  </style></head><body>
    <h1>Resit — monthly statement</h1>
    <p class="sub">${title} · generated ${new Date().toLocaleDateString("en-MY")}</p>
    <p class="big">${fmtRM(total)}</p>
    <p class="sub">${exps.length} expenses · Personal ${fmtRM(st.Personal)} · Shared ${fmtRM(st.Shared)} · Company ${fmtRM(st.Company)}${toClaim > 0 ? " · still to claim " + fmtRM(toClaim) : ""}</p>
    <p class="sect">By category</p>
    <table><tr><th>Category</th><th class="num">Spent</th><th class="num">Budget</th><th class="num">±</th></tr>${catRows}</table>
    <p class="sect">Top places</p>
    <table><tr><th>Merchant</th><th class="num">Visits</th><th class="num">Total</th></tr>${merRows}</table>
    <p class="foot">Generated on-device by Resit — no data leaves your phone.</p>
    <script>setTimeout(function(){window.print()},400)<\/script>
  </body></html>`;
  const w = window.open("", "_blank");
  if (!w) { toast("Allow pop-ups to open the statement"); return; }
  w.document.write(html);
  w.document.close();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function switchView(name) {
  state.view = name;
  $("view-home").hidden = name !== "home";
  $("view-insights").hidden = name !== "insights";
  $("view-settings").hidden = name !== "settings";
  /* Left button is the Menu — always fully lit; only stats reflects the view. */
  $("nav-insights").classList.toggle("active", name === "insights");
  const ns = $("nav-settings");
  if (ns) ns.classList.toggle("active", name === "settings");
  if (name === "home") renderHome();
  if (name === "insights") renderInsights();
  if (name === "settings") {
    $("budget-input").value = state.budget || "";
    $("ai-url").value = state.aiUrl || "";
    $("ai-secret").value = state.aiSecret || "";
    $("gh-token").value = state.ghToken || "";
    renderThemeChips();
    renderSyncStatus();
    renderCatBudgets();
    renderCloudSetting();
    renderPlan();
    renderBackupStatus();
    renderRules();
    renderRecurringList();
    const cs = $("currency-select");
    if (cs) cs.value = state.currency;
    const bl = $("budget-label");
    if (bl) bl.textContent = "Monthly budget (" + state.currency + ")";
  }
  window.scrollTo(0, 0);
}

/* ---------- AI assist (optional relay fallback) ---------- */

/* Shared core: load a file, downscale to maxDim, return a JPEG data URL at the
   given quality (or null on decode failure). The two callers below differ only
   in quality and return shape. */
function loadScaledJpeg(file, maxDim, quality) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    } catch (e) { resolve(null); }
  });
}

function fileToJpegBase64(file, maxDim, quality) {
  return loadScaledJpeg(file, maxDim, quality || 0.85).then(u => {
    if (!u) throw new Error("Could not read image");
    return u.split(",")[1];
  });
}

/* Small on-device thumbnail (data URL) kept with the expense so the original
   receipt can be re-checked later. Stays on the phone; never uploaded, never
   in the backup file. */
function fileToThumb(file, maxDim) {
  return loadScaledJpeg(file, maxDim, 0.6);
}

/* Cloud reading: send the photo to the relay (Cloudflare Worker, or an old
   Vercel relay if an access code is set). Returns the same shape the on-device
   parser uses, so mergeAIResult() handles both. Nothing is stored server-side. */
async function cloudRead(file) {
  const url = cloudEndpoint();
  if (!url) return null;
  /* Token budget: 1280px @ q0.8 keeps thermal-print text readable while
     cutting the image-token cost well below the old 1568px upload. */
  const image = await fileToJpegBase64(file, 1280, 0.8);
  const payload = { image, mediaType: "image/jpeg", deviceId: state.deviceId };
  if (state.aiSecret) payload.secret = state.aiSecret; /* back-compat with the old relay */
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Cloud reading failed");
  }
  return res.json();
}

/* Explicit, one-time consent before any photo leaves the device (PDPA). The
   choice is remembered and can be changed in Settings. */
function ensureCloudConsent() {
  if (state.cloudConsent === "yes") return Promise.resolve(true);
  if (state.cloudConsent === "no") return Promise.resolve(false);
  return new Promise(resolve => {
    const ov = $("consent-overlay");
    const yes = $("consent-yes");
    const no = $("consent-no");
    if (!ov || !yes || !no) { resolve(false); return; }
    const finish = (val) => async () => {
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      ov.hidden = true;
      state.cloudConsent = val ? "yes" : "no";
      await DB.setSetting("cloudConsent", state.cloudConsent);
      resolve(val);
    };
    const onYes = finish(true);
    const onNo = finish(false);
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    ov.hidden = false;
  });
}

/* Merge the AI's reading over the on-device parse — the AI only runs when
   the on-device result was weak, so it wins where it answered. */
function mergeAIResult(parsed, ai) {
  if (!ai || ai.readable === false) return parsed;
  if (ai.total !== null && ai.total > 0 && ai.total < 100000) {
    parsed.total = Math.round(ai.total * 100) / 100;
    parsed.totalConf = 3;
  }
  if (ai.merchant && ai.merchant.length >= 2) parsed.merchant = ai.merchant;
  if (ai.category && CATS.some(c => c.name === ai.category)) parsed.category = ai.category;
  if (ai.date) {
    const m = String(ai.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (d <= new Date() && +m[1] >= 2015) {
        parsed.date = d;
        const t = String(ai.time || "").match(/^(\d{1,2}):(\d{2})$/);
        if (t && +t[1] <= 23 && +t[2] <= 59) parsed.time = { h: +t[1], min: +t[2] };
      }
    }
  }
  if (Array.isArray(ai.items) && ai.items.length) {
    const items = ai.items
      .filter(i => i && typeof i.name === "string" && typeof i.price === "number" && i.price > 0)
      .slice(0, 25)
      .map(i => ({ name: String(i.name).slice(0, 40), price: Math.round(i.price * 100) / 100 }));
    if (items.length) parsed.items = items;
  }
  parsed.fromAI = true;
  return parsed;
}

/* ---------- Capture flow ---------- */

/* Running inside the Capacitor native shell (Android/iOS app) vs a browser/PWA. */
function isNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
}

/* Native photo capture via the Capacitor Camera plugin; returns a File so it
   flows through the same handleImage() path as the web file inputs. */
async function captureNative(source) {
  try {
    const Cam = window.Capacitor.Plugins.Camera;
    const photo = await Cam.getPhoto({
      quality: 85,
      resultType: "base64",
      source: source === "camera" ? "CAMERA" : "PHOTOS",
      saveToGallery: false
    });
    if (!photo || !photo.base64String) return null;
    const bin = atob(photo.base64String);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], "receipt.jpg", { type: "image/jpeg" });
  } catch (e) {
    return null; /* user cancelled, or plugin unavailable */
  }
}

/* One entry point for both: native camera/gallery on the app, file inputs on web. */
async function pickImage(source) {
  $("chooser-overlay").hidden = true;
  if (isNative()) {
    const file = await captureNative(source);
    if (file) handleImage(file);
    else state._batchScope = null; /* cancelled — don't let a stale batch scope linger */
    return;
  }
  (source === "camera" ? $("camera-input") : $("gallery-input")).click();
}

/* Frequent manual spends (kopi, parking, tol) — the receipts-less half of
   Malaysian spending. Merchants logged 3+ times become one-tap chips. */
function computeFavourites() {
  const groups = {};
  for (const e of state.expenses) {
    if (e.pending || !(e.amount > 0)) continue;
    const n = normMerchant(e.merchant);
    if (!n || n === "receipt" || n === "expense") continue;
    (groups[n] = groups[n] || []).push(e);
  }
  return Object.values(groups)
    .filter(list => list.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
    .map(list => {
      const latest = list.reduce((m, e) => new Date(e.date) > new Date(m.date) ? e : m);
      /* Most frequent amount; ties go to the most recent. */
      const counts = {};
      for (const e of list) { const k = e.amount.toFixed(2); counts[k] = (counts[k] || 0) + 1; }
      const lk = latest.amount.toFixed(2);
      const amount = parseFloat(Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || ((b[0] === lk) ? 1 : 0) - ((a[0] === lk) ? 1 : 0))[0][0]);
      return { merchant: latest.merchant, amount, category: latest.category, scope: scopeOf(latest) };
    });
}

function renderQuickAdd() {
  const row = $("quickadd-row");
  const label = $("quickadd-label");
  if (!row || !label) return;
  const favs = computeFavourites();
  row.innerHTML = "";
  label.hidden = row.hidden = favs.length === 0;
  for (const f of favs) {
    const b = document.createElement("button");
    b.className = "chip quickadd-chip";
    b.textContent = f.merchant + " · " + fmtRM(f.amount, true);
    b.addEventListener("click", async () => {
      $("chooser-overlay").hidden = true;
      const record = {
        amount: f.amount, merchant: f.merchant, category: f.category, scope: f.scope,
        claimStatus: f.scope === "Company" ? "to-claim" : "",
        date: new Date().toISOString(), items: [], note: "", pending: false,
        createdAt: new Date().toISOString()
      };
      record.id = await DB.addExpense(record);
      state.expenses.push(record);
      state.monthOffset = 0;
      switchView("home");
      toastAction("Added " + f.merchant + " " + fmtRM(f.amount, true), "Undo", async () => {
        await DB.deleteExpense(record.id);
        state.expenses = state.expenses.filter(x => x.id !== record.id);
        renderCurrent();
      }, null);
    });
    row.appendChild(b);
  }
}

function openChooser() {
  renderQuickAdd();
  $("chooser-overlay").hidden = false;
}

/* Quick "who's this for?" picker shown right after a photo is taken, so the
   receipt is tagged Personal/Shared/Company before it's saved. Resolves to the
   chosen scope, or null if cancelled. */
function pickScope() {
  /* Batch capture ("Snap another"): reuse the last scope without re-asking. */
  if (state._batchScope) {
    const s = state._batchScope;
    state._batchScope = null;
    return Promise.resolve(s);
  }
  return new Promise(resolve => {
    const ov = $("scope-pick-overlay");
    if (!ov) { resolve("Personal"); return; }
    const wired = [];
    const cleanup = () => wired.forEach(([el, fn]) => el.removeEventListener("click", fn));
    const finish = val => { cleanup(); ov.hidden = true; resolve(val); };
    const bind = (id, val) => { const el = $(id); if (el) { const fn = () => finish(val); el.addEventListener("click", fn); wired.push([el, fn]); } };
    bind("scope-pick-personal", "Personal");
    bind("scope-pick-shared", "Shared");
    bind("scope-pick-company", "Company");
    bind("scope-pick-cancel", null);
    const backdrop = ev => { if (ev.target === ov) finish(null); };
    ov.addEventListener("click", backdrop); wired.push([ov, backdrop]);
    ov.hidden = false;
  });
}

async function handleImage(file) {
  if (!file) { state._batchScope = null; return; }
  /* Claude inbox mode: no on-device reading, no animation — save instantly
     as pending and let Claude fill in everything when it reviews the photo. */
  if (state.ghToken) {
    const scope = await pickScope();
    if (!scope) { toast("Photo discarded"); return; } /* cancelled — don't save */
    const thumb = await fileToThumb(file, 700);
    const record = {
      amount: 0,
      merchant: "Receipt",
      category: "Other",
      scope: scope,
      /* Company receipts are almost always claimed back — default them in. */
      claimStatus: scope === "Company" ? "to-claim" : "",
      date: new Date().toISOString(),
      items: [],
      note: "",
      pending: true,
      photo: thumb || undefined,
      createdAt: new Date().toISOString()
    };
    record.id = await DB.addExpense(record);
    state.expenses.push(record);
    queuePhotoForClaude(record.id, file);
    state.monthOffset = 0;
    switchView("home");
    /* Batch loop: one tap to snap the next receipt, reusing this scope. */
    toastAction("Saved — Claude will fill it in", "Snap another",
      () => { state._batchScope = scope; pickImage("camera"); }, null, 6000);
    return;
  }
  /* Free tier: one auto-read per day. Where rewarded ads exist (native app),
     scans 2-5 can each be unlocked by watching one; otherwise (and beyond 5)
     the photo still attaches but fields are manual — or go Pro. */
  if (!scanAllowed()) {
    if (adUnlockAvailable()) {
      const left = FREE_SCANS_PER_DAY + AD_SCANS_PER_DAY - scansToday();
      const wantsAd = confirm("Daily free scan used.\n\nWatch a short ad to scan this receipt? (" + left + " ad unlock" + (left > 1 ? "s" : "") + " left today)\n\nCancel = enter it manually.");
      if (wantsAd && await watchAdForScan()) {
        /* fall through to the normal scan path below */
      } else if (wantsAd) {
        return; /* ad failed — nothing consumed, let them retry */
      } else {
        const thumb0 = await fileToThumb(file, 700);
        openConfirmSheet({
          amount: null, merchant: "", category: "Other", scope: "Personal",
          date: new Date().toISOString(), items: [], note: "",
          photo: thumb0 || undefined, fromReceipt: false
        });
        return;
      }
    } else {
      const thumb = await fileToThumb(file, 700);
      toastAction("Daily free scan used — enter this one manually", "Go Pro",
        () => showUpgrade("Free includes " + FREE_SCANS_PER_DAY + " scanned receipt a day; Pro scans them all."), null, 5500);
      openConfirmSheet({
        amount: null, merchant: "", category: "Other", scope: "Personal",
        date: new Date().toISOString(), items: [], note: "",
        photo: thumb || undefined, fromReceipt: false
      });
      return;
    }
  }
  state.ocrCancelled = false;
  $("processing-overlay").hidden = false;
  $("processing-text").textContent = "Reading receipt…";
  $("processing-sub").textContent = "This happens on your phone";
  try {
    const parsed = await window.ReceiptOCR.scanReceipt(file, msg => { $("processing-text").textContent = msg; });
    if (state.ocrCancelled) return;
    DB.setSetting("lastScan", parsed.rawText || "");
    applyLearnedTotalHint(parsed);
    /* Cloud fallback: only when on-device reading came up empty or weak, the
       cloud reader is configured, and the user has opted in (asked once). */
    const weak = parsed.total === null || (parsed.totalConf || 0) <= 1;
    if (cloudEndpoint() && weak) {
      const consented = await ensureCloudConsent();
      if (state.ocrCancelled) return;
      if (consented) {
        $("processing-overlay").hidden = false;
        $("processing-text").textContent = "Reading with cloud…";
        $("processing-sub").textContent = "Read in memory by Google Gemini, never stored";
        try {
          const ai = await cloudRead(file);
          if (state.ocrCancelled) return;
          mergeAIResult(parsed, ai);
        } catch (err) {
          toast(err.message || "Cloud reading failed");
        }
      }
    }
    if (state.ocrCancelled) return;
    $("processing-overlay").hidden = true;
    if (!parsed.total && !parsed.merchant && !parsed.items.length) {
      toast(state.ghToken ? "Couldn't read it — save anyway, Claude will fill it in" : "Couldn't read that — try better lighting, or enter manually");
    }
    if (!isPro()) await bumpScanUsed(); /* the day's auto-read is consumed */
    const draft = parsedToDraft(parsed);
    draft._file = file;
    openConfirmSheet(draft);
  } catch (err) {
    if (state.ocrCancelled) return;
    $("processing-overlay").hidden = true;
    toast(err.message || "Something went wrong reading the receipt");
    openConfirmSheet(null);
  }
}

function parsedToDraft(parsed) {
  const d = parsed.date || new Date();
  if (parsed.time) d.setHours(parsed.time.h, parsed.time.min, 0, 0);
  else if (!parsed.date) { /* keep now */ }
  else { const now = new Date(); d.setHours(now.getHours(), now.getMinutes(), 0, 0); }
  const brand = brandOf(normMerchant(parsed.merchant || ""));
  const preferredName = state.merchantNames[brand];
  return {
    id: null,
    amount: parsed.total || null,
    merchant: preferredName || parsed.merchant || "",
    category: learnedCategory(preferredName || parsed.merchant) || parsed.category || "Other",
    _rawText: parsed.rawText,
    _parsedTotal: parsed.total,
    _parsedMerchant: parsed.merchant,
    date: d.toISOString(),
    items: parsed.items || [],
    note: "",
    fromReceipt: true
  };
}

/* ---------- Confirm sheet ---------- */

function openConfirmSheet(expense) {
  state.editing = expense ? { ...expense, items: (expense.items || []).map(i => ({ ...i })) } : {
    id: null, amount: null, merchant: "", category: "Other",
    date: new Date().toISOString(), items: [], note: "", fromReceipt: false
  };
  const e = state.editing;

  $("confirm-title").textContent = e.id ? "Edit expense" : (e.fromReceipt ? "Check & save" : "New expense");
  const cp = $("currency-prefix");
  if (cp) cp.textContent = state.currency;
  const rr = $("repeat-row");
  if (rr) { rr.hidden = !!e.id; const cb = $("confirm-repeat"); if (cb) cb.checked = false; }
  $("confirm-amount").value = e.amount != null ? e.amount.toFixed(2) : "";
  $("confirm-merchant").value = e.merchant;

  /* Autocomplete from the shops you already log (most frequent first). */
  const dl = $("merchant-list");
  if (dl) {
    const freq = {};
    for (const x of state.expenses) {
      const n = (x.merchant || "").trim();
      if (n && n !== "Receipt") freq[n] = (freq[n] || 0) + 1;
    }
    dl.innerHTML = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([n]) => `<option value="${escapeHtml(n)}">`).join("");
  }
  const d = new Date(e.date);
  $("confirm-date").value = d.toISOString().slice(0, 10);
  $("confirm-time").value = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  $("confirm-note").value = e.note || "";

  renderScopeChips();
  renderClaimChips();
  renderCategoryChips();
  renderPhotoBlock();
  renderItemsEditor();

  let del = $("delete-btn");
  if (del) del.remove();
  if (e.id) {
    del = document.createElement("button");
    del.id = "delete-btn";
    del.className = "delete-btn";
    del.textContent = "Delete expense";
    del.addEventListener("click", () => {
      /* Soft delete with undo: drop it from the list right away, but only
         commit the database delete when the undo window passes. */
      const victim = state.expenses.find(x => x.id === e.id);
      state.expenses = state.expenses.filter(x => x.id !== e.id);
      closeConfirmSheet(true);
      renderCurrent();
      toastAction("Deleted", "Undo",
        () => { if (victim) { state.expenses.push(victim); renderCurrent(); } },
        async () => {
          await DB.deleteExpense(e.id);
          /* A deleted pending receipt must stay deleted: discard its queued
             photo and remember to ignore any Claude result that arrives. */
          if (victim && victim.pending) {
            state.skipResults.push(String(e.id));
            DB.setSetting("skipResults", state.skipResults);
            try {
              const ph = (await DB.getAllPhotos()).find(p => String(p.expenseId) === String(e.id));
              if (ph) await DB.deletePhoto(ph.id);
            } catch (err) {}
          }
        });
    });
    $("save-btn").after(del);
  }

  $("confirm-overlay").hidden = false;
  state._sheetSnapshot = sheetFingerprint();
  if (!e.amount) setTimeout(() => $("confirm-amount").focus(), 50);
}

/* What the confirm sheet currently holds — used to detect unsaved edits. */
function sheetFingerprint() {
  const e = state.editing;
  return [
    $("confirm-amount").value, $("confirm-merchant").value,
    $("confirm-date").value, $("confirm-time").value, $("confirm-note").value,
    ($("confirm-repeat") && $("confirm-repeat").checked) ? "1" : "0",
    e ? e.category : "", e ? scopeOf(e) : "", e ? (e.claimStatus || "") : "", e ? JSON.stringify(e.items || []) : ""
  ].join("|");
}

function renderPhotoBlock() {
  const block = $("photo-block");
  if (!block) return;
  const e = state.editing;
  block.innerHTML = "";
  if (e && e.photo) {
    const img = document.createElement("img");
    img.className = "receipt-thumb";
    img.src = e.photo;
    img.alt = "Receipt photo — tap to enlarge";
    img.addEventListener("click", () => openPhoto(e.photo));
    block.appendChild(img);
  }
}

function openPhoto(src) {
  const ov = $("photo-overlay");
  const img = $("photo-full");
  if (!ov || !img) return;
  img.src = src;
  ov.hidden = false;
}

function renderItemsEditor() {
  const e = state.editing;
  const block = $("items-block");
  if (!block || !e) return;
  e.items = e.items || [];
  block.innerHTML = "";
  const label = document.createElement("p");
  label.className = "items-label";
  label.textContent = e.items.length ? "Items" : "Items (optional)";
  block.appendChild(label);
  e.items.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "item-edit-row";
    const name = document.createElement("input");
    name.className = "item-name-input";
    name.type = "text";
    name.value = it.name || "";
    name.placeholder = "Item";
    name.addEventListener("input", () => { e.items[idx].name = name.value; });
    const price = document.createElement("input");
    price.className = "item-price-input";
    price.type = "text";
    price.inputMode = "decimal";
    price.value = it.price != null && it.price !== 0 ? Number(it.price).toFixed(2) : "";
    price.placeholder = "0.00";
    price.addEventListener("input", () => { e.items[idx].price = parseFloat(price.value.replace(/[^\d.]/g, "")) || 0; });
    const del = document.createElement("button");
    del.className = "item-del";
    del.type = "button";
    del.textContent = "✕";
    del.setAttribute("aria-label", "Remove item");
    del.addEventListener("click", () => { e.items.splice(idx, 1); renderItemsEditor(); });
    row.append(name, price, del);
    block.appendChild(row);
  });
  const add = document.createElement("button");
  add.className = "add-item-btn";
  add.type = "button";
  add.textContent = "+ Add item";
  add.addEventListener("click", () => { e.items.push({ name: "", price: 0 }); renderItemsEditor(); });
  block.appendChild(add);
}

function renderCategoryChips() {
  const e = state.editing;
  if (!e) return;
  const chips = $("category-chips");
  chips.innerHTML = "";
  for (const c of CATS) {
    const b = document.createElement("button");
    const sel = c.name === e.category;
    b.className = "chip" + (sel ? " selected" : "");
    b.textContent = c.name;
    if (sel) { b.style.background = c.color; b.style.borderColor = c.color; }
    b.addEventListener("click", () => {
      state.editing.category = c.name;
      state.editing.userPicked = true;
      renderCategoryChips();
    });
    chips.appendChild(b);
  }
}

function closeConfirmSheet(force) {
  /* Don't silently discard typed-but-unsaved content on an accidental
     backdrop tap or X. Saves and deletes pass force=true. */
  if (!force && state.editing && state._sheetSnapshot !== undefined && sheetFingerprint() !== state._sheetSnapshot) {
    if (!confirm("Discard this expense's unsaved changes?")) return;
  }
  state._sheetSnapshot = undefined;
  $("confirm-overlay").hidden = true;
  state.editing = null;
}

async function saveExpense() {
  const e = state.editing;
  if (!e) return;
  const amount = parseFloat(($("confirm-amount").value || "").replace(/[^\d.]/g, ""));
  /* With the Claude inbox configured, a scanned receipt may be saved without
     an amount — Claude fills it in later. */
  const canPend = !!(!e.id && e.fromReceipt && e._file && state.ghToken);
  if (!(amount > 0) && !canPend) { toast("Enter an amount"); $("confirm-amount").focus(); return; }

  const dateStr = $("confirm-date").value;
  const timeStr = $("confirm-time").value || "12:00";
  const d = dateStr ? new Date(dateStr + "T" + timeStr) : new Date();

  let photo = e.photo;
  if (!photo && e._file) photo = await fileToThumb(e._file, 700);

  const record = {
    amount: amount > 0 ? Math.round(amount * 100) / 100 : 0,
    merchant: $("confirm-merchant").value.trim(),
    category: e.category || "Other",
    date: d.toISOString(),
    items: (e.items || []).filter(i => i && ((i.name && i.name.trim()) || i.price > 0))
      .map(i => ({ name: (i.name || "").trim(), price: Math.round((i.price || 0) * 100) / 100 })),
    note: $("confirm-note").value.trim(),
    scope: scopeOf(e),
    claimStatus: scopeOf(e) === "Personal" ? "" : (e.claimStatus || ""),
    pending: !(amount > 0) && canPend,
    photo: photo || undefined,
    createdAt: e.createdAt || new Date().toISOString()
  };

  if (e.id) {
    record.id = e.id;
    record.pending = !!(e.pending && !(amount > 0));
    await DB.updateExpense(record);
    const i = state.expenses.findIndex(x => x.id === e.id);
    if (i >= 0) state.expenses[i] = record;
  } else {
    record.id = await DB.addExpense(record);
    state.expenses.push(record);
  }

  if (!e.id && e._file && state.ghToken) {
    queuePhotoForClaude(record.id, e._file);
  }

  /* "Repeats every month": remember it as a template; future months are
     added automatically on this day. */
  const repeatCb = $("confirm-repeat");
  if (!e.id && repeatCb && repeatCb.checked && record.amount > 0 && record.merchant) {
    state.recurring.push({
      merchant: record.merchant, amount: record.amount, category: record.category,
      scope: scopeOf(record), day: d.getDate(), note: record.note,
      lastMonth: monthKeyOf(d)
    });
    await DB.setSetting("recurringTemplates", state.recurring);
  }

  rememberMerchantCategory(record.merchant, record.category);
  rememberMerchantScope(record.merchant, scopeOf(record));
  learnFromCorrections(e, record);

  closeConfirmSheet(true);
  const saved = new Date(record.date);
  const now = new Date();
  state.monthOffset = (saved.getFullYear() - now.getFullYear()) * 12 + (saved.getMonth() - now.getMonth());
  switchView("home");
  toast(record.pending ? "Saved — Claude will fill it in" : e.id ? "Updated" : "Saved " + fmtRM(record.amount, true));
}

function renderCurrent() {
  if (state.view === "home") renderHome();
  if (state.view === "insights") renderInsights();
}

/* Month navigation with a directional slide, used by buttons and swipes. */
function changeMonth(delta) {
  state.monthOffset += delta;
  const target = state.view === "insights" ? "insights-body" : "ledger";
  renderCurrent();
  const el = $(target);
  if (!el) return;
  el.classList.remove("month-anim-next", "month-anim-prev");
  void el.offsetWidth; /* restart the animation */
  el.classList.add(delta > 0 ? "month-anim-next" : "month-anim-prev");
}

/* ---------- Settings ---------- */

/* One source of truth for export columns — CSV and Excel both build from this,
   so adding a column (or guarding a value) happens once. Numbers are coerced
   defensively so a malformed restored record can never crash an export. */
function exportHeaders() {
  return ["Date", "Time", "Merchant", "Category", "Type", "Claim", "Amount (" + state.currency + ")", "Note", "Items"];
}

/* Expenses matching an optional export filter {from, to, scope, category, claim}. */
function filteredExpenses(f) {
  let list = [...state.expenses];
  if (f) {
    if (f.from) { const t = new Date(f.from + "T00:00:00"); list = list.filter(e => new Date(e.date) >= t); }
    if (f.to) { const t = new Date(f.to + "T23:59:59"); list = list.filter(e => new Date(e.date) <= t); }
    if (f.scope) list = list.filter(e => scopeOf(e) === f.scope);
    if (f.category) list = list.filter(e => e.category === f.category);
    /* Claim filters exclude still-pending receipts — their amount is 0 until
       Claude fills them in, so they must not appear on a claim report. */
    if (f.claim) list = list.filter(e => !e.pending && (e.claimStatus || "") === f.claim);
  }
  return list.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function expenseExportRecords(f) {
  return filteredExpenses(f)
    .map(e => {
      const d = new Date(e.date);
      const amount = Number(e.amount) || 0;
      return {
        date: d.toLocaleDateString("en-MY"),
        time: d.toTimeString().slice(0, 5),
        merchant: e.merchant || "",
        category: e.category || "",
        type: scopeOf(e),
        claim: e.claimStatus === "to-claim" ? "To claim" : e.claimStatus === "claimed" ? "Claimed" : "",
        amount,
        note: e.note || "",
        items: (e.items || []).map(i => `${(i && i.name) || ""} ${(Number(i && i.price) || 0).toFixed(2)}`.trim()).join("; ")
      };
    });
}

async function exportCSV(filter) {
  const recs = expenseExportRecords(filter);
  if (!recs.length) { toast("Nothing to export" + (filter ? " for those filters" : " yet")); return 0; }
  const rows = [exportHeaders()];
  for (const r of recs) rows.push([r.date, r.time, r.merchant, r.category, r.type, r.claim, r.amount.toFixed(2), r.note, r.items]);
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), "resit-expenses.csv");
  return recs.length;
}

/* Styled Excel export — dependency-free. An HTML table with Excel's XML
   namespace opens directly in Excel/Sheets with formatting intact. */
async function exportXLS(filter, baseName) {
  const recs = expenseExportRecords(filter);
  if (!recs.length) { toast("Nothing to export" + (filter ? " for those filters" : " yet")); return 0; }
  let body = "";
  let total = 0;
  for (const r of recs) {
    total += r.amount;
    body += `<tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.time)}</td>
      <td>${escapeHtml(r.merchant)}</td>
      <td>${escapeHtml(r.category)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.claim)}</td>
      <td style="mso-number-format:'0.00';text-align:right">${r.amount.toFixed(2)}</td>
      <td>${escapeHtml(r.note)}</td>
      <td>${escapeHtml(r.items)}</td>
    </tr>`;
  }
  const th = exportHeaders().map(h => `<th>${h}</th>`).join("");
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
  <head><meta charset="utf-8"><style>
    table{border-collapse:collapse;font-family:Calibri,sans-serif;font-size:11pt}
    th{background:#2B2722;color:#fff;font-weight:bold;padding:6px 10px;border:1px solid #999;text-align:left}
    td{padding:5px 10px;border:1px solid #ccc}
    tr.total td{font-weight:bold;background:#F2EDE3}
  </style></head>
  <body><table>
    <thead><tr>${th}</tr></thead>
    <tbody>${body}
      <tr class="total"><td colspan="6">Total (${recs.length} expenses)</td>
      <td style="mso-number-format:'0.00';text-align:right">${total.toFixed(2)}</td><td></td><td></td></tr>
    </tbody>
  </table></body></html>`;
  downloadBlob(new Blob(["﻿" + html], { type: "application/vnd.ms-excel;charset=utf-8" }), (baseName || "resit-expenses") + ".xls");
  return recs.length;
}

/* Full backup: everything needed to rebuild the app on a new phone. Secrets
   (GitHub token, AI code) and the cached scan/photos are deliberately left out
   so the file is safe to store and small. */
async function exportBackup() {
  const settingsAll = await DB.getAllSettings();
  /* Never export: secrets, the Pro entitlement (a shared backup file must not
     grant Pro), this device's identity, or transient counters. */
  const SKIP = new Set(["ghToken", "aiSecret", "lastScan", "pro", "deviceId", "lastBackupAt", "backupNudgeSnooze", "licenseKey", "lastKeyCheck", "ghProven", "skipResults"]);
  const settings = settingsAll.filter(s => s && s.key && !SKIP.has(s.key));
  const expenses = state.expenses.map(({ photo, ...rest }) => rest);
  const backup = { app: "resit", type: "backup", version: 1, exportedAt: new Date().toISOString(), expenses, settings };
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(backup)], { type: "application/json" }), "resit-backup-" + stamp + ".json");
  state.lastBackupAt = new Date().toISOString();
  await DB.setSetting("lastBackupAt", state.lastBackupAt);
  renderBackupStatus();
  toast("Backed up " + expenses.length + " expenses");
}

/* "Last backup: N days ago" in Settings + a gentle home nudge when backups
   are stale (20+ expenses and none in 30+ days). Dismissing snoozes 7 days. */
function daysSinceBackup() {
  if (!state.lastBackupAt) return null;
  return Math.floor((Date.now() - new Date(state.lastBackupAt).getTime()) / 86400000);
}

function backupIsStale() {
  if (state.expenses.length < 20) return false;
  const d = daysSinceBackup();
  return d === null || d >= 30;
}

function renderBackupStatus() {
  const el = $("backup-status");
  if (el) {
    const d = daysSinceBackup();
    el.textContent = d === null ? "Never backed up yet"
      : d === 0 ? "Backed up today"
      : "Last backup: " + d + " day" + (d > 1 ? "s" : "") + " ago";
    el.className = "sync-status" + (backupIsStale() ? " bad" : "");
  }
  const nudge = $("backup-nudge");
  if (nudge) {
    const snoozed = state.backupNudgeSnooze && Date.now() < new Date(state.backupNudgeSnooze).getTime();
    nudge.hidden = !(backupIsStale() && !snoozed);
    if (!nudge.hidden) {
      const d = daysSinceBackup();
      $("backup-nudge-text").textContent = d === null ? "Your expenses have never been backed up." : "Last backup was " + d + " days ago.";
    }
  }
}

/* Build a clean, storable expense from arbitrary backup JSON. Every field is
   coerced/defaulted so a put() can never throw, and ids are made unique so the
   restore transaction stays atomic (a bad record can't half-wipe the store). */
function sanitizeRestoredExpense(e, fallbackId) {
  e = e || {};
  const amount = Number(e.amount);
  const items = Array.isArray(e.items)
    ? e.items
        .filter(i => i && typeof i.name === "string" && Number.isFinite(Number(i.price)))
        .slice(0, 50)
        .map(i => ({ name: String(i.name).slice(0, 60), price: Math.round(Number(i.price) * 100) / 100 }))
    : [];
  const dateOk = e.date && !isNaN(new Date(e.date));
  return {
    id: Number.isInteger(e.id) ? e.id : fallbackId,
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0,
    merchant: e.merchant ? String(e.merchant).slice(0, 80) : "Expense",
    category: isRealCategory(e.category) ? e.category : "Other",
    scope: SCOPES.includes(e.scope) ? e.scope : "Personal",
    claimStatus: e.claimStatus === "to-claim" || e.claimStatus === "claimed" ? e.claimStatus : "",
    date: dateOk ? new Date(e.date).toISOString() : new Date().toISOString(),
    items,
    note: e.note ? String(e.note).slice(0, 200) : "",
    /* Photos aren't in backups, so a restored entry can't be Claude-filled —
       never leave it stuck "waiting"; restore it as a normal editable expense. */
    pending: false,
    createdAt: e.createdAt ? String(e.createdAt) : new Date().toISOString()
  };
}

async function importBackup(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { toast("That file isn't a valid backup"); return; }
  if (!data || data.app !== "resit" || !Array.isArray(data.expenses)) { toast("That doesn't look like a Resit backup"); return; }
  if (!confirm("Restore " + data.expenses.length + " expenses from this backup? It replaces everything currently in the app.")) return;

  /* Sanitize everything BEFORE touching storage, so we never clear the store
     and then fail mid-write. Assign ids above any existing one to avoid clashes. */
  let nextId = 1;
  for (const e of data.expenses) if (Number.isInteger(e && e.id) && e.id >= nextId) nextId = e.id + 1;
  const clean = data.expenses.map(e => sanitizeRestoredExpense(e, Number.isInteger(e && e.id) ? e.id : nextId++));

  try {
    await DB.replaceAllExpenses(clean);
    if (Array.isArray(data.settings)) {
      /* A backup file must never carry entitlement, secrets, or another
         device's identity into this install (old backups may contain them). */
      const REJECT = new Set(["pro", "deviceId", "ghToken", "aiSecret", "licenseKey", "lastKeyCheck", "ghProven", "skipResults"]);
      for (const s of data.settings) { if (s && s.key && !REJECT.has(s.key)) await DB.setSetting(s.key, s.value); }
    }
  } catch (err) {
    /* IndexedDB rolls the transaction back on error, so current data is intact. */
    toast("Restore failed — your current data is unchanged");
    return;
  }

  state.expenses = await DB.getAllExpenses();
  state.budget = await DB.getSetting("budget", 3000);
  state.merchantCats = await DB.getSetting("merchantCats", {});
  state.merchantNames = await DB.getSetting("merchantNames", {});
  state.totalHints = await DB.getSetting("totalHints", {});
  state.merchantScopes = await DB.getSetting("merchantScopes", {});
  state.catBudgets = await DB.getSetting("catBudgets", {});
  const rcur = await DB.getSetting("currency", "RM");
  state.currency = /^[A-Z]{2,4}$/.test(rcur) ? rcur : "RM";
  state.recurring = await DB.getSetting("recurringTemplates", []);
  state.cloudConsent = await DB.getSetting("cloudConsent", "");
  state.theme = await DB.getSetting("theme", "light");
  applyTheme();
  switchView("home");
  toast("Restored " + clean.length + " expenses");
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- Init ---------- */

async function init() {
  /* Storage must never blank the app: if loading fails (e.g. stale cached
     script vs upgraded DB), update the service worker and reload once. */
  try {
    state.budget = await DB.getSetting("budget", 3000);
    state.merchantCats = await DB.getSetting("merchantCats", {});
    state.merchantNames = await DB.getSetting("merchantNames", {});
    state.totalHints = await DB.getSetting("totalHints", {});
    state.merchantScopes = await DB.getSetting("merchantScopes", {});
    state.catBudgets = await DB.getSetting("catBudgets", {});
    /* Currency is injected into markup — only accept plain 2-4 letter codes. */
    const cur = await DB.getSetting("currency", "RM");
    state.currency = /^[A-Z]{2,4}$/.test(cur) ? cur : "RM";
    state.recurring = await DB.getSetting("recurringTemplates", []);
    state.ghProven = await DB.getSetting("ghProven", false);
    state.skipResults = await DB.getSetting("skipResults", []);
    state.theme = await DB.getSetting("theme", "light");
    state.aiUrl = await DB.getSetting("aiUrl", "");
    state.aiSecret = await DB.getSetting("aiSecret", "");
    state.ghToken = await DB.getSetting("ghToken", "");
    state.cloudConsent = await DB.getSetting("cloudConsent", "");
    state.deviceId = await DB.getSetting("deviceId", "");
    if (!state.deviceId) {
      state.deviceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      await DB.setSetting("deviceId", state.deviceId);
    }
    state.pro = await DB.getSetting("pro", false);
    state.scanDay = await DB.getSetting("scanDay", "");
    state.scanCount = await DB.getSetting("scanCount", 0);
    state.lastBackupAt = await DB.getSetting("lastBackupAt", null);
    state.backupNudgeSnooze = await DB.getSetting("backupNudgeSnooze", "");
    state.licenseKey = await DB.getSetting("licenseKey", "");
    state.lastKeyCheck = await DB.getSetting("lastKeyCheck", "");
    state.expenses = await DB.getAllExpenses();
    safeSession("remove", "dbRetry");
  } catch (err) {
    if (!safeSession("get", "dbRetry")) {
      safeSession("set", "dbRetry", "1");
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      } catch (e2) {}
      setTimeout(() => location.reload(), 600);
      return;
    }
    toast("Couldn't open storage — your data is safe; close and reopen the app");
  }
  applyTheme();
  darkMedia.addEventListener("change", () => { if (state.theme === "auto") applyTheme(); });
  renderHome();
  materializeRecurring(); /* add any monthly expenses that came due */

  /* Startup fade (quiet fade): the boot overlay in index.html has been
     playing while we loaded — keep it up ~0.9s total so the mark reads,
     then fade it away. Same-session reloads skip it entirely. */
  const boot = $("boot");
  if (boot) {
    safeSession("set", "resitBooted", "1");
    const wait = Math.max(0, 900 - (Date.now() - (window._bootStart || Date.now())));
    setTimeout(() => {
      boot.classList.add("done");
      setTimeout(() => boot.remove(), 500);
    }, wait);
  }

  /* Ask the browser to protect our storage from eviction under storage
     pressure — the single most important line for "your data stays safe". */
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  /* Weekly, silently re-verify a redeemed license key so a revoked key
     eventually downgrades. Network errors change nothing. */
  (async () => {
    if (!state.pro || !state.licenseKey || !navigator.onLine || !cloudEndpoint()) return;
    const last = state.lastKeyCheck ? new Date(state.lastKeyCheck).getTime() : 0;
    if (Date.now() - last < 7 * 86400000) return;
    try {
      const res = await fetch(cloudEndpoint().replace(/\/+$/, "") + "/unlock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: state.licenseKey, deviceId: state.deviceId })
      });
      if (res.status === 403) {
        /* Only a definitive "Invalid code" downgrades — any other 403/5xx is
           a server-side hiccup and must never cost a paying user their Pro. */
        const body = await res.json().catch(() => ({}));
        if (body && body.error === "Invalid code") {
          state.pro = false;
          await DB.setSetting("pro", false);
          renderPlan();
          toast("Your Pro key is no longer valid");
        }
      } else if (res.ok) {
        state.lastKeyCheck = new Date().toISOString();
        await DB.setSetting("lastKeyCheck", state.lastKeyCheck);
      }
    } catch (e) { /* offline/transient — keep current state */ }
  })();

  /* Silently (re)prove the inbox token so the owner install keeps Pro across
     the ghProven migration, and a revoked token loses it. */
  (async () => {
    if (!state.ghToken || !navigator.onLine) return;
    try {
      const res = await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/inbox", { headers: ghHeaders() });
      if (res.ok !== state.ghProven && (res.ok || res.status === 401 || res.status === 404)) {
        state.ghProven = res.ok;
        await DB.setSetting("ghProven", state.ghProven);
        renderPlan();
      }
    } catch (e) { /* offline — keep current state */ }
  })();

  /* Commit any pending undo-delete before the page goes away, so a quick
     app close can't resurrect a "deleted" expense. */
  window.addEventListener("pagehide", flushToastAction);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushToastAction();
  });

  renderBackupStatus();
  const nb = $("backup-nudge-btn");
  if (nb) nb.addEventListener("click", () => { switchView("settings"); });
  const nx = $("backup-nudge-close");
  if (nx) nx.addEventListener("click", async () => {
    state.backupNudgeSnooze = new Date(Date.now() + 7 * 86400000).toISOString();
    await DB.setSetting("backupNudgeSnooze", state.backupNudgeSnooze);
    renderBackupStatus();
  });

  $("month-prev").addEventListener("click", () => changeMonth(-1));
  $("month-next").addEventListener("click", () => changeMonth(1));
  $("ins-month-prev").addEventListener("click", () => changeMonth(-1));
  $("ins-month-next").addEventListener("click", () => changeMonth(1));

  /* on(): elements may be absent for one update cycle while the cached
     index.html lags behind app.js — never let wiring crash init. */
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };

  /* Left nav button = menu (Expenses / Search / Settings); right = stats,
     tapping it again returns home. */
  $("nav-home").addEventListener("click", () => { const ov = $("menu-overlay"); if (ov) ov.hidden = false; else switchView("home"); });
  $("nav-insights").addEventListener("click", () => switchView(state.view === "insights" ? "home" : "insights"));
  const closeMenu = () => { const ov = $("menu-overlay"); if (ov) ov.hidden = true; };
  on("menu-overlay", ev => { if (ev.target === $("menu-overlay")) closeMenu(); });
  on("menu-home", () => { closeMenu(); switchView("home"); });
  on("menu-settings", () => { closeMenu(); switchView("settings"); });
  on("menu-search", () => {
    closeMenu();
    switchView("home");
    const bar = $("search-bar");
    if (bar) {
      bar.hidden = false;
      setTimeout(() => { const i = $("search-input"); if (i) i.focus(); }, 30);
    }
  });
  on("nav-settings", () => switchView("settings"));
  on("open-settings-btn", () => switchView("settings"));
  on("ins-open-settings", () => switchView("settings"));
  $("settings-back").addEventListener("click", () => switchView("home"));

  /* Tap the month name to jump back to the current month. */
  on("month-label", () => { if (state.monthOffset !== 0) { state.monthOffset = 0; renderHome(); } });
  on("ins-month-label", () => { if (state.monthOffset !== 0) { state.monthOffset = 0; renderInsights(); } });

  /* Search bar toggle + live filter. */
  on("search-toggle", () => {
    const bar = $("search-bar");
    if (!bar) return;
    const show = bar.hidden;
    bar.hidden = !show;
    if (show) { setTimeout(() => { const i = $("search-input"); if (i) i.focus(); }, 30); }
    else { state.search = ""; const i = $("search-input"); if (i) i.value = ""; renderHome(); }
  });
  const si = $("search-input");
  if (si) si.addEventListener("input", () => { state.search = si.value; renderHome(); });

  /* Receipt photo lightbox — tap anywhere to close. */
  on("photo-overlay", () => { const ov = $("photo-overlay"); if (ov) ov.hidden = true; });

  /* Swipe left/right anywhere on home or insights to change month. */
  let swipe = null;
  document.addEventListener("touchstart", ev => {
    /* No month-swiping under ANY open overlay (confirm, chooser, consent,
       scope picker, upgrade, export, photo). */
    if (state.view === "settings" || document.querySelector(".overlay:not([hidden])")) { swipe = null; return; }
    const t = ev.changedTouches[0];
    swipe = { x: t.clientX, y: t.clientY, scroll: window.scrollY };
  }, { passive: true });
  document.addEventListener("touchend", ev => {
    if (!swipe) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    const startScroll = swipe.scroll;
    swipe = null;
    /* Pull down from the top of the home list to check with Claude. */
    if (state.view === "home" && startScroll <= 2 && dy > 90 && Math.abs(dy) > Math.abs(dx) * 2) {
      if (state.ghToken) manualSync();
      return;
    }
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
    if (state.view === "home" || state.view === "insights") changeMonth(dx < 0 ? 1 : -1);
  }, { passive: true });

  $("fab-camera").addEventListener("click", openChooser);
  $("choose-camera").addEventListener("click", () => pickImage("camera"));
  $("choose-gallery").addEventListener("click", () => pickImage("gallery"));
  $("choose-manual").addEventListener("click", () => { $("chooser-overlay").hidden = true; openConfirmSheet(null); });
  $("chooser-overlay").addEventListener("click", ev => { if (ev.target === $("chooser-overlay")) $("chooser-overlay").hidden = true; });

  $("camera-input").addEventListener("change", ev => { handleImage(ev.target.files[0]); ev.target.value = ""; });
  $("gallery-input").addEventListener("change", ev => { handleImage(ev.target.files[0]); ev.target.value = ""; });
  $("cancel-ocr").addEventListener("click", () => { state.ocrCancelled = true; $("processing-overlay").hidden = true; });

  $("confirm-merchant").addEventListener("input", () => {
    const e = state.editing;
    if (!e || e.id) return;
    const v = $("confirm-merchant").value;
    if (v.trim().length < 3) return;
    if (!e.userPicked) {
      const g = learnedCategory(v) || window.ReceiptOCR.guessCategory(v, v);
      if (g && g !== "Other" && g !== e.category) { e.category = g; renderCategoryChips(); }
    }
    /* Pro auto-rule: a brand tagged the same type twice pre-sets it here. */
    if (isPro() && !e.userPickedScope) {
      const rs = scopeRuleFor(v);
      if (rs && rs !== scopeOf(e)) {
        e.scope = rs;
        if (rs === "Company" && !e.claimStatus) e.claimStatus = "to-claim";
        if (rs === "Personal") e.claimStatus = "";
        renderScopeChips();
        renderClaimChips();
        toast("Type set to " + rs + " — learned from before");
      }
    }
  });

  $("confirm-back").addEventListener("click", () => closeConfirmSheet());
  $("confirm-overlay").addEventListener("click", ev => { if (ev.target === $("confirm-overlay")) closeConfirmSheet(); });
  $("save-btn").addEventListener("click", saveExpense);

  $("budget-input").addEventListener("change", async () => {
    const v = parseFloat($("budget-input").value) || 0;
    state.budget = v;
    await DB.setSetting("budget", v);
    toast("Budget saved");
  });
  const csel = $("currency-select");
  if (csel) csel.addEventListener("change", async () => {
    state.currency = csel.value || "RM";
    await DB.setSetting("currency", state.currency);
    const bl = $("budget-label");
    if (bl) bl.textContent = "Monthly budget (" + state.currency + ")";
    renderCurrent();
    toast("Showing amounts in " + state.currency);
  });
  $("export-csv").addEventListener("click", () => exportCSV());
  on("export-xls", () => exportXLS());

  /* Filtered export sheet + claim report */
  const expCat = $("exp-cat");
  if (expCat) for (const c of CATS) { const o = document.createElement("option"); o.value = c.name; o.textContent = c.name; expCat.appendChild(o); }
  const readExportFilter = () => ({
    from: $("exp-from").value, to: $("exp-to").value,
    scope: $("exp-scope").value, category: $("exp-cat").value, claim: $("exp-claim").value
  });
  on("export-filtered", () => { const ov = $("export-overlay"); if (ov) ov.hidden = false; });
  on("export-back", () => { $("export-overlay").hidden = true; });
  on("export-overlay", ev => { if (ev.target === $("export-overlay")) $("export-overlay").hidden = true; });
  on("exp-csv", async () => { if (await exportCSV(readExportFilter())) $("export-overlay").hidden = true; });
  on("exp-xls", async () => { if (await exportXLS(readExportFilter(), "resit-filtered")) $("export-overlay").hidden = true; });
  on("exp-claim-preset", async () => {
    if (!isPro()) { $("export-overlay").hidden = true; showUpgrade("Claim tracking and claim reports are Pro features."); return; }
    const f = readExportFilter();
    f.claim = "to-claim";
    const matches = filteredExpenses(f);
    if (!matches.length) { toast("No to-claim expenses in that range"); return; }
    await exportXLS(f, "resit-claim-report");
    $("export-overlay").hidden = true;
    setTimeout(async () => {
      if (!confirm("Claim report exported (" + matches.length + " expenses). Mark them all as claimed?")) return;
      for (const e of matches) { e.claimStatus = "claimed"; await DB.updateExpense(e); }
      renderCurrent();
      toast("Marked claimed");
    }, 400);
  });
  on("claim-mark-btn", async () => {
    const list = monthExpenses().filter(e => e.claimStatus === "to-claim" && !e.pending);
    if (!list.length) return;
    if (!confirm("Mark " + list.length + " expense(s) this month as claimed?")) return;
    for (const e of list) { e.claimStatus = "claimed"; await DB.updateExpense(e); }
    renderCurrent();
    toast("Marked claimed");
  });
  on("backup-data", exportBackup);
  on("restore-data", () => { const r = $("restore-input"); if (r) r.click(); });
  const ri = $("restore-input");
  if (ri) ri.addEventListener("change", ev => { importBackup(ev.target.files[0]); ev.target.value = ""; });
  on("sync-now", manualSync);
  $("gh-token").addEventListener("change", async () => {
    state.ghToken = $("gh-token").value.trim();
    await DB.setSetting("ghToken", state.ghToken);
    /* Entitlement resets until the new token proves inbox access. */
    state.ghProven = false;
    await DB.setSetting("ghProven", false);
    renderPlan();
  });
  $("gh-test").addEventListener("click", async () => {
    const token = $("gh-token").value.trim();
    if (!token) { toast("Paste the GitHub token first"); return; }
    state.ghToken = token;
    await DB.setSetting("ghToken", token);
    toast("Testing…");
    try {
      const res = await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/inbox", { headers: ghHeaders() });
      if (res.ok) {
        state.ghProven = true;
        await DB.setSetting("ghProven", true);
        renderPlan();
        toast("Connected — Claude inbox is ready");
        syncInbox();
      }
      else if (res.status === 401) toast("Token not valid — check it was copied fully");
      else if (res.status === 404) toast("Token can't see resit-inbox — check its repository access");
      else toast("Connection failed (" + res.status + ")");
    } catch (e) {
      toast("Could not reach GitHub — check your connection");
    }
  });
  $("ai-url").addEventListener("change", async () => {
    state.aiUrl = $("ai-url").value.trim();
    await DB.setSetting("aiUrl", state.aiUrl);
  });
  $("ai-secret").addEventListener("change", async () => {
    state.aiSecret = $("ai-secret").value.trim();
    await DB.setSetting("aiSecret", state.aiSecret);
  });
  $("ai-test").addEventListener("click", async () => {
    const url = $("ai-url").value.trim(), secret = $("ai-secret").value.trim();
    if (!url) { toast("Enter the cloud reader URL first"); return; }
    state.aiUrl = url; state.aiSecret = secret;
    await DB.setSetting("aiUrl", url);
    await DB.setSetting("aiSecret", secret);
    renderCloudSetting();
    toast("Testing…");
    try {
      /* 1x1 white pixel — verifies URL, key and connectivity end-to-end. */
      const px = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
      const payload = { image: px, mediaType: "image/jpeg", deviceId: state.deviceId };
      if (secret) payload.secret = secret;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) toast("Connected — cloud reader is ready");
      else toast(body.error || ("Connection failed (" + res.status + ")"));
    } catch (e) {
      toast("Could not reach the reader — check the URL");
    }
  });
  on("cloud-toggle", async () => {
    state.cloudConsent = state.cloudConsent === "yes" ? "no" : "yes";
    await DB.setSetting("cloudConsent", state.cloudConsent);
    renderCloudSetting();
    toast(state.cloudConsent === "yes" ? "Cloud reading on" : "Cloud reading off — staying on-device");
  });
  on("plan-btn", () => showUpgrade(""));
  on("upgrade-buy", () => { if (PAY_URL) window.open(PAY_URL, "_blank", "noopener"); else toast("Online checkout is coming soon"); });
  on("upgrade-code", unlockPro);
  on("upgrade-close", () => { const ov = $("upgrade-overlay"); if (ov) ov.hidden = true; });
  on("upgrade-overlay", ev => { if (ev.target === $("upgrade-overlay")) $("upgrade-overlay").hidden = true; });
  $("app-version").textContent = "Resit " + APP_VERSION + " · ";
  $("copy-scan").addEventListener("click", async () => {
    const t = await DB.getSetting("lastScan", "");
    if (!t) { toast("No scan yet"); return; }
    try {
      await navigator.clipboard.writeText(t);
      toast("Copied — paste it to Claude to improve reading");
    } catch (e) {
      toast("Couldn't copy on this browser");
    }
  });
  $("erase-data").addEventListener("click", async () => {
    if (!confirm("Erase all expenses and settings? This cannot be undone.")) return;
    await DB.eraseAll();
    /* Reload for a truly clean slate — resetting state field-by-field here
       kept drifting out of date as new state was added. */
    location.reload();
  });

  /* Service worker + auto-update: when a new version installs, the SW takes
     control and we reload once automatically — no more closing the app twice.
     Skipped in the native shell, which bundles its own assets offline. */
  if ("serviceWorker" in navigator && !isNative()) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then(reg => {
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (nw) nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) toast("Updating Resit…");
        });
      });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded || !hadController) return; /* skip the very first install */
      reloaded = true;
      location.reload();
    });
  }

  /* Pick up Claude's results and push any queued photos, THEN clean up — so a
     still-queued photo can never be deleted before it has uploaded. */
  syncInbox().finally(cleanupPhotos);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncInbox();
  });
  /* While a receipt is waiting and the app is open, check for Claude's
     results every minute — no pull-to-refresh needed. */
  setInterval(() => {
    if (document.visibilityState === "visible" && state.ghToken && state.expenses.some(e => e.pending)) syncInbox();
  }, 60000);
}

/* Remove photo records whose work is done or long stale, so storage doesn't
   grow forever. Only ever deletes photos that have actually UPLOADED — a
   still-queued photo (never sent to Claude) is always kept so a receipt can't
   be lost before it reaches the inbox. */
async function cleanupPhotos() {
  try {
    const photos = await DB.getAllPhotos();
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const p of photos) {
      if (p.status !== "uploaded") continue;        /* never drop a queued photo */
      const exp = state.expenses.find(x => String(x.id) === String(p.expenseId));
      const done = exp && !exp.pending;             /* expense already filled in */
      const orphan = !exp;                          /* expense was deleted */
      const stale = p.createdAt && new Date(p.createdAt).getTime() < cutoff;
      if (done || orphan || stale) {
        await DB.deletePhoto(p.id);
      }
    }
  } catch (e) { /* non-critical */ }
}

init();
