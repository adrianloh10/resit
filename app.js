/* Resit — snap receipts, track spending. All data stays on-device. */

const APP_VERSION = "v12"; /* keep in step with CACHE in sw.js */

const $ = id => document.getElementById(id);
const CATS = window.ReceiptOCR.CATEGORIES;
const CAT_COLOR = Object.fromEntries(CATS.map(c => [c.name, c.color]));
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
  theme: "auto"
};

/* ---------- Theme ---------- */

const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  const resolved = state.theme === "auto" ? (darkMedia.matches ? "dark" : "light") : state.theme;
  document.documentElement.dataset.theme = resolved;
  $("meta-theme").setAttribute("content", resolved === "dark" ? "#25211A" : "#F7F3EC");
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

  const exps = monthExpenses();
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const [whole, cents] = fmtRM(total).split(".");
  $("month-total").innerHTML = `${whole}<span class="cents">.${cents}</span>`;

  if (state.budget > 0) {
    $("budget-line").textContent = `of RM ${state.budget.toLocaleString("en-MY")} budget`;
    const pct = Math.min(100, (total / state.budget) * 100);
    const fill = $("budget-fill");
    fill.style.width = pct + "%";
    fill.classList.toggle("over", total > state.budget);
  } else {
    $("budget-line").textContent = "no budget set";
    $("budget-fill").style.width = "0";
  }

  const ledger = $("ledger");
  ledger.innerHTML = "";
  $("empty-note").hidden = exps.length > 0;

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
    const row = document.createElement("button");
    row.className = "entry";
    row.innerHTML = `
      <span class="cat-dot" style="background:${CAT_COLOR[e.category] || CAT_COLOR.Other}"></span>
      <span class="entry-main">
        <span class="entry-merchant">${escapeHtml(e.merchant || "Expense")}</span>
        <span class="entry-cat">${escapeHtml(e.category)}${e.note ? " · " + escapeHtml(e.note) : ""}</span>
      </span>
      <span class="entry-amount">${fmtRM(e.amount)}</span>`;
    row.addEventListener("click", () => openConfirmSheet(e));
    ledger.appendChild(row);
  }
}

