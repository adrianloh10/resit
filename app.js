/* Resit — snap receipts, track spending. All data stays on-device. */

const APP_VERSION = self.RESIT_VERSION || "v?"; /* set once in version.js; sw.js shares it */

const $ = id => document.getElementById(id);
const CATS = window.ReceiptOCR.CATEGORIES;
const CAT_COLOR = Object.fromEntries(CATS.map(c => [c.name, c.color]));

/* A second classification axis, independent of category: who the spend is for.
   Each gets its own earth-tone accent. Default for new/old expenses: Personal. */
const SCOPES = ["Personal", "Shared", "Company"];
const SCOPE_CLASS = { Personal: "scope-personal", Shared: "scope-shared", Company: "scope-company" };
const SCOPE_FILL = { Personal: "var(--clay)", Shared: "var(--moss)", Company: "var(--ochre)" };
const scopeOf = e => (e && SCOPES.includes(e.scope)) ? e.scope : "Personal";
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
  catBudgets: {},
  theme: "light",
  aiUrl: "",
  aiSecret: "",
  ghToken: "",
  deviceId: "",
  cloudConsent: "",  /* "", "yes", "no" — explicit opt-in for cloud reading */
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
  if (data.category && CAT_COLOR[data.category]) e.category = data.category;
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
  if (mt) mt.setAttribute("content", resolved === "dark" ? "#25211A" : "#F7F3EC");
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