function renderInsights() {
  const m = viewedMonth();
  const now = new Date();
  $("ins-month-label").textContent = MONTH_NAMES[m.getMonth()] + (m.getFullYear() === now.getFullYear() ? "" : " " + m.getFullYear());

  const exps = monthExpenses();
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const body = $("insights-body");

  if (!exps.length) {
    body.innerHTML = `<p class="empty-note">Nothing this month yet.</p>`;
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

  for (const [cat, amt] of cats) {
    const pct = Math.round((amt / total) * 100);
    html += `
      <div class="cat-bar-row">
        <div class="cat-bar-head">
          <span class="cat-bar-name">${escapeHtml(cat)}</span>
          <span class="cat-bar-amt">${fmtRM(amt)} · ${pct}%</span>
        </div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${CAT_COLOR[cat] || CAT_COLOR.Other}"></div></div>
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
  $("nav-settings").classList.toggle("active", name === "settings");
  if (name === "home") renderHome();
  if (name === "insights") renderInsights();
  if (name === "settings") { $("budget-input").value = state.budget || ""; renderThemeChips(); }
  window.scrollTo(0, 0);
}

/* ---------- Capture flow ---------- */

function openChooser() {
  $("chooser-overlay").hidden = false;
}

async function handleImage(file) {
  if (!file) return;
  state.ocrCancelled = false;
  $("processing-overlay").hidden = false;
  $("processing-text").textContent = "Reading receipt…";
  try {
    const parsed = await window.ReceiptOCR.scanReceipt(file, msg => { $("processing-text").textContent = msg; });
    if (state.ocrCancelled) return;
    $("processing-overlay").hidden = true;
    DB.setSetting("lastScan", parsed.rawText || "");
    applyLearnedTotalHint(parsed);
    if (!parsed.total && !parsed.merchant && !parsed.items.length) {
      toast("Couldn't read that — try better lighting, or enter manually");
      openConfirmSheet(null);
      return;
    }
    openConfirmSheet(parsedToDraft(parsed));
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
  state.editing = expense ? { ...expense, items: (expense.items || []).slice() } : {
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

  renderCategoryChips();

  const itemsBlock = $("items-block");
  itemsBlock.innerHTML = "";
  if (e.items && e.items.length) {
    const label = document.createElement("p");
    label.className = "items-label";
    label.textContent = e.items.length + (e.items.length === 1 ? " item read from receipt" : " items read from receipt");
    itemsBlock.appendChild(label);
    for (const it of e.items) {
      const row = document.createElement("div");
      row.className = "item-row";
      row.innerHTML = `<span class="item-name">${escapeHtml(it.name)}</span><span class="item-price">${fmtRM(it.price)}</span>`;
      itemsBlock.appendChild(row);
    }
  }

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
  if (!(amount > 0)) { toast("Enter an amount"); $("confirm-amount").focus(); return; }

  const dateStr = $("confirm-date").value;
  const timeStr = $("confirm-time").value || "12:00";
  const d = dateStr ? new Date(dateStr + "T" + timeStr) : new Date();

  const record = {
    amount: Math.round(amount * 100) / 100,
    merchant: $("confirm-merchant").value.trim(),
    category: e.category || "Other",
    date: d.toISOString(),
    items: e.items || [],
    note: $("confirm-note").value.trim(),
    createdAt: e.createdAt || new Date().toISOString()
  };

  if (e.id) {
    record.id = e.id;
    await DB.updateExpense(record);
    const i = state.expenses.findIndex(x => x.id === e.id);
    if (i >= 0) state.expenses[i] = record;
  } else {
    record.id = await DB.addExpense(record);
    state.expenses.push(record);
  }

  rememberMerchantCategory(record.merchant, record.category);
  learnFromCorrections(e, record);

  closeConfirmSheet();
  const saved = new Date(record.date);
  const now = new Date();
  state.monthOffset = (saved.getFullYear() - now.getFullYear()) * 12 + (saved.getMonth() - now.getMonth());
  switchView("home");
  toast(e.id ? "Updated" : "Saved " + fmtRM(record.amount, true));
}

function renderCurrent() {
  if (state.view === "home") renderHome();
  if (state.view === "insights") renderInsights();
}

/* ---------- Settings ---------- */

async function exportCSV() {
  const all = [...state.expenses].sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!all.length) { toast("Nothing to export yet"); return; }
  const rows = [["Date", "Time", "Merchant", "Category", "Amount (RM)", "Note", "Items"]];
  for (const e of all) {
    const d = new Date(e.date);
    rows.push([
      d.toLocaleDateString("en-MY"),
      d.toTimeString().slice(0, 5),
      e.merchant, e.category, e.amount.toFixed(2), e.note || "",
      (e.items || []).map(i => `${i.name} ${i.price.toFixed(2)}`).join("; ")
    ]);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "resit-expenses.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- Init ---------- */

async function init() {
  state.budget = await DB.getSetting("budget", 3000);
  state.merchantCats = await DB.getSetting("merchantCats", {});
  state.merchantNames = await DB.getSetting("merchantNames", {});
  state.totalHints = await DB.getSetting("totalHints", {});
  state.theme = await DB.getSetting("theme", "auto");
  applyTheme();
  darkMedia.addEventListener("change", () => { if (state.theme === "auto") applyTheme(); });
  renderHome();

  $("month-prev").addEventListener("click", () => { state.monthOffset--; renderHome(); });
  $("month-next").addEventListener("click", () => { state.monthOffset++; renderHome(); });
  $("ins-month-prev").addEventListener("click", () => { state.monthOffset--; renderInsights(); });
  $("ins-month-next").addEventListener("click", () => { state.monthOffset++; renderInsights(); });

  $("nav-home").addEventListener("click", () => switchView("home"));
  $("nav-insights").addEventListener("click", () => switchView("insights"));
  $("nav-settings").addEventListener("click", () => switchView("settings"));
  $("settings-back").addEventListener("click", () => switchView("home"));

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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