function fmtRM(n, withSign) {
  const s = (Math.round(n * 100) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (withSign ? "RM " : "") + s;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- Rendering ---------- */

function monthExpenses() {
  const m = viewedMonth();
  return state.expenses
    .filter(e => { const d = new Date(e.date); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderHome() {
  const m = viewedMonth();
  const now = new Date();
  const sameYear = m.getFullYear() === now.getFullYear();
  $("month-label").textContent = MONTH_NAMES[m.getMonth()] + (sameYear ? "" : " " + m.getFullYear());

  const allExps = monthExpenses();
  renderScopeFilter(allExps);

  /* The Personal/Shared/Company filter narrows everything below it, including
     the headline total. "" = All. */
  const scoped = state.scopeFilter ? allExps.filter(e => scopeOf(e) === state.scopeFilter) : allExps;
  const total = scoped.reduce((s, e) => s + e.amount, 0);
  const [whole, cents] = fmtRM(total).split(".");
  $("month-total").innerHTML = `${whole}<span class="cents">.${cents}</span>`;

  const fill = $("budget-fill");
  if (state.scopeFilter) {
    /* When filtering by type, the bar shows that type's share of the month. */
    const monthTotal = allExps.reduce((s, e) => s + e.amount, 0);
    const share = monthTotal > 0 ? Math.round((total / monthTotal) * 100) : 0;
    $("budget-line").textContent = `${state.scopeFilter} · ${share}% of this month`;
    fill.style.width = share + "%";
    fill.classList.remove("over");
    fill.style.background = SCOPE_FILL[state.scopeFilter];
  } else {
    fill.style.background = "";
    if (state.budget > 0) {
      $("budget-line").textContent = `of RM ${state.budget.toLocaleString("en-MY")} budget`;
      const pct = Math.min(100, (total / state.budget) * 100);
      fill.style.width = pct + "%";
      fill.classList.toggle("over", total > state.budget);
    } else {
      $("budget-line").textContent = "no budget set";
      fill.style.width = "0";
    }
  }

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

  /* Search + category filter further narrow the (already scope-filtered) list. */
  const q = state.search.trim().toLowerCase();
  let exps = scoped;
  if (q) exps = exps.filter(e =>
    (e.merchant || "").toLowerCase().includes(q) ||
    (e.note || "").toLowerCase().includes(q) ||
    (e.category || "").toLowerCase().includes(q) ||
    (e.items || []).some(i => (i.name || "").toLowerCase().includes(q)));
  if (state.filterCat) exps = exps.filter(e => e.category === state.filterCat);

  const ledger = $("ledger");
  ledger.innerHTML = "";
  const empty = $("empty-note");
  if (!allExps.length) {
    empty.hidden = false;
    empty.innerHTML = "No expenses yet.<br>Tap the camera to snap your first receipt.";
  } else if (!exps.length) {
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
    const dup = dupIds.has(e.id) ? `<span class="dup-flag">duplicate?</span> · ` : "";
    const camera = e.photo ? `<span class="has-photo" aria-hidden="true">▦ </span>` : "";
    const sc = scopeOf(e);
    const scopePill = `<span class="scope-pill ${SCOPE_CLASS[sc]}">${sc}</span>`;
    const amountHtml = e.pending
      ? `<span class="entry-amount waiting">waiting…</span>`
      : `<span class="entry-amount">${fmtRM(e.amount)}</span>`;
    const row = document.createElement("button");
    row.className = "entry";
    row.innerHTML = `
      <span class="cat-dot" style="background:${CAT_COLOR[e.category] || CAT_COLOR.Other}"></span>
      <span class="entry-main">
        <span class="entry-merchant">${camera}${escapeHtml(e.merchant || "Expense")}${scopePill}</span>
        <span class="entry-cat">${dup}${e.pending ? "waiting for Claude · " : ""}${escapeHtml(e.category)}${e.note ? " · " + escapeHtml(e.note) : ""}</span>
      </span>
      ${amountHtml}`;
    row.addEventListener("click", () => openConfirmSheet(e));
    ledger.appendChild(row);
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

/* Personal / Shared / Company filter with each type's running monthly total
   shown right on the chip — tap to filter the list and the headline total. */
function renderScopeFilter(monthExps) {
  const row = $("scope-filter");
  if (!row) return;
  const totals = { Personal: 0, Shared: 0, Company: 0 };
  let all = 0;
  for (const e of monthExps) { totals[scopeOf(e)] += e.amount; all += e.amount; }
  row.innerHTML = "";
  const mk = (label, value, amount, cls) => {
    const b = document.createElement("button");
    b.className = "scope-chip " + cls + (state.scopeFilter === value ? " selected" : "");
    b.innerHTML = `<span class="scope-chip-name">${label}</span><span class="scope-chip-amt">${fmtRM(amount)}</span>`;
    b.addEventListener("click", () => { state.scopeFilter = (state.scopeFilter === value) ? "" : value; renderHome(); });
    row.appendChild(b);
  };
  mk("All", "", all, "scope-all");
  for (const s of SCOPES) mk(s, s, totals[s], SCOPE_CLASS[s]);
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
    b.addEventListener("click", () => { state.editing.scope = s; renderScopeChips(); });
    chips.appendChild(b);
  }
}

function totalForMonth(year, monthIndex) {
  return state.expenses.reduce((s, e) => {
    const d = new Date(e.date);
    return d.getFullYear() === year && d.getMonth() === monthIndex ? s + e.amount : s;
  }, 0);
}

function renderInsights() {
  const m = viewedMonth();
  const now = new Date();
  $("ins-month-label").textContent = MONTH_NAMES[m.getMonth()] + (m.getFullYear() === now.getFullYear() ? "" : " " + m.getFullYear());

  const exps = monthExpenses();
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const body = $("insights-body");

  if (!exps.length) {
    body.innerHTML = `<p class="empty-note" style="margin-top:40px">Nothing this month yet.</p>`;
    return;
  }

  const byCat = {};
  for (const e of exps) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

  const byMerchant = {};
  for (const e of exps) {
    const key = e.merchant || "Unnamed";
    byMerchant[key] = (byMerchant[key] || 0) + e.amount;
  }
  const merchants = Object.entries(byMerchant).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const dayCount = new Set(exps.map(e => new Date(e.date).toDateString())).size;

  let html = `
    <div class="ins-total">
      <p class="big-amount" style="font-size:34px">${fmtRM(total)}</p>
      <p class="budget-line">${exps.length} expenses · ${dayCount} days · avg ${fmtRM(total / Math.max(1, dayCount), true)}/day</p>
    </div>`;

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
      <span class="trend-val">${b.total > 0 ? Math.round(b.total) : ""}</span>
      <div class="trend-bar ${b.current ? "cur" : ""}" style="height:${h}px"></div>
      <span class="trend-lbl">${b.label}</span>
    </div>`;
  }
  html += `</div>`;

  html += `<p class="ins-section-label">By category</p>`;
  for (const [cat, amt] of cats) {
    const pct = Math.round((amt / total) * 100);
    const cb = state.catBudgets[cat];
    const over = cb > 0 && amt > cb;
    const budgetNote = cb > 0 ? `<span class="cat-budget ${over ? "over" : ""}">${over ? "over " + fmtRM(amt - cb, true) : fmtRM(cb - amt, true) + " left"}</span>` : "";
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
  for (const [name, amt] of merchants) {
    html += `<div class="ins-row"><span class="ins-row-name">${escapeHtml(name)}</span><span class="ins-row-val">${fmtRM(amt)}</span></div>`;
  }

  html += `<div class="home-settings-row"><button class="settings-link" id="open-settings">Settings</button></div>`;
  body.innerHTML = html;
  $("open-settings").addEventListener("click", () => switchView("settings"));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function switchView(name) {
  state.view = name;
  $("view-home").hidden = name !== "home";
  $("view-insights").hidden = name !== "insights";
  $("view-settings").hidden = name !== "settings";
  $("nav-home").classList.toggle("active", name === "home");
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

function fileToJpegBase64(file, maxDim) {
  return loadScaledJpeg(file, maxDim, 0.85).then(u => {
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
  const image = await fileToJpegBase64(file, 1568);
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

function openChooser() {
  $("chooser-overlay").hidden = false;
}

async function handleImage(file) {
  if (!file) return;
  /* Claude inbox mode: no on-device reading, no animation — save instantly
     as pending and let Claude fill in everything when it reviews the photo. */
  if (state.ghToken) {
    const thumb = await fileToThumb(file, 700);
    const record = {
      amount: 0,
      merchant: "Receipt",
      category: "Other",
      scope: "Personal",
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
    toast("Saved — Claude will fill it in");
    return;
  }
  state.ocrCancelled = false;
  $("processing-overlay").hidden = false;
  $("processing-text").textContent = "Reading receipt…";
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
  $("confirm-amount").value = e.amount != null ? e.amount.toFixed(2) : "";
  $("confirm-merchant").value = e.merchant;
  const d = new Date(e.date);
  $("confirm-date").value = d.toISOString().slice(0, 10);
  $("confirm-time").value = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  $("confirm-note").value = e.note || "";

  renderScopeChips();
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
    del.addEventListener("click", async () => {
      await DB.deleteExpense(e.id);
      state.expenses = state.expenses.filter(x => x.id !== e.id);
      closeConfirmSheet();
      renderCurrent();
      toast("Deleted");
    });
    $("save-btn").after(del);
  }

  $("confirm-overlay").hidden = false;
  if (!e.amount) setTimeout(() => $("confirm-amount").focus(), 50);
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

function closeConfirmSheet() {
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

  rememberMerchantCategory(record.merchant, record.category);
  learnFromCorrections(e, record);

  closeConfirmSheet();
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

/* ---------- Settings ---------- */

/* One source of truth for export columns — CSV and Excel both build from this,
   so adding a column (or guarding a value) happens once. Numbers are coerced
   defensively so a malformed restored record can never crash an export. */
const EXPORT_HEADERS = ["Date", "Time", "Merchant", "Category", "Type", "Amount (RM)", "Note", "Items"];
function expenseExportRecords() {
  return [...state.expenses]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(e => {
      const d = new Date(e.date);
      const amount = Number(e.amount) || 0;
      return {
        date: d.toLocaleDateString("en-MY"),
        time: d.toTimeString().slice(0, 5),
        merchant: e.merchant || "",
        category: e.category || "",
        type: scopeOf(e),
        amount,
        note: e.note || "",
        items: (e.items || []).map(i => `${(i && i.name) || ""} ${(Number(i && i.price) || 0).toFixed(2)}`.trim()).join("; ")
      };
    });
}

async function exportCSV() {
  const recs = expenseExportRecords();
  if (!recs.length) { toast("Nothing to export yet"); return; }
  const rows = [EXPORT_HEADERS];
  for (const r of recs) rows.push([r.date, r.time, r.merchant, r.category, r.type, r.amount.toFixed(2), r.note, r.items]);
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), "resit-expenses.csv");
}

/* Styled Excel export — dependency-free. An HTML table with Excel's XML
   namespace opens directly in Excel/Sheets with formatting intact. */
async function exportXLS() {
  const recs = expenseExportRecords();
  if (!recs.length) { toast("Nothing to export yet"); return; }
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
      <td style="mso-number-format:'0.00';text-align:right">${r.amount.toFixed(2)}</td>
      <td>${escapeHtml(r.note)}</td>
      <td>${escapeHtml(r.items)}</td>
    </tr>`;
  }
  const th = EXPORT_HEADERS.map(h => `<th>${h}</th>`).join("");
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
      <tr class="total"><td colspan="5">Total (${recs.length} expenses)</td>
      <td style="mso-number-format:'0.00';text-align:right">${total.toFixed(2)}</td><td></td><td></td></tr>
    </tbody>
  </table></body></html>`;
  downloadBlob(new Blob(["﻿" + html], { type: "application/vnd.ms-excel;charset=utf-8" }), "resit-expenses.xls");
}

/* Full backup: everything needed to rebuild the app on a new phone. Secrets
   (GitHub token, AI code) and the cached scan/photos are deliberately left out
   so the file is safe to store and small. */
async function exportBackup() {
  const settingsAll = await DB.getAllSettings();
  const SKIP = new Set(["ghToken", "aiSecret", "lastScan"]);
  const settings = settingsAll.filter(s => s && s.key && !SKIP.has(s.key));
  const expenses = state.expenses.map(({ photo, ...rest }) => rest);
  const backup = { app: "resit", type: "backup", version: 1, exportedAt: new Date().toISOString(), expenses, settings };
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(backup)], { type: "application/json" }), "resit-backup-" + stamp + ".json");
  toast("Backed up " + expenses.length + " expenses");
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
    category: CAT_COLOR[e.category] ? e.category : "Other",
    scope: SCOPES.includes(e.scope) ? e.scope : "Personal",
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
      for (const s of data.settings) { if (s && s.key) await DB.setSetting(s.key, s.value); }
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
  state.catBudgets = await DB.getSetting("catBudgets", {});
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
    state.catBudgets = await DB.getSetting("catBudgets", {});
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
    state.expenses = await DB.getAllExpenses();
    sessionStorage.removeItem("dbRetry");
  } catch (err) {
    if (!sessionStorage.getItem("dbRetry")) {
      sessionStorage.setItem("dbRetry", "1");
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

  $("month-prev").addEventListener("click", () => { state.monthOffset--; renderHome(); });
  $("month-next").addEventListener("click", () => { state.monthOffset++; renderHome(); });
  $("ins-month-prev").addEventListener("click", () => { state.monthOffset--; renderInsights(); });
  $("ins-month-next").addEventListener("click", () => { state.monthOffset++; renderInsights(); });

  $("nav-home").addEventListener("click", () => switchView("home"));
  $("nav-insights").addEventListener("click", () => switchView("insights"));
  /* on(): elements may be absent for one update cycle while the cached
     index.html lags behind app.js — never let wiring crash init. */
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
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
    if (state.view === "settings" || !$("confirm-overlay").hidden || !$("chooser-overlay").hidden) { swipe = null; return; }
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
    if (state.view === "home") { state.monthOffset += dx < 0 ? 1 : -1; renderHome(); }
    else if (state.view === "insights") { state.monthOffset += dx < 0 ? 1 : -1; renderInsights(); }
  }, { passive: true });

  $("fab-camera").addEventListener("click", openChooser);
  $("choose-camera").addEventListener("click", () => { $("chooser-overlay").hidden = true; $("camera-input").click(); });
  $("choose-gallery").addEventListener("click", () => { $("chooser-overlay").hidden = true; $("gallery-input").click(); });
  $("choose-manual").addEventListener("click", () => { $("chooser-overlay").hidden = true; openConfirmSheet(null); });
  $("chooser-overlay").addEventListener("click", ev => { if (ev.target === $("chooser-overlay")) $("chooser-overlay").hidden = true; });

  $("camera-input").addEventListener("change", ev => { handleImage(ev.target.files[0]); ev.target.value = ""; });
  $("gallery-input").addEventListener("change", ev => { handleImage(ev.target.files[0]); ev.target.value = ""; });
  $("cancel-ocr").addEventListener("click", () => { state.ocrCancelled = true; $("processing-overlay").hidden = true; });

  $("confirm-merchant").addEventListener("input", () => {
    const e = state.editing;
    if (!e || e.userPicked || e.id) return;
    const v = $("confirm-merchant").value;
    if (v.trim().length < 3) return;
    const g = learnedCategory(v) || window.ReceiptOCR.guessCategory(v, v);
    if (g && g !== "Other" && g !== e.category) { e.category = g; renderCategoryChips(); }
  });

  $("confirm-back").addEventListener("click", closeConfirmSheet);
  $("confirm-overlay").addEventListener("click", ev => { if (ev.target === $("confirm-overlay")) closeConfirmSheet(); });
  $("save-btn").addEventListener("click", saveExpense);

  $("budget-input").addEventListener("change", async () => {
    const v = parseFloat($("budget-input").value) || 0;
    state.budget = v;
    await DB.setSetting("budget", v);
    toast("Budget saved");
  });
  $("export-csv").addEventListener("click", exportCSV);
  on("export-xls", exportXLS);
  on("backup-data", exportBackup);
  on("restore-data", () => { const r = $("restore-input"); if (r) r.click(); });
  const ri = $("restore-input");
  if (ri) ri.addEventListener("change", ev => { importBackup(ev.target.files[0]); ev.target.value = ""; });
  on("sync-now", manualSync);
  $("gh-token").addEventListener("change", async () => {
    state.ghToken = $("gh-token").value.trim();
    await DB.setSetting("ghToken", state.ghToken);
  });
  $("gh-test").addEventListener("click", async () => {
    const token = $("gh-token").value.trim();
    if (!token) { toast("Paste the GitHub token first"); return; }
    state.ghToken = token;
    await DB.setSetting("ghToken", token);
    toast("Testing…");
    try {
      const res = await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/inbox", { headers: ghHeaders() });
      if (res.ok) { toast("Connected — Claude inbox is ready"); syncInbox(); }
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
    state.expenses = [];
    state.budget = 3000;
    state.merchantCats = {};
    state.merchantNames = {};
    state.totalHints = {};
    switchView("home");
    toast("All data erased");
  });

  /* Service worker + auto-update: when a new version installs, the SW takes
     control and we reload once automatically — no more closing the app twice. */
  if ("serviceWorker" in navigator) {
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
