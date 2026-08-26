/* Recap — snap receipts, track spending. All data stays on-device. */

const APP_VERSION = self.RESIT_VERSION || "v?"; /* set once in version.js; sw.js shares it */
const TERMS_VERSION = "1.2"; /* bump when eula.html changes materially — the accept gate re-shows */

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
/* Same guard, generalised: a bare obj[key] lookup on a plain {} silently
   falls through to an inherited Object.prototype member (constructor,
   toString, hasOwnProperty, ...) when key happens to collide with one —
   e.g. a receipt/cloud-AI merchant name whose first word is "constructor".
   Used for every plain-object lookup keyed by OCR/cloud text, a restored
   backup value, or free-typed user input (learned-merchant stores, scope
   styling tables, locale tables). */
const safeGet = (obj, k) => (obj && typeof k === "string" && hasOwn(obj, k)) ? obj[k] : undefined;

/* A second classification axis, independent of category: who the spend is for.
   Each gets its own earth-tone accent. Default for new/old expenses: Personal. */
/* Built-in expense types. Defaults are Personal / Company / Family (1.10.0);
   "Shared" is kept RECOGNISED (colour + claimable) so pre-1.10 data never
   collapses, but it is no longer offered as a default. */
const DEFAULT_SCOPES = ["Personal", "Company", "Family"];
const SCOPE_CLASS = { Personal: "scope-personal", Company: "scope-company", Family: "scope-family", Shared: "scope-shared" };
const SCOPE_FILL = { Personal: "var(--teal)", Company: "var(--sienna-red)", Family: "var(--gold)", Shared: "var(--gold)" };
const SCOPE_TAG = { Personal: "t-personal", Company: "t-company", Family: "t-family", Shared: "t-shared" };
const CLAIMABLE = new Set(["Company", "Shared"]); /* types that can be "to claim" */
/* state.scopes = the user's active built-ins (chosen at setup); customScopes =
   Pro-added types. allScopes() is what the sheet/filters offer. */
const allScopes = () => (state.scopes && state.scopes.length ? state.scopes : DEFAULT_SCOPES).concat(state.customScopes || []);
const scopeClass = s => safeGet(SCOPE_CLASS, s) || "scope-custom";
const scopeFill = s => safeGet(SCOPE_FILL, s) || "var(--terracotta)";
const scopeTag = s => safeGet(SCOPE_TAG, s) || "t-custom";
/* Trust a stored scope string so legacy data (e.g. "Shared") or a
   deselected type never silently becomes Personal; only empty is defaulted. */
const scopeOf = e => (e && typeof e.scope === "string" && e.scope.trim()) ? e.scope : "Personal";

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
  ocrCancelled: false, /* batch-scan cancellation only (scanAllInBatch) — single-scan cancellation uses cancelledScanIds below, which survives a newer scan starting; this one doesn't need to */
  cancelledScanIds: new Set(), /* scan ids cancelled via the pill tap; a scan checks cancelledScanIds.has(myId) to know if it SPECIFICALLY was cancelled. A Set (not a single id) because more than one scan can be independently cancelled while still in flight — e.g. cancel scan A, then later cancel a different scan B before A's own (up to 20s) cloud read has settled; a single overwritable id would forget A was ever cancelled the moment B's cancel recorded over it */
  _scanSeq: 0,       /* monotonic id per scan — the race merges only into the scan still on screen (no duplicate-sheet / lost-scan / cross-scan clobber) */
  pendingScans: [],  /* finished scans superseded by a newer rapid-fire scan before they could paint — queued for review instead of discarded, shown as soon as the screen frees up */
  merchantCats: {},
  merchantNames: {},
  totalHints: {},
  merchantScopes: {},
  catBudgets: {},
  currency: "RM",   /* display only — no conversion */
  selectMode: false, /* multi-select for bulk delete/edit (long-press to enter) */
  selected: null,    /* Set of selected expense ids while selectMode is on */
  batchMode: false,  /* scanning a stack of receipts one after another (Pro) */
  batchFiles: [], batchDrafts: [], batchIndex: 0, batchTotal: 0, batchSaved: 0, batchCardSlipSkipped: 0,
  customScopes: [],  /* user-added expense types beyond Personal/Shared/Company */
  country: "MY",    /* profile: drives date/number locale */
  language: "en",   /* profile: UI language (English only for now) */
  recurring: [],    /* monthly expense templates */
  scopes: ["Personal", "Company", "Family"], /* active built-in types (chosen at setup) */
  theme: "light",
  aiUrl: "",
  aiSecret: "",
  ghToken: "",
  deviceId: "",
  cloudConsent: "",  /* "", "yes", "no" — explicit opt-in for cloud reading */
  pro: false,        /* Pro entitlement (unlimited cloud reads) */
  ghProven: false,   /* ghToken verified against the private inbox repo */
  playEntitled: false, /* Play Billing entitlement via RevenueCat (Phase 18) — device-local, never exported */
  playManageUrl: "",   /* Play's manage-subscription URL from RevenueCat customer info — session-only, has a static fallback */
  skipResults: [],   /* deleted-while-pending expenses whose results to discard */
  shareQueue: [],    /* outbox: AI-derived {garbled,clean,hint} rules staged for the weekly pool upload */
  shareRules: "",    /* "" | "yes" = share (default on when cloud consent is on), "no" = never share */
  lastRuleUpload: 0, /* ISO timestamp of the last successful /rules upload (weekly cadence) */
  scanDay: "",       /* local "YYYY-MM-DD" the free scan counter belongs to */
  scanCount: 0,      /* scanned receipts used today (free tier: 1/day) */
  quotaNoticeDay: "", /* local "YYYY-MM-DD" the fair-use "AI reads used up" notice was last shown (Phase 17: at most once/day) */
  lastBackupAt: null,
  backupNudgeSnooze: "",
  licenseKey: "",
  lastKeyCheck: "",
  search: "",
  filterCat: "",
  scopeFilter: "",  /* "", "Personal", "Shared", "Company" */
  syncStatus: "",   /* "", "syncing", "ok", "auth", "offline" */
  lastSyncAt: null,
  /* Phase 7 (OCR-ENGINE-PLAN.md) — type-first snap. lastScope: persisted
     "type I used last" (DB-backed). pendingScope/pendingScopeTouched:
     transient (never persisted directly) — set fresh each time the Add
     chooser opens, carried into whichever entry point (camera/gallery/
     batch/manual) the user picks next via parsedToDraft()/the manual
     skeleton, then naturally stale until the next chooser-open resets them. */
  preScanType: "yes",  /* flag, default ON — DB-backed, loaded in init() */
  lastScope: "Personal",
  pendingScope: "Personal",
  pendingScopeTouched: false,
  /* Phase 8 (OCR-ENGINE-PLAN.md) — "Looks right?" on-demand AI re-read. */
  aiRecheck: "yes",  /* flag, default ON — DB-backed, loaded in init() */
  /* Phase 9 (OCR-ENGINE-PLAN.md) — card-slip guard. "" until the chooser has
     ever been opened once; "yes" thereafter (persisted, never reset). */
  cardNoticeSeen: ""
};

/* ---------- Claude inbox (free — processed by Claude Code on the PC) ----------
   Every scanned receipt's photo is queued to the private resit-inbox repo.
   Claude reads them when it runs and writes results/; we poll, apply, and
   delete. Photos are named <photoId>__<expenseId>.jpg so results can be
   matched back to the saved expense. */

const GH_REPO = "adrianloh10/resit-inbox";

/* Public cloud receipt reader (Cloudflare Worker) — see resit/cloud/DEPLOY.md.
   HARD-PINNED below (cloudEndpoint()); there is no Settings override for this
   anymore — see that function's own comment for why. */
const CLOUD_OCR_URL = "https://resit.adrianloh10.workers.dev";
/* The cloud endpoint is HARD-PINNED to our Worker — never a stored override.
   (A restored backup could otherwise plant an arbitrary aiUrl and exfiltrate
   receipt photos; see the REJECT set + security review, 1.9.0.) */
function cloudEndpoint() { return CLOUD_OCR_URL; }

/* Shipped fallback rules from the shared learning loop (curated by the owner
   from the pooled uploads — see SHARED-RULES-PLAN.md). Consulted ONLY when this
   device has not learned its own rule; a device's own learned rule always wins
   and seeds are NEVER copied into the stores (so future seed updates stay
   clean). Keys are brandOf(normMerchant(...)) tokens, matching the learning
   stores.

   v1, 20 Jul 2026 (Phase 4). Every key below is the ACTUAL brandOf() token
   produced by running window.ReceiptOCR.scanReceipt on the real receipt
   photos in resit/test-receipts/my/ (bench, gitignored) — never guessed.
   Chains with generic/legal-suffix-only merchant guesses (e.g. OCR reducing
   "Pasaraya Borong Pintar Sdn Bhd" or "Nando's ... Sdn Bhd" to just "SDN
   BHD" -> brand "sdn") were deliberately left out: "sdn" is the standard
   Malaysian company suffix and would mislabel almost any other business.
   Same reasoning excluded "perniagaan" (Malay for "business", equally
   generic) and Popular Book Co. (its merchant guess collapsed to "Company
   No. ..." / the mall name "Sunway Velocity", not the shop).

   v2, 3 Aug 2026 (Phase 15b — corpus mining). Entries below this note were
   mined from corpus-train's sroie-overflow slice (real tesseract.js OCR via
   automation/bench/corpus-ocr-capture.js, brandOf() token vs SROIE ground
   truth) instead of the my100 bench photos, same brandOf() derivation
   either way. MANY more candidates were found and REJECTED on manual review
   before shipping any of these — the mining is honest but naive (plain
   truth-diff, no notion of "OCR already got it right, don't overwrite with
   a worse legal-entity name" or "this brand token is too generic to be
   safe"), so every candidate needed a human sanity pass exactly like this
   file's v1 entries got. Rejected, for the record: "makassar"->Gardenia
   Bakeries (SROIE's OWN truth field is wrong for those receipts — the OCR
   guess "MAKASSAR FRESH MARKET" was already correct, already in
   MERCHANT_LEXICON); "familymart"->Haxincone Resources (OCR read the real
   storefront name correctly; truth is the franchise legal entity — same
   trap as this file's existing Unihakka/Bar Wang Rice case); "three",
   "enterprise" (brand tokens too generic/collision-prone to key a global
   rule on); "kuchai" (a MR DIY branch qualifier, not a brand — MERCHANT_
   LEXICON's comment already excluded this exact token on the same
   reasoning); "sanyo"->Sanyu Stationery (a real, unrelated consumer-
   electronics brand name — seeding it would mislabel actual Sanyo
   receipts).

   A SECOND round of candidates ("gardenia" name+hint, "makassar" hint) was
   initially shipped, then REVERTED after /code-review caught what the
   mining script's own collision guard couldn't: it only checks for
   collisions WITHIN the 1545-receipt bench corpus, not against the real
   world. "Gardenia" is an ordinary word used broadly in Malaysian business
   naming (hotels, cafes, spas, wedding/banquet halls, condos) — not
   exclusive to the bread company — so seeding it (with NO confidence gate
   on the names lookup — it overwrites even an already-correct, unrelated
   merchant guess) risked silently relabeling any of those as "Gardenia
   Bakeries". "Makassar" carries the same class of risk (plausible as an
   Indonesian-cuisine restaurant name in Malaysia). "afon"->AEON survived
   review: it's not a dictionary word or a plausible business-naming
   pattern, only arising from this specific OCR misread, so the collision
   surface is far narrower. See automation/bench/mined/ocr-mining-report.json
   for the full mined candidate list (evidence counts, rejection reasons)
   and the code-review workflow's journal for the collision-risk finding
   that caught the second-round revert. */
const SEED_RULES = {
  names: {
    /* MR D.I.Y. — 079,081,084,085.json: OCR reads bare "MR.D.I.Y"/"MR. D.I.Y"
       (no branch qualifier) as literally "mr d i y" (each letter of D.I.Y is
       parsed as its own 1-char token, so brandOf falls through to the whole
       normalized string). Branch-qualified reads (002 "MR D.I.Y. JOHOR" ->
       "johor", 086 "... KUCHAI" -> "kuchai") were skipped: those tokens are
       branch names, not brand-specific. */
    "mr d i y": "MR DIY",
    /* 99 Speed Mart — 028,062,069,070.json: consistently "speed". */
    "speed": "99 Speed Mart",
    /* Teo Heng Stationery & Books — 021,023,024,025.json: OCR consistently
       misreads "TEO" as "TED" for this store's receipt font. */
    "ted": "Teo Heng Stationery",
    /* Unihakka International (trades as Bar Wang Rice — visible in
       032.json's raw text: "BAR WANG RICE@PERMAS JAYA", "...comBaWangRice").
       032,033,044.json read "unihakka" cleanly; 030.json drops the "i". */
    "unihakka": "Bar Wang Rice",
    "unhakka": "Bar Wang Rice",
    /* Lightroom Gallery — 016,017,018.json: consistently "lightroom". */
    "lightroom": "Lightroom Gallery",
    /* Lian Hing Stationery — 073,075,076.json: OCR misreads "LIAN" as a
       different 3-letter word on each photo ("uan"/"lan"/"jan") — no single
       stable token, so all three real misreads are seeded individually.
       Lower confidence: these are short, common-looking fragments (esp.
       "jan") with some collision risk against an unrelated business. */
    "uan": "Lian Hing Stationery",
    "lan": "Lian Hing Stationery",
    "jan": "Lian Hing Stationery",
    /* Tri Shaas — 090,091.json: consistently "tri". */
    "tri": "Tri Shaas",
    /* Ikano Handel (IKEA's Malaysian retail operator) — 087,088.json. */
    "ikano": "Ikano Handel",
    /* Home Master Hardware & Electrical — 012,015.json: OCR misreads "HOME"
       as "HOWE" for this store's receipt font. */
    "howe": "Home Master Hardware",
    /* Hon Hwa Hardware Trading — 080,082.json: consistently "hon". */
    "hon": "Hon Hwa Hardware",
    /* AEON — corpus-train sroie-311,449: OCR consistently misreads "AEON"
       as "AFON" (E->F) on these receipts' font, collapsing to the whole
       string since "afon" fails brandOf's own >=3-char/non-stopword test
       otherwise it wouldn't be there at all — i.e. the ENTIRE guessed name
       is just "AFON". */
    "afon": "AEON"
  },
  hints: {
    /* Each value is the literal keyword learnFromAI's own extraction regex
       (/[A-Za-z][A-Za-z .]{3,24}/, lowercased) would produce from the real
       total-line text in the cited receipt — same derivation the app uses
       for a live cloud-read rule, just run by hand against the bench. */
    "mr d i y": "total incl.gstoby rm",   /* 079.json — OCR-mangled "TOTAL INCL.GST(BY) RM"; fragile, least confident of this set */
    "speed": "total sales",               /* 028.json — "Total Sales (Inclusive GST) RM 2.50" */
    "ted": "total",                       /* 021.json — "TOTAL : 4.90" */
    "unihakka": "total amount",           /* 032.json — "Total Amount: $8.20" */
    "unhakka": "ct total amount",         /* 030.json — ") CT Total Amount; $8.20 :" */
    "lightroom": "total",                 /* 017.json — "TOTAL : RM 39.80" */
    "uan": "total amt payable",           /* 073.json — "Total Amt Payable : 79.50" */
    "lan": "total amt incl. gst",         /* 075.json — "Total Amt Incl. GST 6% : 159.00" */
    "ikano": "total rm including",        /* 088.json — "Total RM Including 6% 99.80" */
    "hon": "total inclusive gst"          /* 080.json — "Total Inclusive GST: 10.40" */
  }
};

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
const PAY_URL = "";  /* WEB PWA ONLY — the Play build never opens it (Payments policy) */
const PRICE_LABEL = "RM 6.99 / month or RM 79 / year"; /* base price in MYR for ALL countries (final, 24 Aug 2026) — Play converts and shows each user their local equivalent live on Android */
/* Play Billing (Android, via RevenueCat — Phase 18). REVENUECAT_ANDROID_API_KEY
   is the PUBLIC SDK key from the RevenueCat dashboard (Project settings > API
   keys > Google Play Store; RevenueCat project "Recap", app
   com.promaxdigita.recap, issued 15 Aug 2026) — safe to embed client-side;
   it can only start a purchase, never grant entitlement by itself
   (RevenueCat verifies every purchase server-side against Google Play).
   REVENUECAT_ENTITLEMENT_ID must match the entitlement identifier configured
   in that same dashboard. billingConfigured() keeps every native billing
   call inert while the key is empty, same convention as PAY_URL above.
   PLAY_SUBSCRIPTION_ID is the Play Console subscription product id (ONE
   subscription "pro" with monthly + annual base plans — STORE-LISTING §8);
   it only feeds the "Manage subscription" deep link.
   PLAY_BILLING_LIVE is a MANUAL switch, deliberately not derived from the
   key: it drives the WEB copy ("Get Pro in the Android app") and must flip
   to true only once the Play release that sells Pro is in PRODUCTION —
   the key is present in internal-testing builds long before that. */
const REVENUECAT_ANDROID_API_KEY = "goog_KtDxtNEiIsvzipVNzuhQkOcFhEi";
const REVENUECAT_ENTITLEMENT_ID = "pro";
const PLAY_SUBSCRIPTION_ID = "pro";
const ANDROID_PACKAGE_ID = "com.promaxdigita.recap";
const PLAY_BILLING_LIVE = false; /* flip to true when the billing build reaches Play production (web-only effect) */
function billingConfigured() { return isNative() && !!REVENUECAT_ANDROID_API_KEY; }
/* LOCAL date/time strings — never toISOString() (UTC), which would flip the
   day near midnight MYT (UTC+8). Shared by every place that needs a
   YYYY-MM-DD / HH:MM string built from a Date: the daily quota key, an
   incoming cloud-merge date, and the confirm sheet's date/time fields all
   used to hand-roll this same formula independently. */
function localDateStr(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function localTimeStr(d) { return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function todayKey() {
  return localDateStr(new Date());
}
/* Pro: paid entitlement — or a PROVEN owner install. ghProven is only set
   after the token successfully reads the owner's PRIVATE inbox repo (a random
   string gets 401, a stranger's own PAT gets 404), so pasting text into the
   token field cannot unlock Pro. */
function isPro() { return !!state.pro || !!state.ghProven || !!state.playEntitled; }
function scansToday() { return state.scanDay === todayKey() ? (state.scanCount || 0) : 0; }
function scanAllowed() { return isPro() || scansToday() < FREE_SCANS_PER_DAY; }
/* Charge-site check (as opposed to scanAllowed(), which gates whether a NEW
   scan may start without first offering an ad): is there still room in
   TODAY's full allowance — free + any ad-unlocked scans — for this read to
   count against? scanAllowed() alone is only bound to the free scan, so an
   ad-unlocked scan (2-5) would never actually increment the counter and the
   5-scan/day ceiling would never be reached; this still protects against an
   overlapping scan double-charging once the full daily allowance is spent. */
function scanChargeAllowed() { return isPro() || scansToday() < FREE_SCANS_PER_DAY + AD_SCANS_PER_DAY; }
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
  const p = $("upgrade-price"); if (p) { p.textContent = PRICE_LABEL; p.hidden = false; }
  const buy = $("upgrade-buy"), picker = $("upgrade-plans"), restore = $("upgrade-restore"), terms = $("upgrade-terms");
  const show = (el, on) => { if (el) el.hidden = !on; };
  /* Nothing pre-chosen by a previous visit — the trial-carrying plan leads
     every time the sheet opens. */
  _planPick = ""; _planChooser = false; _planData = null;
  show(picker, false);
  if (billingReady()) {
    /* Android with Play Billing: both plans as selectable cards with ONE CTA
       under them, plus Restore. If an offering was already fetched this
       session, paint it synchronously (so the cards open with real prices
       already on them); otherwise the markup's static labels show for the
       tick before refreshUpgradeOffer() lands the REAL Play prices/trial
       (localized, eligibility-aware) and repaints. */
    if (buy) { buy.textContent = "Go Pro"; delete buy.dataset.plan; }
    if (terms) terms.textContent = "Subscription auto-renews until cancelled in Google Play → Subscriptions. Cancel any time.";
    show(buy, true); show(restore, true); show(terms, true);
    if (_lastOffering) paintUpgradeOffer(_lastOffering);
    _offerPending = refreshUpgradeOffer();
  } else if (isNative()) {
    /* Play build WITHOUT a working Play purchase (dormant key, plugin missing,
       configure failed offline). Play Payments policy: never point at an
       outside checkout, never mention one, and don't show a price we can't
       sell at — so no CTA, no price line, just a neutral note. Redeem-a-code
       stays (an entitlement check, not a purchase path). */
    show(buy, false); show(restore, false); if (p) p.hidden = true;
    if (terms) terms.textContent = billingConfigured()
      ? "Google Play purchases aren't available right now — check your connection and try again later."
      : "Pro subscriptions are coming to Google Play soon.";
    show(terms, true);
  } else {
    /* Web PWA: web checkout if wired; otherwise point at the Android app only
       once the shipped Play build really sells Pro; otherwise "coming soon".
       No chooser here — the web has no live prices to choose between. */
    if (buy) buy.textContent = PAY_URL ? "Go Pro" : PLAY_BILLING_LIVE ? "Get Pro in the Android app" : "Go Pro";
    show(buy, true); show(restore, false); show(terms, false);
  }
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
      toast("Welcome to Pro — everything's unlocked");
    } else {
      toast("That code didn't work");
    }
  } catch (e) { toast("Couldn't verify the code"); }
}

/* Play Billing via RevenueCat (Phase 18, Android only — the web PWA keeps
   the PAY_URL/license-key paths above; Play policy requires in-app digital
   goods sold inside an Android app to go through Play Billing). isPro()
   ORs this in. window.Capacitor.Plugins.Purchases is the RevenueCat
   Capacitor plugin's real native registration name (verified against its
   source: @CapacitorPlugin(name = "Purchases")) — same window.Capacitor.
   Plugins.X pattern as this file's existing Camera/Filesystem/Share calls,
   not an ES import (this app has no bundler to resolve one). */
function billingReady() {
  return billingConfigured() && !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases);
}
function rcPlugin() { return window.Capacitor.Plugins.Purchases; }
/* Error codes the plugin puts on e.code — as STRINGS, because Capacitor's
   reject(message, code, data) stringifies them; e.data carries RevenueCat's
   info map ({userCancelled, readableErrorCode, …}). Verified against
   purchases-capacitor 13.4.0 / purchases-hybrid-common 18.29.0. */
const RC_ERR = { CANCELLED: "1", ALREADY_IN_PROGRESS: "15", PAYMENT_PENDING: "20" };
function rcCode(e) { return e && e.code != null ? String(e.code) : ""; }
function rcCancelled(e) { return rcCode(e) === RC_ERR.CANCELLED || !!(e && e.data && e.data.userCancelled); }
let _billingConfigured = false, _billingInit = null, _billingBusy = false;
async function initBilling() {
  if (!billingReady() || _billingConfigured) return;
  if (_billingInit) return _billingInit;
  _billingInit = (async () => {
    try {
      /* configure() is a fire-and-forget native method (RETURN_NONE) — the
         await resolves before native runs — but plugin calls are FIFO on one
         native thread and configure is synchronous, so isConfigured() right
         after tells the truth. */
      await rcPlugin().configure({ apiKey: REVENUECAT_ANDROID_API_KEY });
      let ok = true;
      try { const r = await rcPlugin().isConfigured(); ok = !r || r.isConfigured !== false; } catch (e) {}
      if (!ok) return;
      _billingConfigured = true;
      /* Push channel: the SDK calls this with the current info on
         registration and again after every background refresh, renewal,
         expiry, refund or pending-payment completion. It is what downgrades a
         lapsed subscriber while the app stays resident, and what lights Pro
         up when a pending Play payment clears. Callback-style plugin method
         (RETURN_CALLBACK): (options, callback); the payload is the
         CustomerInfo map itself (not wrapped) — applyCustomerInfo accepts
         either shape. */
      try { rcPlugin().addCustomerInfoUpdateListener({}, info => { if (info) applyCustomerInfo(info); }); } catch (e) {}
      await refreshPlayEntitlement();
    } catch (e) { /* offline or misconfigured — keep the last persisted entitlement; the next call retries */ }
    finally { _billingInit = null; }
  })();
  return _billingInit;
}
async function ensureBilling() {
  if (!billingReady()) return false;
  if (!_billingConfigured) await initBilling();
  return _billingConfigured;
}
/* Single writer for state.playEntitled — from getCustomerInfo, from a
   purchase/restore result, or from the update listener. Only entitlements in
   `.active` count (the SDK computes activity against expiry, so a lapsed
   subscription drops out even from cache). Also remembers Play's
   management URL for the Settings link. */
async function applyCustomerInfo(payload) {
  const ci = payload && payload.customerInfo ? payload.customerInfo : payload;
  const ent = ci && ci.entitlements && ci.entitlements.active && ci.entitlements.active[REVENUECAT_ENTITLEMENT_ID];
  const active = !!ent;
  if (ci && typeof ci.managementURL === "string") state.playManageUrl = ci.managementURL;
  if (active !== state.playEntitled) {
    state.playEntitled = active;
    await DB.setSetting("playEntitled", active);
    refreshProUi();
  } else if (state.view === "settings") renderPlan();
  return active;
}
/* Re-reads the Play entitlement (SDK cache first, background refresh —
   whose result then arrives through the update listener). Called on launch,
   on every foreground, after purchase and after restore. */
async function refreshPlayEntitlement() {
  if (!(await ensureBilling())) return !!state.playEntitled;
  try { const { customerInfo } = await rcPlugin().getCustomerInfo(); return await applyCustomerInfo(customerInfo); }
  catch (e) { return !!state.playEntitled; } /* network hiccup — never downgrade a real subscriber on an error */
}
/* Everything that draws Pro-vs-free: the ledger's claim pills/owed line, the
   Insights radar teaser, Settings' plan card, and the sheet itself. */
function refreshProUi() {
  renderPlan();
  if (state.view === "home") renderHome();
  else if (state.view === "insights") renderInsights();
  const ov = $("upgrade-overlay");
  if (ov && !ov.hidden && isPro()) ov.hidden = true;
}
function playManageUrl() {
  return state.playManageUrl || ("https://play.google.com/store/account/subscriptions?sku=" + PLAY_SUBSCRIPTION_ID + "&package=" + ANDROID_PACKAGE_ID);
}
function setUpgradeBusy(on) {
  for (const id of ["upgrade-buy", "upgrade-plan-monthly", "upgrade-plan-annual",
                    "upgrade-restore", "plan-restore"]) {
    const el = $(id); if (el) el.disabled = on;
  }
}

/* ---------- Plan chooser (upgrade sheet) ----------
   Design-refresh mockup 05, approved 24 Aug 2026: the sheet shows both plans
   at once as radio-style cards, pre-selects the one carrying the free trial,
   and re-labels ONE CTA underneath for whichever card is selected.
   _planChooser: the live offering really has two plans to choose between.
   _planPick: which card is selected — sticky across the repaint that a late
   getOfferings() triggers, so a choice never jumps under the user's thumb. */
let _lastOffering = null, _planChooser = false, _planPick = "", _planData = null;
/* The in-flight getOfferings() for the sheet that is open. A tap that lands
   before it resolves waits for it instead of being told "not available" —
   see the CTA handler. */
let _offerPending = null;

/* Price as a NUMBER in major units (6.99, 79) — used only to work out the
   annual saving, never to display anything. priceString is localized display
   text ("RM 79.00", "1.234,50 kr", "¥780") and parsing it is fragile, so read
   the figure the store itself handed us first: a Play pricing phase carries
   price.amountMicros (1e6 micros = one major unit) and StoreProduct.price is
   already a plain number. Digging digits out of the string is the last
   resort, and a wrong guess there costs only the badge — never a price anyone
   is shown or charged. 0 = unknown, which suppresses the badge entirely. */
function pkgPriceObj(pkg) {
  const pr = pkg && pkg.product; if (!pr) return null;
  const opt = pr.defaultOption;
  return (opt && opt.fullPricePhase && opt.fullPricePhase.price) ||
         (pr.price && typeof pr.price === "object" ? pr.price : null) ||
         (pr.oneTimePurchasePrice || null);
}
function pkgAmount(pkg) {
  const po = pkgPriceObj(pkg);
  const micros = po && Number(po.amountMicros);
  if (micros > 0) return micros / 1e6;
  const flat = pkg && pkg.product && pkg.product.price;
  if (typeof flat === "number" && flat > 0) return flat;
  return parsePriceAmount((pkg && pkg.product && pkg.product.priceString) || "");
}
function pkgCurrency(pkg) {
  const po = pkgPriceObj(pkg);
  return (po && po.currencyCode) || (pkg && pkg.product && pkg.product.currencyCode) || "";
}
/* Last-resort localized-string parse. The final "." or "," is a DECIMAL point
   only when 1-2 digits follow it — that is what separates "1.234,50" (kr) and
   "1,234.50" (US) from "45.000" (rupiah) and "1,234" (thousands). */
function parsePriceAmount(s) {
  const t = String(s).replace(/[^\d.,]/g, "");
  if (!t) return 0;
  const sep = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  let whole = t, frac = "";
  if (sep > -1 && /^\d{1,2}$/.test(t.slice(sep + 1))) { whole = t.slice(0, sep); frac = t.slice(sep + 1); }
  const n = Number(whole.replace(/[.,]/g, "") + (frac ? "." + frac : ""));
  return isFinite(n) && n > 0 ? n : 0;
}

/* Read a RevenueCat offering into the two plans the sheet knows about.
   defaultOption is what purchasePackage() actually buys — the longest
   eligible free trial, else the base plan — and Play omits offers this
   Google account is NOT eligible for, so a freePhase here means the trial is
   genuinely on the table for this user. */
function upgradePlans(cur) {
  const priceStr = pkg => (pkg && pkg.product && pkg.product.priceString) || "";
  const trialDays = pkg => {
    const ph = pkg && pkg.product && pkg.product.defaultOption && pkg.product.defaultOption.freePhase;
    const bp = ph && ph.billingPeriod; if (!bp) return 0;
    const v = Number(bp.value) || 0;
    return bp.unit === "DAY" ? v : bp.unit === "WEEK" ? v * 7 : bp.unit === "MONTH" ? v * 30 : bp.unit === "YEAR" ? v * 365 : 0;
  };
  const mk = (pkg, per, label, sub) => ({
    ok: !!(pkg && priceStr(pkg)), price: priceStr(pkg), trial: trialDays(pkg),
    amount: pkgAmount(pkg), currency: pkgCurrency(pkg), per, label, sub
  });
  return {
    monthly: mk(cur && cur.monthly, "month", "Monthly", "Billed every month"),
    annual: mk(cur && cur.annual, "year", "Annual", "Billed once a year")
  };
}
/* "Save N%" from the LIVE prices only: (monthly*12 - annual) / (monthly*12).
   Suppressed unless both amounts are known, both are quoted in the SAME
   currency (Play localizes each package on its own, so a mismatch makes the
   comparison meaningless) and the result is actually positive. */
function annualSavingPct(plans) {
  const m = plans.monthly, a = plans.annual;
  if (!(m.ok && a.ok && m.amount > 0 && a.amount > 0)) return 0;
  if (m.currency && a.currency && m.currency !== a.currency) return 0;
  const full = m.amount * 12;
  const pct = Math.round((full - a.amount) / full * 100);
  return pct > 0 ? pct : 0;
}
/* Which plan leads — first card and pre-selected: the one carrying the free
   trial when exactly one does (Play Console has the trial on annual only,
   16 Aug 2026), else the one that actually saves money, else monthly. */
function leadPlan(plans, saving) {
  if (plans.annual.ok && plans.annual.trial && !plans.monthly.trial) return "annual";
  if (plans.monthly.ok && plans.monthly.trial && !plans.annual.trial) return "monthly";
  if (saving > 0 && plans.annual.ok) return "annual";
  return plans.monthly.ok ? "monthly" : "annual";
}
function trialPhrase(days) { return days + (days === 1 ? " day" : " days"); }
/* The CTA and the disclosure under it both describe the SELECTED plan — Play
   subscriptions policy wants the trial length, the price after it, the
   billing period, the auto-renewal and how to cancel in the offer itself,
   not merely in small print somewhere. An annual plan is never restated as a
   per-month figure. */
function paintPlanCta(plan) {
  const buy = $("upgrade-buy"), terms = $("upgrade-terms");
  if (buy) {
    buy.textContent = plan.trial ? "Try Pro free for " + trialPhrase(plan.trial)
                                 : "Go Pro — " + plan.price + " / " + plan.per;
  }
  if (terms) {
    terms.textContent = (plan.trial ? "Free for " + trialPhrase(plan.trial) + ", then " + plan.price + " / " + plan.per + "."
                                    : plan.price + " / " + plan.per + ".") +
      " Auto-renews until cancelled in Google Play → Subscriptions. Cancel any time.";
    terms.hidden = false;
  }
}
function selectPlan(key) {
  _planPick = key;
  for (const k of ["monthly", "annual"]) {
    const card = $("upgrade-plan-" + k);
    const on = k === key && !!(card && !card.hidden);
    if (card) { card.classList.toggle("sel", on); card.setAttribute("aria-checked", on ? "true" : "false"); }
  }
  /* Read the plans the last paint computed, never a re-derivation from a
     global — the CTA under the cards must describe the card that is lit. */
  const plan = _planData && _planData[key];
  if (plan && plan.ok) paintPlanCta(plan);
}
/* One card: live price, its own billing period, and the badges that ride its
   top edge — teal for a free trial THIS Google account is eligible for, gold
   for the computed annual saving. */
function paintPlanCard(key, plan, saving, anyTrial) {
  const card = $("upgrade-plan-" + key);
  if (!card) return;
  card.hidden = !plan.ok;
  if (!plan.ok) return;
  const pr = $("upgrade-price-" + key); if (pr) pr.textContent = plan.price;
  const per = $("upgrade-per-" + key); if (per) per.textContent = "/ " + plan.per;
  /* "No free trial" only says something when a rival plan actually has one. */
  const sub = $("upgrade-sub-" + key);
  if (sub) sub.textContent = (anyTrial && !plan.trial) ? "No free trial" : plan.sub;
  const trial = $("upgrade-trial-" + key);
  if (trial) {
    trial.textContent = plan.trial ? trialPhrase(plan.trial).toUpperCase() + " FREE" : "";
    trial.hidden = !plan.trial;
  }
  const save = $("upgrade-save-" + key);
  const saveOn = !!save && key === "annual" && saving > 0;
  if (save) { save.textContent = saveOn ? "SAVE " + saving + "%" : ""; save.hidden = !saveOn; }
  const bdg = $("upgrade-bdg-" + key);
  if (bdg) bdg.hidden = !(plan.trial || saveOn);
}
/* Paint the sheet from a RevenueCat offering: Play-localized prices and,
   only when THIS Google account is eligible, the free trial. Two plans =
   the chooser, with the leading card first and pre-selected. One plan = no
   chooser (a radio group of one is just noise) and the CTA buys it directly.
   None = no dead buttons at all. */
function paintUpgradeOffer(cur) {
  const buy = $("upgrade-buy"), picker = $("upgrade-plans"), p = $("upgrade-price");
  const terms = $("upgrade-terms");
  const plans = upgradePlans(cur);
  _planData = plans;
  const saving = annualSavingPct(plans);
  const avail = ["monthly", "annual"].filter(k => plans[k].ok);
  if (!avail.length) { /* offering has neither package (dashboard not finished) — no dead buttons */
    _planChooser = false;
    if (buy) buy.hidden = true;
    if (picker) picker.hidden = true;
    if (p) p.hidden = true;
    if (terms) { terms.textContent = "Pro plans aren't available right now — please try again later."; terms.hidden = false; }
    return;
  }
  const anyTrial = avail.some(k => plans[k].trial);
  for (const k of ["monthly", "annual"]) paintPlanCard(k, plans[k], saving, anyTrial);
  _planChooser = avail.length > 1;
  if (buy) buy.hidden = false;
  if (_planChooser) {
    const lead = leadPlan(plans, saving), other = lead === "annual" ? "monthly" : "annual";
    /* appendChild MOVES an existing node, so this just reorders the two cards
       — the leading plan always sits first. */
    if (picker) { picker.appendChild($("upgrade-plan-" + lead)); picker.appendChild($("upgrade-plan-" + other)); picker.hidden = false; }
    if (buy) delete buy.dataset.plan;
    /* The cards carry the prices, so the sheet's own price line would only
       repeat them — mockup 05 has no such line. */
    if (p) p.hidden = true;
    selectPlan(plans[_planPick] && plans[_planPick].ok ? _planPick : lead);
  } else {
    const only = avail[0], O = plans[only];
    if (picker) picker.hidden = true;
    if (buy) buy.dataset.plan = only;
    paintPlanCta(O);
    if (p) { p.textContent = O.price + " / " + O.per; p.hidden = false; }
  }
}
async function refreshUpgradeOffer() {
  /* No offering came back — the RevenueCat dashboard has no CURRENT offering
     yet, or the fetch failed (offline on a first open). The sheet is sitting
     on the static "Go Pro" that showUpgrade() painted, and that button has no
     plan to buy: tapping it would do nothing at all. So fall back to the same
     neutral "not available" state an empty offering already gets, which hides
     the CTA rather than leaving a dead one.
     Only when nothing real was EVER painted: a transient miss must not wipe
     live prices the user is already looking at. */
  const blank = () => {
    const ov = $("upgrade-overlay");
    if (!_lastOffering && ov && !ov.hidden) paintUpgradeOffer(null);
  };
  /* Billing never came up (configure()/isConfigured() failed). That used to
     return here and leave the static "Go Pro" standing with no plan behind
     it — the same dead button 1.30.1 removed for the no-offering case. */
  if (!(await ensureBilling())) { blank(); return; }
  try {
    const offerings = await rcPlugin().getOfferings();
    const cur = offerings && offerings.current;
    if (!cur) { blank(); return; }
    _lastOffering = cur; /* next showUpgrade paints this synchronously — no static-price flash on reopen */
    const ov = $("upgrade-overlay");
    if (!ov || ov.hidden) return;
    paintUpgradeOffer(cur);
  } catch (e) { blank(); }
}
/* plan: "monthly" | "annual" — the standard package types RevenueCat exposes
   on the current offering (offerings.current.monthly / .annual). Trial terms
   live in Play Console; the app honours whatever Play/RevenueCat report. */
async function purchasePro(plan) {
  /* The in-flight guard claims the slot BEFORE the first await, so two taps
     dispatched in the same task can't both get past it — ensureBilling() is
     async, and anything checked before it yields is checked twice. */
  if (_billingBusy) return;
  _billingBusy = true; setUpgradeBusy(true);
  try {
    if (!(await ensureBilling())) { toast(isNative() ? "Google Play isn't reachable — try again shortly" : "Play Billing isn't set up yet"); return; }
    const offerings = await rcPlugin().getOfferings();
    const pkg = offerings && offerings.current && offerings.current[plan];
    if (!pkg) { toast("That plan isn't available right now"); return; }
    const res = await rcPlugin().purchasePackage({ aPackage: pkg });
    /* Judge success by the PLAY entitlement itself, never isPro() — on the
       owner install (ghProven) or a licence-key device isPro() is already
       true and would mask a dashboard mismatch (entitlement id, product not
       attached) that a real customer would then hit. */
    let active = res && res.customerInfo ? await applyCustomerInfo(res.customerInfo) : false;
    if (!active) active = await refreshPlayEntitlement();
    if (active) {
      const ov = $("upgrade-overlay"); if (ov) ov.hidden = true;
      toast("Welcome to Pro — everything's unlocked");
    } else {
      toast("Paid, but Pro didn't unlock yet — tap Restore purchases in a minute");
    }
  } catch (e) {
    const code = rcCode(e);
    if (rcCancelled(e) || code === RC_ERR.ALREADY_IN_PROGRESS) return; /* closed the Play sheet / double-tap — silent */
    if (code === RC_ERR.PAYMENT_PENDING) { /* cash / bank-transfer style payment: Play confirms later, the update listener unlocks Pro then */
      const ov = $("upgrade-overlay"); if (ov) ov.hidden = true;
      toast("Payment pending — Pro unlocks once Google confirms it"); return;
    }
    toast("Purchase didn't go through — try again");
  } finally { _billingBusy = false; setUpgradeBusy(false); }
}
async function restorePlayPurchases() {
  if (_billingBusy) return;  /* same pre-await claim as purchasePro() */
  _billingBusy = true; setUpgradeBusy(true);
  try {
    if (!(await ensureBilling())) { toast("Google Play isn't reachable — try again shortly"); return; }
    const res = await rcPlugin().restorePurchases();
    const active = res && res.customerInfo ? await applyCustomerInfo(res.customerInfo) : await refreshPlayEntitlement();
    if (active) { const ov = $("upgrade-overlay"); if (ov) ov.hidden = true; }
    toast(active ? "Pro restored" : "No Recap Pro subscription on this Google account");
  } catch (e) { toast("Couldn't check for previous purchases"); }
  finally { _billingBusy = false; setUpgradeBusy(false); }
}

function renderPlan() {
  const status = $("plan-status");
  const btn = $("plan-btn");
  if (isPro()) {
    if (status) status.textContent = (state.playEntitled ? "Pro via Google Play" : "Pro") + " — every limit removed. Thank you for backing Recap.";
    if (btn) btn.hidden = true;
  } else {
    if (status) status.textContent = "Free — " + FREE_SCANS_PER_DAY + " scanned receipt a day (" +
      (scanAllowed() ? "today's is ready" : "used for today — back tomorrow") + "), plus unlimited manual entries. " +
      "Pro removes every limit.";
    if (btn) { btn.hidden = false; btn.textContent = "Upgrade to Pro"; }
  }
  /* Play policy: an in-app way to manage/cancel the subscription (Play's
     Subscription Center deep link). Restore stays reachable from Settings
     whenever Play Billing exists — even on a device that is already Pro by
     other means (owner install, licence key), which is also how the owner
     exercises the wiring without a fresh install. */
  const manage = $("plan-manage"), restore = $("plan-restore");
  if (manage) { manage.hidden = !state.playEntitled; manage.href = playManageUrl(); }
  if (restore) restore.hidden = !billingReady();
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
  const when = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString(appLocale(), { hour: "2-digit", minute: "2-digit" }) : "";
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
  const shareWrap = $("share-field");
  if (!wrap) return;
  if (!cloudEndpoint()) { wrap.hidden = true; if (shareWrap) shareWrap.hidden = true; return; }
  wrap.hidden = false;
  const on = state.cloudConsent === "yes";
  const btn = $("cloud-toggle");
  const status = $("cloud-status");
  if (btn) btn.textContent = on ? "Turn off" : "Turn on";
  if (status) status.textContent = on ? "On" : "Off — receipts stay on your phone";
  /* Sharing is reachable only when cloud reading is on; default is on. */
  if (shareWrap) {
    shareWrap.hidden = !on;
    const sharing = state.shareRules !== "no";
    const sbtn = $("share-toggle");
    const sstatus = $("share-status");
    if (sbtn) sbtn.textContent = sharing ? "Turn off" : "Turn on";
    if (sstatus) sstatus.textContent = sharing ? "On — thank you for helping" : "Off — nothing is shared";
  }
}

/* The Claude-inbox block is owner plumbing — invisible unless a token is
   already saved. On a fresh owner device: tap the version line in Settings
   7 times to reveal it. */
function renderInboxSetting() {
  const wrap = $("inbox-field");
  if (wrap) wrap.hidden = !(state.ghToken || state._inboxReveal);
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
  /* syncInbox no-ops while a sync is already running — saying "Up to date"
     then would be a lie. */
  if (inboxSyncing) { toast("Still checking…"); return; }
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
  /* Instant reads (cloud AI) fill scans on the spot now — a late Claude result
     for an expense that is no longer pending must never overwrite what the
     user already confirmed. Consume it so the result file gets cleaned up. */
  if (e && !e.pending) return true;
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
    const b = brandOf(normMerchant(data.merchant));
    const preferred = safeGet(state.merchantNames, b) || safeGet(SEED_RULES.names, b);
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
  const known = safeGet(state.merchantCats, n);
  if (known) return known;
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
  if (!b || b.length < 3 || !allScopes().includes(scope)) return;
  const cur = safeGet(state.merchantScopes, b);
  state.merchantScopes[b] = cur && cur.scope === scope ? { scope, n: cur.n + 1 } : { scope, n: 1 };
  DB.setSetting("merchantScopes", state.merchantScopes);
}

function scopeRuleFor(merchant) {
  const rule = safeGet(state.merchantScopes, brandOf(normMerchant(merchant || "")));
  return rule && rule.n >= 2 && allScopes().includes(rule.scope) ? rule.scope : null;
}

/* Learning is fully self-managed since 1.6.0 (Adrian's call): the rule
   stores (merchantCats/Scopes/Names, totalHints) keep teaching themselves
   from saves, corrections and cloud reads — there is no inspection UI. */

/* ---------- Learning from corrections ----------
   When a scanned field is corrected before saving, remember the lesson:
   - the name you prefer for this shop
   - which line of this shop's receipts carries the real total */

/* Shared by learnFromCorrections (a user-confirmed total) and learnFromAI
   (a cloud-confirmed total): find the receipt line carrying this amount
   and pull a keyword out of it, to remember where THIS shop prints its
   total. Returns null if no matching line, or the keyword's too short. */
function extractHintKeyword(rawText, amount) {
  if (!rawText || !(amount > 0)) return null;
  const f = amount.toFixed(2);
  const variants = [f, f.replace(".", " "), f.replace(".", ","), f.replace(/\.00$/, "")];
  let hintLine = null;
  for (const line of rawText.split("\n")) {
    if (variants.some(v => v && line.includes(v))) { hintLine = line; break; }
  }
  if (!hintLine) return null;
  const kw = (hintLine.match(/[A-Za-z][A-Za-z .]{3,24}/) || [""])[0].trim().toLowerCase();
  return kw.length >= 4 ? kw : null;
}

function learnFromCorrections(e, record) {
  if (!e.fromReceipt) return;
  const parsedBrand = brandOf(normMerchant(e._parsedMerchant || ""));
  if (parsedBrand.length >= 3 && record.merchant && record.merchant !== e._parsedMerchant) {
    state.merchantNames[parsedBrand] = record.merchant;
    DB.setSetting("merchantNames", state.merchantNames);
  }
  if (e._rawText && record.amount > 0 && Math.abs((e._parsedTotal || 0) - record.amount) > 0.005) {
    const kw = extractHintKeyword(e._rawText, record.amount);
    if (kw && parsedBrand.length >= 3) {
      state.totalHints[parsedBrand] = kw;
      DB.setSetting("totalHints", state.totalHints);
      toast("Noted — Recap now knows where " + (record.merchant || "this shop") + " prints its total");
    }
  }
}

function applyLearnedTotalHint(parsed) {
  const brand = brandOf(normMerchant(parsed.merchant || ""));
  const hint = safeGet(state.totalHints, brand) || safeGet(SEED_RULES.hints, brand);
  if (!hint || !parsed.rawText) return;
  const line = parsed.rawText.split("\n").find(l => l.toLowerCase().includes(hint));
  if (!line) return;
  const amt = window.ReceiptOCR.amountFromLine(line);
  if (amt && (parsed.total === null || (parsed.totalConf || 0) <= 1)) {
    parsed.total = amt;
    /* A hint hit is a confident recovery — good enough that the cloud
       fallback isn't consulted. This is what lets learning reduce cloud use. */
    parsed.totalConf = 2;
  }
}

/* On-device reading learns from every cloud read: the AI's answers become
   the same locally-stored rules a user correction would teach (shop name,
   category, and WHERE this shop prints its total), so the phone reads more
   receipts by itself over time. AI never overwrites a rule that already
   exists — user corrections stay authoritative. */
function learnFromAI(rawText, ai, localTotal, localMerchant) {
  if (!ai || ai.readable === false || !rawText) return;
  const localBrand = brandOf(normMerchant(localMerchant || ""));
  const aiBrand = brandOf(normMerchant(ai.merchant || ""));
  /* 1. The OCR's garbled shop name now maps to the AI's clean one. */
  if (localBrand.length >= 3 && ai.merchant && ai.merchant.length >= 2 && !safeGet(state.merchantNames, localBrand)) {
    state.merchantNames[localBrand] = ai.merchant;
    DB.setSetting("merchantNames", state.merchantNames);
    /* Stage this AI-derived name mapping for the shared pool. clean is ALWAYS
       ai.merchant (this read) — never state.merchantNames[...], which can hold
       a user-typed correction (privacy invariant #1). */
    queueSharedRule(localBrand, ai.merchant, "");
  }
  /* 2. Category rule for the shop (a later user correction overwrites it). */
  if (ai.merchant && isRealCategory(ai.category) &&
      !safeGet(state.merchantCats, normMerchant(ai.merchant))) {
    rememberMerchantCategory(ai.merchant, ai.category);
  }
  /* 3. The core lesson: find the OCR line carrying the AI's total and keep
     that line's keyword as this shop's total hint — filed under BOTH the
     AI's brand and the OCR's brand, since the next scan only knows the
     OCR's (possibly garbled) name. */
  if (!(ai.total > 0)) return;
  if (localTotal !== null && Math.abs(localTotal - ai.total) <= 0.005) return; /* on-device already had it */
  const kw = extractHintKeyword(rawText, ai.total);
  if (!kw) return;
  let saved = false;
  for (const b of new Set([aiBrand, localBrand])) {
    if (b.length >= 3 && !safeGet(state.totalHints, b)) { state.totalHints[b] = kw; saved = true; }
  }
  if (saved) DB.setSetting("totalHints", state.totalHints);
  /* Stage the AI-derived total-line keyword for the pool, keyed by the OCR
     token a future device will actually see (localBrand). Replaces any queued
     name-only row for the same token (dedupe by garbled). */
  if (saved) queueSharedRule(localBrand, ai.merchant, kw);
}

/* Outbox for the shared learning loop: when learnFromAI saves a NEW rule, stage
   the AI-derived triple {garbled OCR token, clean name, total-line keyword} for
   the weekly, consent-gated, best-effort upload. Everything here originates in
   the current cloud read — NEVER user-typed text and never learnFromCorrections
   (privacy invariant #1); no ids, amounts, dates or images ever go in. Capped at
   25, deduped by garbled token, drop-oldest. See SHARED-RULES-PLAN.md. */
function queueSharedRule(garbled, clean, hint) {
  garbled = String(garbled || "").trim();
  clean = String(clean || "").trim();
  hint = String(hint || "").trim();
  if (garbled.length < 3 || !clean) return;
  if (!Array.isArray(state.shareQueue)) state.shareQueue = [];
  const q = state.shareQueue.filter(r => r && r.garbled !== garbled);
  q.push({ garbled: garbled.slice(0, 64), clean: clean.slice(0, 64), hint: hint.slice(0, 64) });
  while (q.length > 25) q.shift();
  state.shareQueue = q;
  DB.setSetting("shareQueue", state.shareQueue);
}

function viewedMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + state.monthOffset, 1);
}

/* Amounts always carry the display currency (second arg kept for old call
   sites; it no longer changes anything). */
/* Profile country -> the locale used for every date/number format. */
const COUNTRY_LOCALES = { MY: "en-MY", SG: "en-SG", ID: "id-ID", TH: "th-TH", PH: "en-PH", VN: "vi-VN", BN: "ms-BN", IN: "en-IN", AU: "en-AU", GB: "en-GB", US: "en-US", OT: "en-MY" };
function appLocale() { return safeGet(COUNTRY_LOCALES, state.country) || "en-MY"; }

function fmtRM(n, _withSign) {
  const s = (Math.round(n * 100) / 100).toLocaleString(appLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return state.currency + " " + s;
}

/* Budget comparisons involve summed user-entered money values that can carry
   IEEE-754 drift (e.g. 9.90+2.20 !== 12.10 by ~1e-15) — spend that exactly
   equals the budget must never read as "over". A tenth-of-a-cent epsilon
   absorbs that drift without masking any real difference (amounts only ever
   carry 2 decimal places). */
const MONEY_EPS = 0.001;
function moneyGT(a, b) { return a > b + MONEY_EPS; }

/* Parses a user-typed amount respecting the active locale's decimal
   separator. id-ID/vi-VN/ms-BN (and others) use "," as the decimal point
   and "." as a thousands separator — the opposite of en-*. fmtRM already
   DISPLAYS every amount in that convention for those locales, so a blind
   "keep only digits and the literal '.'" strip on the way back in would
   delete a typed "45,50" down to "4550" — a silent ~100x error. */
function parseAmountInput(raw) {
  let s = (raw || "").trim();
  if (!s) return NaN;
  const commaIsDecimal = (1.1).toLocaleString(appLocale()).indexOf(",") > -1;
  s = commaIsDecimal ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  return parseFloat(s.replace(/[^\d.\-]/g, ""));
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
        /* t.every = interval in months (1 = monthly, 12 = yearly). */
        const nxt = new Date(y, mo - 1 + (t.every || 1), 1);
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
    const freq = (t.every || 1) === 1 ? "monthly" : (t.every === 12 ? "yearly" : "every " + t.every + " mo");
    span.textContent = t.merchant + " · " + fmtRM(t.amount, true) + " · " + freq + ", day " + (t.day || 1);
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
  /* Split into whole/cents from the raw NUMBER, not by slicing fmtRM's
     locale-formatted string on "." — id-ID/vi-VN/ms-BN use "," as the
     decimal separator (and "." as a thousands separator), so a text split
     on "." either finds no "." at all (→ "undefined" rendered on screen)
     or splits on the thousands separator instead. */
  const totalRounded = Math.round(total * 100) / 100;
  const totalWhole = Math.trunc(Math.abs(totalRounded));
  const totalCents = Math.round((Math.abs(totalRounded) - totalWhole) * 100);
  const whole = (totalRounded < 0 ? "-" : "") + totalWhole.toLocaleString(appLocale());
  const cents = String(totalCents).padStart(2, "0");
  $("month-total").innerHTML = `<span class="cur-prefix">${escapeHtml(state.currency)}</span> ${whole}<span class="cents">.${cents}</span>`;

  /* Hero: REMAINING | TOTAL BUDGET columns + a status bar with the budget
     percentage written inside it ("42% OF BUDGET USED").
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
    fill.style.background = scopeFill(state.scopeFilter);
    if (status) status.textContent = state.scopeFilter.toUpperCase() + " · " + share + "% OF MONTH";
  } else {
    fill.style.background = "";
    if (state.budget > 0) {
      /* moneyGT (epsilon-tolerant) — a raw total>budget check falsely reads
         as "over" when total/budget sum to the same amount but drift by a
         float ULP (e.g. 9.90+2.20 !== 12.10). Shared by the remaining-column
         text/class below and the budget-bar fill class further down. */
      const heroOver = moneyGT(total, state.budget);
      if (cols) {
        cols.hidden = false;
        const left = state.budget - total;
        $("hero-remaining").textContent = heroOver ? "−" + fmtRM(total - state.budget) : fmtRM(Math.max(0, left));
        $("hero-remaining-col").classList.toggle("neg", heroOver);
        $("hero-budget").textContent = fmtRM(state.budget);
      }
      if (track) track.hidden = false;
      const pct = Math.min(100, (total / state.budget) * 100);
      fill.style.width = pct + "%";
      fill.classList.toggle("over", heroOver);
      if (status) {
        /* Plain percentage of budget used (can pass 100%); finished months
           read past-tense and future months get a neutral label. */
        const pctUsed = Math.round((total / state.budget) * 100);
        let label;
        if (state.monthOffset < 0) {
          label = "ENDED AT " + pctUsed + "% OF BUDGET";
        } else if (state.monthOffset > 0) {
          label = "UPCOMING MONTH";
        } else {
          label = pctUsed + "% OF BUDGET USED";
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
  /* While a receipt is being read, the ledger leads with a live pending row
     so the scan visibly "exists" without any blocking overlay. */
  if (state.scanning) {
    const r = document.createElement("div");
    r.className = "entry reading";
    r.innerHTML = `<span class="cat-icon">${catIcon("Other")}</span>
      <span class="entry-main">
        <span class="entry-merchant"><span class="merchant-name">Reading receipt…</span></span>
        <span class="entry-cat"><span class="mut">just a moment</span></span>
      </span>
      <span class="entry-amount waiting">…</span>`;
    ledger.appendChild(r);
  }
  const empty = $("empty-note");
  if (!allExps.length && !others.length) {
    empty.hidden = false;
    /* First-run onboarding copy only when the app is truly empty; an empty
       other month just says so. */
    empty.innerHTML = state.expenses.length === 0
      ? "Nothing here yet.<br>Tap the orange camera — your first receipt files itself."
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
      label.textContent = prefix + d.toLocaleDateString(appLocale(), { weekday: "short", day: "numeric", month: "short" });
      ledger.appendChild(label);
    }
    const dup = dupIds.has(e.id) ? `<span class="dup-flag">duplicate?</span>` : "";
    const claim = !isPro() ? "" : e.claimStatus === "to-claim" ? `<span class="claim-pill to">to claim</span>`
      : e.claimStatus === "claimed" ? `<span class="claim-pill done">claimed ✓</span>` : "";
    const odd = unusualIds.has(e.id) ? `<span class="odd-pill">higher than usual</span>` : "";
    const camera = e.photo ? `<span class="has-photo" aria-hidden="true">▦ </span>` : "";
    const sc = scopeOf(e);
    /* "Category | TYPE" account tag, colour-coded. */
    const tag = `<span class="acct-tag ${scopeTag(sc)}">${escapeHtml(e.category)} | ${escapeHtml(sc.toUpperCase())}</span>`;
    const amountHtml = e.pending
      ? `<span class="entry-amount waiting">waiting…</span>`
      : `<span class="entry-amount">${fmtRM(e.amount)}</span>`;
    /* A pending receipt older than a day is probably stuck — invite a manual fill. */
    const stale = e.pending && Date.now() - new Date(e.createdAt || e.date).getTime() > 86400000;
    const pending = e.pending ? `<span class="mut">${stale ? "still waiting — tap to fill it in yourself" : "waiting for Claude"}</span>` : "";
    const note = e.note ? `<span class="mut">${escapeHtml(e.note)}</span>` : "";
    const row = document.createElement("button");
    row.className = "entry";
    const ticked = state.selectMode && state.selected && state.selected.has(e.id);
    if (ticked) row.classList.add("selected");
    row.innerHTML = `
      ${state.selectMode ? `<span class="tick${ticked ? " on" : ""}"></span>` : ""}
      <span class="cat-icon">${catIcon(e.category)}</span>
      <span class="entry-main">
        <span class="entry-merchant">${camera}<span class="merchant-name">${escapeHtml(e.merchant || "Expense")}</span></span>
        <span class="entry-cat">${tag}${claim}${odd}${dup}${pending}${note}</span>
      </span>
      ${amountHtml}`;
    /* Long-press (550ms, ~still finger) deletes with Undo; a normal tap
       opens the expense as before. */
    let lpTimer = null, lpFired = false, lpX = 0, lpY = 0;
    row.addEventListener("pointerdown", ev => {
      lpFired = false; lpX = ev.clientX; lpY = ev.clientY;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpFired = true;
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) {}
        if (!state.selectMode) enterSelectMode(e.id); else toggleSelect(e.id);
      }, 550);
    });
    row.addEventListener("pointermove", ev => {
      if (lpTimer && Math.hypot(ev.clientX - lpX, ev.clientY - lpY) > 12) { clearTimeout(lpTimer); lpTimer = null; }
    });
    for (const evName of ["pointerup", "pointercancel", "pointerleave"])
      row.addEventListener(evName, () => { clearTimeout(lpTimer); lpTimer = null; });
    row.addEventListener("contextmenu", ev => ev.preventDefault());
    row.addEventListener("click", () => {
      if (lpFired) { lpFired = false; return; }
      if (state.selectMode) { toggleSelect(e.id); return; }
      openConfirmSheet(e);
    });
    /* The "duplicate?" flag is actionable: tapping it offers removal with
       the same soft-delete + undo the sheet's Delete button uses. */
    const dupEl = row.querySelector(".dup-flag");
    if (dupEl) dupEl.addEventListener("click", ev => {
      ev.stopPropagation();
      if (state.selectMode) { toggleSelect(e.id); return; }
      state.expenses = state.expenses.filter(x => x.id !== e.id);
      renderCurrent();
      toastAction("Duplicate removed", "Undo",
        () => { state.expenses.push(e); renderCurrent(); },
        async () => { await DB.deleteExpense(e.id); });
    });
    ledger.appendChild(row);
  }

  /* Search history: past-month matches GROUPED by shop, each group headed by
     its visit count + total spent (1.10.0), so searching a shop reads like a
     mini history. Tap a row to open the expense. */
  if (others.length) {
    const label = document.createElement("p");
    label.className = "day-label";
    label.textContent = "Earlier";
    ledger.appendChild(label);
    const groups = {};
    for (const e of others) {
      const key = brandOf(normMerchant(e.merchant)) || ("~" + (e.merchant || "").toLowerCase());
      (groups[key] = groups[key] || { name: e.merchant || "Expense", items: [], total: 0 }).items.push(e);
      groups[key].total += e.amount;
    }
    const ordered = Object.values(groups)
      .sort((a, b) => new Date(b.items[0].date) - new Date(a.items[0].date));
    for (const g of ordered) {
      if (g.items.length > 1) {
        const gh = document.createElement("p");
        gh.className = "group-head";
        gh.textContent = g.name + " · " + g.items.length + " visits · " + fmtRM(g.total, true);
        ledger.appendChild(gh);
      }
      for (const e of g.items) {
        const d = new Date(e.date);
        const sc = scopeOf(e);
        const row = document.createElement("button");
        row.className = "entry";
        row.innerHTML = `
          <span class="cat-icon">${catIcon(e.category)}</span>
          <span class="entry-main">
            <span class="entry-merchant"><span class="merchant-name">${escapeHtml(e.merchant || "Expense")}</span></span>
            <span class="entry-cat"><span class="acct-tag ${scopeTag(sc)}">${escapeHtml(e.category)} | ${escapeHtml(sc.toUpperCase())}</span><span class="mut">${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}</span></span>
          </span>
          <span class="entry-amount">${fmtRM(e.amount)}</span>`;
        row.addEventListener("click", () => openConfirmSheet(e));
        ledger.appendChild(row);
      }
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
    b.innerHTML = `<span class="scope-chip-name">${escapeHtml(label)}</span>`;
    b.addEventListener("click", () => { state.scopeFilter = (state.scopeFilter === value) ? "" : value; redo(); });
    row.appendChild(b);
  };
  mk("All", "", "scope-all");
  for (const s of allScopes()) mk(s, s, scopeClass(s));
}

function renderScopeChips() {
  const e = state.editing;
  if (!e) return;
  const chips = $("scope-chips");
  if (!chips) return;
  const cur = scopeOf(e);
  chips.innerHTML = "";
  /* Always show this expense's own type even if it's legacy (e.g. "Shared")
     or a type the user deselected, so editing never drops it. */
  const opts = allScopes().slice();
  if (!opts.includes(cur)) opts.unshift(cur);
  for (const s of opts) {
    const b = document.createElement("button");
    const sel = s === cur;
    b.className = "chip scope-opt " + scopeClass(s) + (sel ? " selected" : "");
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
  /* "+ New" adds a custom type — a Pro feature (1.10.0). */
  const add = document.createElement("button");
  add.className = "chip scope-opt scope-new";
  add.textContent = "+ New";
  add.addEventListener("click", async () => {
    if (!isPro()) { showUpgrade("Create your own expense types (Family, Side business…) with Pro."); return; }
    const name = addCustomScopePrompt();
    if (!name) return;
    state.editing.scope = name;
    state.editing.userPickedScope = true;
    await DB.setSetting("customScopes", state.customScopes);
    renderScopeChips();
    renderClaimChips();
  });
  chips.appendChild(add);
}

/* Shared "+ New type" helper (sheet + setup). Returns the chosen name, or
   "" if cancelled/invalid. Adds to customScopes if genuinely new. */
function addCustomScopePrompt() {
  const name = (prompt("Name the new type (e.g. Family, Side business)") || "").trim();
  if (!name) return "";
  if (name.length > 14) { toast("Keep it under 14 characters"); return ""; }
  const existing = allScopes().find(s => s.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  state.customScopes.push(name);
  return name;
}

/* Setup wizard: pick which expense types you'll use (Personal/Company/Family
   default all on). Pro can add custom types. Keeps at least one active. */
function renderSetupTypeChips() {
  const row = $("setup-type-chips");
  if (!row) return;
  row.innerHTML = "";
  const active = new Set(state.scopes && state.scopes.length ? state.scopes : DEFAULT_SCOPES);
  for (const s of DEFAULT_SCOPES.concat(state.customScopes)) {
    const b = document.createElement("button");
    b.className = "chip scope-opt " + scopeClass(s) + (active.has(s) ? " selected" : "");
    b.textContent = s;
    b.addEventListener("click", () => {
      const set = new Set(state.scopes);
      if (set.has(s)) { if (set.size <= 1) { toast("Keep at least one type"); return; } set.delete(s); }
      else set.add(s);
      state.scopes = DEFAULT_SCOPES.concat(state.customScopes).filter(x => set.has(x));
      renderSetupTypeChips();
    });
    row.appendChild(b);
  }
  const add = document.createElement("button");
  add.className = "chip scope-opt scope-new";
  add.textContent = "+ Add your own";
  add.addEventListener("click", () => {
    if (!isPro()) { showUpgrade("Create your own expense types (Family, Side business…) with Pro."); return; }
    const name = addCustomScopePrompt();
    if (!name) return;
    if (!state.scopes.includes(name)) state.scopes.push(name);
    renderSetupTypeChips();
  });
  row.appendChild(add);
}

/* Claim status picker — only meaningful for claimable types (Company/Shared). */
function renderClaimChips() {
  const e = state.editing;
  const label = $("claim-label"), row = $("claim-chips");
  if (!label || !row) return;
  /* Claims are a Pro feature, only for claimable types (Company / legacy Shared). */
  const show = !!e && CLAIMABLE.has(scopeOf(e)) && isPro();
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
    body.innerHTML = `<p class="empty-note" style="margin-top:40px">Nothing ${state.scopeFilter ? "for " + escapeHtml(state.scopeFilter) : ""} this month yet.</p>`;
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
    if (t >= g.last) { g.last = t; g.name = safeGet(state.merchantNames, b) || safeGet(SEED_RULES.names, b) || e.merchant || "Unnamed"; }
  }
  const merchants = Object.values(byBrand).sort((a, b) => b.amt - a.amt).slice(0, 5);

  let html = `
    <div class="ins-total">
      <p class="big-amount" style="font-size:34px">${fmtRM(total)}</p>
    </div>`;

  /* Stacked by-type strip (All view only) — includes user-added types. */
  if (!state.scopeFilter && total > 0) {
    const st = {};
    for (const e of exps) { const s = scopeOf(e); st[s] = (st[s] || 0) + e.amount; }
    const present = allScopes().filter(s => st[s] > 0);
    if (present.length > 1) {
      html += `<div class="scope-strip">` + present.map(s =>
        `<i style="width:${(st[s] / total * 100).toFixed(1)}%;background:${scopeFill(s)}"></i>`).join("") + `</div>
        <p class="scope-strip-legend">` + present.map(s =>
        `<span class="${scopeClass(s)}">${escapeHtml(s)} ${Math.round(st[s] / total * 100)}%</span>`).join(" · ") + `</p>`;
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
      <span class="trend-val">${b.total > 0 ? Math.round(b.total).toLocaleString(appLocale()) : ""}</span>
      <div class="trend-bar ${b.current ? "cur" : ""}" style="height:${h}px"></div>
      <span class="trend-lbl">${b.label}</span>
    </div>`;
  }
  html += `</div>`;

  /* Rhythm: a real month calendar — darker ink = more spent that day.
     Hover shows the amount (title); tapping a spend day opens the day
     sheet (empty days toast). */
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
        ` style="--rh:${op.toFixed(2)}" title="${label}" data-label="${label}" data-day="${d}"><i>${d}</i></button>`;
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
    const over = cb > 0 && moneyGT(amt, cb);
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
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${over ? "var(--sienna-red)" : (CAT_COLOR[cat] || CAT_COLOR.Other)}"></div></div>
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

  body.innerHTML = html;
  const ru = $("ins-radar-upgrade");
  if (ru) ru.addEventListener("click", () => showUpgrade("The radar quietly catches subscriptions that creep up on you — it comes with Pro."));
  /* Tap a rhythm day -> open that day's expenses; empty days just toast. */
  for (const day of body.querySelectorAll(".rh-day[data-label]")) {
    day.addEventListener("click", () => {
      const d = parseInt(day.dataset.day, 10);
      const dayExps = exps.filter(e => new Date(e.date).getDate() === d);
      /* "spent" = the day has a real total; a day holding only zero-amount
         pending receipts keeps the toast (its label says "nothing spent"). */
      if (dayExps.length && day.classList.contains("spent")) openDaySheet(day.dataset.label, dayExps);
      else toast(day.dataset.label);
    });
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

/* Day drill-down: a sheet listing one calendar day's expenses (opened from
   the Monthly spend rhythm grid). Tapping an entry opens it for editing. */
function openDaySheet(label, dayExps) {
  const ov = $("day-overlay");
  if (!ov) return;
  const [dayPart, amtPart] = label.split(" · ");
  $("day-title").textContent = dayPart;
  $("day-total").textContent = amtPart || "";
  const list = $("day-list");
  list.innerHTML = "";
  const sorted = dayExps.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  for (const e of sorted) {
    const sc = scopeOf(e);
    const row = document.createElement("button");
    row.className = "entry";
    row.innerHTML = `
      <span class="cat-icon">${catIcon(e.category)}</span>
      <span class="entry-main">
        <span class="entry-merchant"><span class="merchant-name">${escapeHtml(e.merchant || "Expense")}</span></span>
        <span class="entry-cat"><span class="acct-tag ${scopeTag(sc)}">${escapeHtml(e.category)} | ${escapeHtml(sc.toUpperCase())}</span></span>
      </span>
      <span class="entry-amount${e.pending ? " waiting" : ""}">${e.pending ? "waiting…" : fmtRM(e.amount)}</span>`;
    row.addEventListener("click", () => { ov.hidden = true; openConfirmSheet(e); });
    list.appendChild(row);
  }
  ov.hidden = false;
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
   and triggers the print dialog (share sheet -> save as PDF on the phone).
   CURRENTLY UNLINKED (the Insights entry row was removed 13 Jul 2026 on
   Adrian's instruction) — kept so a menu entry can bring it back cheaply. */
function openStatement(m) {
  const exps = state.expenses.filter(e => { const d = new Date(e.date); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth() && !e.pending; });
  if (!exps.length) { toast("Nothing this month to report"); return; }
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const title = MONTH_NAMES[m.getMonth()] + " " + m.getFullYear();
  const st = {};
  const byCat = {}, byMer = {};
  let toClaim = 0;
  for (const e of exps) {
    const sc0 = scopeOf(e);
    st[sc0] = (st[sc0] || 0) + e.amount;
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    const k = e.merchant || "Unnamed";
    (byMer[k] = byMer[k] || { amt: 0, n: 0 }); byMer[k].amt += e.amount; byMer[k].n++;
    if (e.claimStatus === "to-claim") toClaim += e.amount;
  }
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, a]) => {
    const cb = state.catBudgets[c];
    return `<tr><td>${escapeHtml(c)}</td><td class="num">${fmtRM(a)}</td><td class="num">${cb > 0 ? fmtRM(cb) : "—"}</td><td class="num">${cb > 0 ? (moneyGT(a, cb) ? "+" + fmtRM(a - cb) : fmtRM(a - cb)) : ""}</td></tr>`;
  }).join("");
  const merRows = Object.entries(byMer).sort((a, b) => b[1].amt - a[1].amt).slice(0, 10).map(([n, v]) =>
    `<tr><td>${escapeHtml(n)}</td><td class="num">${v.n}×</td><td class="num">${fmtRM(v.amt)}</td></tr>`).join("");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recap — ${title}</title><style>
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
    <h1>Recap — monthly statement</h1>
    <p class="sub">${title} · generated ${new Date().toLocaleDateString(appLocale())}</p>
    <p class="big">${fmtRM(total)}</p>
    <p class="sub">${exps.length} expenses · ${allScopes().filter(s => st[s] > 0).map(s => escapeHtml(s) + " " + fmtRM(st[s])).join(" · ")}${toClaim > 0 ? " · still to claim " + fmtRM(toClaim) : ""}</p>
    <p class="sect">By category</p>
    <table><tr><th>Category</th><th class="num">Spent</th><th class="num">Budget</th><th class="num">±</th></tr>${catRows}</table>
    <p class="sect">Top places</p>
    <table><tr><th>Merchant</th><th class="num">Visits</th><th class="num">Total</th></tr>${merRows}</table>
    <p class="foot">Generated on-device by Recap — no data leaves your phone.</p>
    <script>setTimeout(function(){window.print()},400)<\/script>
  </body></html>`;
  /* document.write into a blank popup is dead on modern mobile browsers —
     serve the statement as a Blob URL instead, and if the pop-up itself is
     blocked (installed-PWA shells), show it in an in-app overlay. */
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (!w) {
    const ov = $("statement-overlay"), fr = $("statement-frame");
    if (ov && fr) { fr.srcdoc = html; ov.hidden = false; }
    else toast("Allow pop-ups to open the statement");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
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
    $("gh-token").value = state.ghToken || "";
    renderThemeChips();
    renderSyncStatus();
    renderCatBudgets();
    renderInboxSetting();
    renderCloudSetting();
    renderPlan();
    renderBackupStatus();
    renderRecurringList();
    const cs = $("currency-select");
    if (cs) cs.value = state.currency;
    const cos = $("country-select");
    if (cos) cos.value = state.country || "MY";
    const lgs = $("language-select");
    if (lgs) lgs.value = state.language || "en";
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

/* Phase 17 (fair-use caps): the Worker's daily cap declines a read once in a
   while; the race already falls back to the on-device result on its own, so
   this is just reassurance, not an error — shown at most once per LOCAL day
   (not once per receipt: a batch or a rapid-fire burst of raced scans could
   otherwise all decline within the same minute and each try to toast). The
   per-minute rate-limit decline deliberately does NOT come through here (see
   cloudRead) — it clears within a minute, so "AI resumes tomorrow" would be
   wrong, and the existing silent on-device fallback is the right behavior
   for it. */
function noteCloudQuotaDecline() {
  const today = todayKey();
  if (state.quotaNoticeDay === today) return;
  state.quotaNoticeDay = today;
  DB.setSetting("quotaNoticeDay", today);
  toast("Today's AI reads are used — reading on-device; AI resumes tomorrow");
}

/* Cloud reading: send the photo to the relay (Cloudflare Worker, or an old
   Vercel relay if an access code is set). Returns the same shape the on-device
   parser uses, so mergeAIResult() handles both. Nothing is stored server-side. */
async function cloudRead(file, signal) {
  const url = cloudEndpoint();
  if (!url) return null;
  /* Token budget: 1280px @ q0.8 keeps thermal-print text readable while
     cutting the image-token cost well below the old 1568px upload. */
  const image = await fileToJpegBase64(file, 1280, 0.8);
  const payload = { image, mediaType: "image/jpeg", deviceId: state.deviceId };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal   /* Phase 5: lets cloudReadTimed abort a stalled request so a hung socket can't strand the scan pill or a batch limiter slot */
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    /* Phase 17: the Worker declines a read at 429 for two reasons — the
       daily fair-use cap (recovers tomorrow) or a per-minute burst guard
       (recovers within a minute); `code` distinguishes them so only the
       daily one surfaces a notice. */
    if (res.status === 429 && body.code === "daily_cap") noteCloudQuotaDecline();
    const err = new Error(body.error || "Cloud reading failed");
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return res.json();
}

/* ---------- Cloud-first seamless read (cloudFirst, OCR-ENGINE-PLAN Phase 5) ----
   RACE-THEN-RECONCILE: on scan, the local reader and the cloud reader run at
   the same time. Whichever produces a usable result first PAINTS the confirm
   sheet (usually local, ~1-2s); when the cloud result lands it merges in as
   AUTHORITATIVE over every field the user has NOT edited, and learnFromAI fires
   on every raced scan (more distillation signal). cloudFirst OFF, offline,
   consent OFF, or no endpoint → the classic local-first path is untouched (it
   stays the resilience floor). Default ON — see cloudFirstEnabled(). */
const CLOUD_TIMEOUT_MS = 6000;          /* if local isn't usable, wait at most this long for cloud to lead the first paint; a later cloud result still merges before save */
const CLOUD_HARD_CAP_MS = 20000;        /* absolute cap on a single raced cloud read: a stalled socket is aborted here so the scan pill can't breathe "Reading with cloud…" forever (still generous enough that a genuinely slow-but-successful read merges) */
const BATCH_CLOUD_CONCURRENCY = 3;      /* scan-all-then-confirm pipelines this many cloud uploads at once (network-bound) while local reads run one at a time (CPU-bound) */
const MAX_PENDING_SCANS = 5;            /* backstop on state.pendingScans (accidental rapid-fire overlap, not a deliberate batch — batch already has its own MAX=20) */

async function cloudFirstEnabled() {
  try { return (await DB.getSetting("cloudFirst", "yes")) === "yes"; }
  catch (e) { return true; }
}
/* All the runtime conditions for racing the cloud: the flag is on, an endpoint
   exists, the user hasn't switched cloud reading off, and we're online. */
async function cloudFirstActive() {
  return !!cloudEndpoint() && state.cloudConsent !== "no" && navigator.onLine && await cloudFirstEnabled();
}

const delay = ms => new Promise(r => setTimeout(r, ms));

/* A cloud read that resolves to null (never rejects) on error OR after `ms`, so
   one slow/stuck upload can't hang a batch or strand the scan pill. On timeout
   the underlying request is ABORTED (not just ignored) — so a freed batch-limiter
   slot corresponds to a truly-terminated request and a dead socket stops
   uploading. */
function cloudReadTimed(file, ms) {
  const ac = new AbortController();
  return Promise.race([
    cloudRead(file, ac.signal).catch(() => null),
    delay(ms).then(() => { ac.abort(); return null; })
  ]);
}

/* Tiny concurrency limiter: at most `max` of the queued thunks run at once. */
function makeCloudLimiter(max) {
  let active = 0;
  const q = [];
  const pump = () => {
    while (active < max && q.length) {
      const { fn, res, rej } = q.shift();
      active++;
      Promise.resolve().then(fn).then(
        v => { active--; res(v); pump(); },
        e => { active--; rej(e); pump(); }
      );
    }
  };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); pump(); });
}

/* "Usable" mirrors handleImage's existing bar: something worth showing. */
function usableParsed(p) {
  return !!(p && (p.total || (p.merchant && String(p.merchant).trim()) || (p.items && p.items.length)));
}
function cloudUsable(ai) {
  return !!(ai && ai.readable !== false &&
    (ai.total || (ai.merchant && ai.merchant.length >= 2) || (Array.isArray(ai.items) && ai.items.length)));
}
/* Same usability bar as sheetUsable(), but off a draft object instead of the
   open sheet's DOM — for a queued scan the user has never seen yet. Trims
   merchant like sheetUsable() does, so a whitespace-only OCR read doesn't
   count as usable here when it wouldn't have on the live path either. */
function draftUsable(d) {
  return !!(d && (d.amount || (d.merchant && d.merchant.trim()) || (d.items && d.items.length)));
}
/* Is any OTHER modal sheet already up? All `.overlay` elements (chooser,
   menu, upgrade, bulk, setup, photo, statement, day, export…) share this
   class and toggle visibility via the `hidden` attribute — checked
   generically so a scan/queue decision doesn't need to know about every
   overlay by name, and stays correct if a new one is added later.
   confirm-overlay is excluded: state.editing already governs that one. */
function anyOtherOverlayOpen() {
  const els = document.querySelectorAll(".overlay");
  for (const el of els) {
    if (el.id !== "confirm-overlay" && !el.hidden) return true;
  }
  return false;
}
/* Is there actually nowhere else a freshly-read receipt needs to go? Used
   by both scan paths (handleImageRaced's race and the classic
   handleImageLocalFirst) — painting over an already-open sheet, an active
   Pro batch, or any other open overlay would silently replace whatever's
   already showing with zero warning. */
function screenFree() {
  return !state.editing && !state.batchMode && !anyOtherOverlayOpen();
}
/* Keep the queue's soft cap without evicting a draft that already spent the
   user's daily free scan. Drops the oldest UNcharged entry; if every queued
   draft happens to be charged (only possible with a genuinely large
   overlapping burst), lets the queue grow past MAX_PENDING_SCANS by one
   rather than silently discarding a receipt the user already paid for with
   no refund path. */
function evictOldestUnchargedIfFull(queue) {
  if (queue.length < MAX_PENDING_SCANS) return;
  const idx = queue.findIndex(d => !d._charged);
  if (idx !== -1) queue.splice(idx, 1);
}
/* Open a finished draft normally if the screen is free, otherwise queue it
   (same fallback every scan path uses) rather than silently overwriting
   whatever's already on screen. */
function openOrQueueDraft(draft) {
  if (screenFree()) { openConfirmSheet(draft); return; }
  evictOldestUnchargedIfFull(state.pendingScans);
  state.pendingScans.push(draft);
  showNextPendingScan();
}
/* A blank parse skeleton so the cloud reading can stand alone when the local
   reader returned nothing at all (blurry photo the cloud can still read). */
function emptyParsed() {
  return { rawText: "", total: null, totalConf: 0, merchant: "", category: "Other", date: null, time: null, items: [] };
}

/* What the confirm sheet was painted with, captured the moment it opens from
   the local result — the no-clobber baseline: a field the cloud may overwrite
   ONLY while it still equals what local painted (i.e. the user hasn't touched
   it). */
function capturePaintedFields() {
  const e = state.editing;
  return {
    amount: $("confirm-amount") ? $("confirm-amount").value : "",
    merchant: $("confirm-merchant") ? $("confirm-merchant").value : "",
    date: $("confirm-date") ? $("confirm-date").value : "",
    time: $("confirm-time") ? $("confirm-time").value : "",
    category: e ? e.category : "",
    itemsJSON: e ? JSON.stringify(e.items || []) : "[]"
  };
}

/* Merge a cloud-authoritative draft into the ALREADY-OPEN confirm sheet without
   clobbering anything the user has edited (Phase 8's no-clobber rule). Runs
   only for the scan still on screen (scanId + overlay open). `painted` is the
   baseline from capturePaintedFields(). */
function applyCloudToOpenSheet(scanId, cloudDraft, painted) {
  const e = state.editing;
  if (!e || e._scanId !== scanId || !painted) return;
  const ov = $("confirm-overlay");
  if (!ov || ov.hidden) return;
  /* Never mutate the sheet mid-save: saveExpense reads amount/date, then awaits
     fileToThumb, then reads merchant/category/items — a merge firing during that
     await would persist a record that mixes pre- and post-merge fields. */
  if (state._saving) return;
  /* Only re-baseline the unsaved-changes guard if the user hadn't already
     edited something — so an auto-merge never masks a real pending edit. */
  const hadEdits = state._sheetSnapshot !== undefined && sheetFingerprint() !== state._sheetSnapshot;
  let changed = false;

  const amtEl = $("confirm-amount");
  if (amtEl && amtEl.value === painted.amount && cloudDraft.amount != null && cloudDraft.amount > 0) {
    const v = cloudDraft.amount.toFixed(2);
    if (amtEl.value !== v) { amtEl.value = v; changed = true; }
    e.amount = cloudDraft.amount;
    /* Keep the "as-parsed" baseline authoritative too, so a clean save (no
       further edit) is NOT mistaken for a user correction — that would
       re-learn what learnFromAI already learned AND pop a spurious "Noted…"
       toast (learnFromCorrections compares record.amount to _parsedTotal). */
    e._parsedTotal = cloudDraft._parsedTotal;
    painted.amount = amtEl.value;
  }
  const merEl = $("confirm-merchant");
  if (merEl && merEl.value === painted.merchant && cloudDraft.merchant) {
    if (merEl.value !== cloudDraft.merchant) { merEl.value = cloudDraft.merchant; changed = true; }
    e.merchant = cloudDraft.merchant;
    e._parsedMerchant = cloudDraft._parsedMerchant;
    painted.merchant = merEl.value;
  }
  if (!e.userPicked && cloudDraft.category && cloudDraft.category !== e.category) {
    e.category = cloudDraft.category;
    painted.category = e.category;
    renderCategoryChips();
    changed = true;
  }
  const dEl = $("confirm-date"), tEl = $("confirm-time");
  if (dEl && tEl && dEl.value === painted.date && tEl.value === painted.time && cloudDraft.date) {
    const cd = new Date(cloudDraft.date);
    if (!isNaN(cd)) {
      const ds = localDateStr(cd);
      const ts = localTimeStr(cd);
      if (dEl.value !== ds || tEl.value !== ts) { dEl.value = ds; tEl.value = ts; changed = true; }
      e.date = cloudDraft.date;
      painted.date = dEl.value; painted.time = tEl.value;
    }
  }
  if (JSON.stringify(e.items || []) === painted.itemsJSON && Array.isArray(cloudDraft.items) && cloudDraft.items.length) {
    e.items = cloudDraft.items.map(i => ({ ...i }));
    painted.itemsJSON = JSON.stringify(e.items);
    renderItemsEditor();
    changed = true;
  }
  e._source = "cloud";
  if (changed && !hadEdits) state._sheetSnapshot = sheetFingerprint();
  renderAiRecheckButton();   /* Phase 8: _source just flipped to "cloud" — hide the re-read button */
}

/* Phase 8 — "Looks right?" on-demand AI re-read. Only for a sheet that's
   still local-only (a successful automatic/raced cloud merge already covers
   this — Phase 5's own interplay note, see handleImageRaced's header
   comment); needs the original file to re-upload; the endpoint/consent gate
   every other cloud call site uses; and the flag. `_cloudPending` (set/synced
   by handleImageRaced, see there) additionally holds the button back while
   THIS scan's own automatic race still has a cloud read in flight — /code-
   review (this phase) found that without it, a manual re-read could run
   concurrently with the automatic one for the same scan: two independent
   capturePaintedFields() baselines racing the SAME no-clobber primitive,
   each blind to the other's writes, silently dropping whichever merge
   landed second (and, via countIfUsable's charge-sync, could even revert a
   manual quota charge back to uncharged). Simplest fix is to not let the
   two ever overlap in the first place, rather than trying to reconcile two
   baselines after the fact. */
function aiRecheckAvailable() {
  const e = state.editing;
  return !!(e && e._source === "local" && !e._cloudPending && e._file && cloudEndpoint() && state.cloudConsent !== "no" && state.aiRecheck === "yes");
}
function renderAiRecheckButton() {
  const btn = $("ai-recheck-btn");
  if (!btn) return;
  btn.hidden = !aiRecheckAvailable();
  btn.disabled = false;
  btn.textContent = "Not right? Re-read with AI";
}

/* On tap: cloudRead -> mergeAIResult -> update the open sheet WITHOUT
   clobbering user-edited fields (reuses applyCloudToOpenSheet's no-clobber
   primitive verbatim) -> learnFromAI -> _source="cloud". The merge base is
   the sheet's OWN current fields (not emptyParsed()) so a field the AI
   doesn't answer keeps its already-displayed value — including base.time,
   derived from e.date's own hour/minute (NOT hardcoded null: /code-review
   found that parsedToDraft's date/time defaulting is written for a FRESH
   OCR parse, where a truthy date + falsy time means "resolve time to now" —
   exactly the wrong rule here, where a falsy time should mean "keep this
   sheet's already-correct time," so it must go in already populated).
   Quota rule (decided): a re-read on a scan that already consumed today's
   free read (e._charged) is free; a re-read on one that never consumed it
   (local came up empty/weak enough that handleImage never charged) counts
   as today's read on success — gated BEFORE the network call fires (not
   just before the charge), so a sibling scan that spent the day's only
   free slot in the background while this sheet sat open can't let an
   uncharged bonus read slip through. */
async function reReadWithAI() {
  const e = state.editing;
  if (!e || !aiRecheckAvailable()) return;
  /* Phase 9 card-slip guard — defense in depth: a sheet only ever reaches
     _source==="local" (aiRecheckAvailable()'s own gate) by having ALREADY
     passed this exact check once, on this exact _rawText, at the original
     scan (handleImageLocalFirst/handleImageRaced) — a pure function re-run
     on unchanged input can't flip its answer, so this is currently
     unreachable in practice. Kept anyway: unlike those raced flows, e._rawText
     is already sitting here with no network round-trip needed first, so the
     check is free, real (no race to be honest-limited about), and a cheap
     second gate against a future code path that ever creates a "local"-
     sourced sheet without going through the original guard. */
  if (window.ReceiptOCR.looksLikeCardSlip(e._rawText)) {
    toast("That looks like a payment card or ID document — Recap won't re-read it");
    return;
  }
  if (!isPro() && !e._charged && !scanAllowed()) { toast("Today's free reads are used up"); return; }
  const scanId = e._scanId;
  const btn = $("ai-recheck-btn");
  btn.disabled = true;
  btn.textContent = "Reading with AI…";
  const painted = capturePaintedFields();
  let ai = null;
  try { ai = await cloudReadTimed(e._file, CLOUD_HARD_CAP_MS); } catch (err) { ai = null; }
  /* The user may have closed this sheet, saved it, or opened a different one
     while the request was in flight — bail rather than touch the wrong
     sheet. Object identity (`state.editing === e`), not just `_scanId`:
     batch drafts (scanAllInBatch) never get a _scanId at all (undefined),
     so comparing undefined-to-undefined would silently pass this guard for
     a DIFFERENT batch receipt the user has since advanced to — the exact
     scenario "works in batch confirms" needs protected against. `state.
     _saving` too: saveExpense sets it synchronously but doesn't clear
     state.editing until after its own awaits (fileToThumb, DB writes), so
     without this a Save that started mid-re-read could let the charge below
     fire for an AI answer applyCloudToOpenSheet's OWN _saving guard already
     silently discarded. Checked again here (not just relying on
     applyCloudToOpenSheet's guard) so the quota/learn side-effects don't
     fire against a stale or mid-save scan either. */
  if (state.editing !== e || state._saving || $("confirm-overlay").hidden) return;
  if (!cloudUsable(ai)) {
    btn.disabled = false;
    btn.textContent = "Not right? Re-read with AI";
    toast("Couldn't read it any better — try fixing it by hand");
    return;
  }
  const origDate = e.date ? new Date(e.date) : null;
  const base = {
    rawText: e._rawText || "", total: e.amount, totalConf: 0,
    merchant: e.merchant, category: e.category,
    date: origDate, time: origDate ? { h: origDate.getHours(), min: origDate.getMinutes() } : null,
    items: e.items || []
  };
  try { learnFromAI(base.rawText, ai, base.total, base.merchant); } catch (err) {}
  const merged = mergeAIResult(base, ai);
  applyCloudToOpenSheet(scanId, parsedToDraft(merged), painted);
  if (!isPro() && !e._charged && scanAllowed()) { await bumpScanUsed(); e._charged = true; }
}

/* Speed pass: the instant the Add chooser opens, start warming the two things a
   scan waits on — the Tesseract worker (boot cost) and the cloud edge (TLS +
   Worker cold start). Both fire-and-forget; picking manual entry instead just
   means the warmed worker is reused next time and the ping was one tiny GET.
   The ping is throttled so re-opening the chooser can't spam the edge. */
let lastCloudWarmAt = 0;
function warmUpScan() {
  try { if (window.ReceiptOCR && window.ReceiptOCR.warmUp) window.ReceiptOCR.warmUp(); } catch (e) {}
  const now = Date.now();
  if (cloudEndpoint() && state.cloudConsent !== "no" && navigator.onLine && now - lastCloudWarmAt > 20000) {
    lastCloudWarmAt = now;
    try { fetch(cloudEndpoint(), { method: "GET", cache: "no-store" }).catch(() => {}); } catch (e) {}
  }
}

/* Explicit, one-time consent before any photo leaves the device (PDPA). The
   choice is remembered and can be changed in Settings. */

/* The scan pill: a small breathing status chip above the nav while a
   receipt is being read — never a blocking overlay. */
function showScanPill(msg) {
  const p = $("scan-pill");
  if (!p) return;
  clearTimeout(p._t);
  p.textContent = msg;
  p.classList.remove("done");
  p.hidden = false;
}
function completeScanPill(msg) {
  const p = $("scan-pill");
  if (!p) return;
  p.textContent = msg;
  p.classList.add("done");
  p.hidden = false;
  clearTimeout(p._t);
  p._t = setTimeout(() => { p.hidden = true; p.classList.remove("done"); }, 1600);
}
function hideScanPill() {
  const p = $("scan-pill");
  if (!p) return;
  clearTimeout(p._t);
  p.hidden = true;
  p.classList.remove("done");
}

/* Multi-select: long-press enters the mode, taps toggle ticks, the floating
   bar deletes everything selected (with one Undo). */
function enterSelectMode(id) {
  state.selectMode = true;
  state.selected = new Set(id != null ? [id] : []);
  renderHome();
  updateSelectBar();
}
function exitSelectMode() {
  state.selectMode = false;
  state.selected = new Set();
  const bar = $("select-bar");
  if (bar) bar.hidden = true;
  renderHome();
}
function toggleSelect(id) {
  if (!state.selected) state.selected = new Set();
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  if (!state.selected.size) { exitSelectMode(); return; }
  renderHome();
  updateSelectBar();
}
function updateSelectBar() {
  const bar = $("select-bar");
  if (!bar) return;
  bar.hidden = !state.selectMode;
  const n = state.selected ? state.selected.size : 0;
  $("select-count").textContent = n + " selected";
  $("select-delete").textContent = "Delete (" + n + ")";
}

/* Bulk update (Pro): set a category and/or type on everything selected.
   Tapping a chip picks it; tapping again clears it (= leave unchanged). */
function renderBulkChips() {
  const bc = $("bulk-cat-chips"), bs = $("bulk-scope-chips");
  if (!bc || !bs) return;
  bc.innerHTML = ""; bs.innerHTML = "";
  for (const c of CATS) {
    const b = document.createElement("button");
    const sel = state._bulk.cat === c.name;
    b.className = "chip" + (sel ? " selected" : "");
    if (sel) { b.style.background = c.color; b.style.borderColor = c.color; }
    b.textContent = c.name;
    b.addEventListener("click", () => { state._bulk.cat = sel ? null : c.name; renderBulkChips(); });
    bc.appendChild(b);
  }
  for (const s of allScopes()) {
    const b = document.createElement("button");
    const sel = state._bulk.scope === s;
    b.className = "chip scope-opt " + scopeClass(s) + (sel ? " selected" : "");
    b.textContent = s;
    b.addEventListener("click", () => { state._bulk.scope = sel ? null : s; renderBulkChips(); });
    bs.appendChild(b);
  }
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
  if (isRealCategory(ai.category)) parsed.category = ai.category;
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

/* Phase 7 — "For:" chip row in the Add chooser: sets the TYPE the next
   receipt/manual entry will default to, before the user even picks how to
   capture it. Re-initialized fresh every openChooser() from state.lastScope
   (never carries a stale pick from a previous, already-finished scan). A
   real tap both updates the transient pendingScope (this scan) AND persists
   lastScope (future opens default to it too) — matching how "last used"
   pickers work elsewhere in the app (e.g. currency). */
function renderChooserScopeChips() {
  const label = $("chooser-scope-label");
  const row = $("chooser-scope-chips");
  if (!label || !row) return;
  if (state.preScanType !== "yes") { label.hidden = true; row.hidden = true; return; }
  label.hidden = false; row.hidden = false;
  row.innerHTML = "";
  for (const s of allScopes()) {
    const b = document.createElement("button");
    const sel = s === state.pendingScope;
    b.className = "chip scope-opt " + scopeClass(s) + (sel ? " selected" : "");
    b.textContent = s;
    b.addEventListener("click", () => {
      state.pendingScope = s;
      state.pendingScopeTouched = true;
      state.lastScope = s;
      DB.setSetting("lastScope", s);
      renderChooserScopeChips();
    });
    row.appendChild(b);
  }
}

/* Phase 9 (OCR-ENGINE-PLAN.md) — card-slip guard. Fires once per detected
   card-slip/ID-photo scan: no cloud send, no photo kept, no learning, the
   day's scan not consumed (callers are responsible for skipping all of
   that BEFORE calling this — this function is UI only). Firm message +
   exactly the two escape hatches the spec calls for, via a native
   confirm() (OK/Cancel) matching this file's own existing pattern for an
   in-flow binary choice (see handleImage's ad-unlock confirm()). */
function blockCardSlip() {
  const enterManually = confirm(
    "That looks like a payment card or ID document, not a receipt.\n\n" +
    "Recap won't read, send, or save a photo of it — card and ID numbers are too sensitive to risk.\n\n" +
    "OK — enter this expense manually\nCancel — retake with a different photo"
  );
  if (enterManually) openConfirmSheet(null);
  else openChooser();
}

function openChooser() {
  state.pendingScope = state.lastScope;
  state.pendingScopeTouched = false;
  renderChooserScopeChips();
  renderQuickAdd();
  $("chooser-overlay").hidden = false;
  warmUpScan();   /* Phase 5 speed pass: pre-warm the OCR worker + cloud edge */
  /* One-time first-scan notice (persistent chooser hint line covers every
     later open) — fires the first time ANYONE opens the chooser, whether
     they end up scanning a card slip or not, so the limit is known before
     it's ever hit. */
  if (state.cardNoticeSeen !== "yes") {
    state.cardNoticeSeen = "yes";
    DB.setSetting("cardNoticeSeen", "yes");
    toastAction("Tip: don't photograph payment cards or ID documents — Recap blocks what it can detect, but skip these to be safe", "Got it", () => {}, null, 6000);
  }
}

async function handleImage(file) {
  if (!file) return;
  /* Phase 7 — capture the "For:" chooser pick BEFORE any await below. JS run-
     to-completion means this happens before a second, overlapping chooser
     interaction (rapid-fire scan B) could change state.pendingScope out from
     under this scan — the exact class of race Phase 5's rapid-fire fixes
     already guard elsewhere in this file. Threaded through as params, never
     re-read from live state later in either handler. */
  const preScope = state.preScanType === "yes" ? state.pendingScope : "Personal";
  const preScopeTouched = state.preScanType === "yes" && state.pendingScopeTouched;
  /* EVERY install — including the owner's — takes the instant path now:
     on-device read, cloud AI for the hard ones, result in seconds. The Claude
     inbox no longer fronts scanning; it only fills receipts deliberately
     saved without an amount, and learns from those. */
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
        openOrQueueDraft({
          amount: null, merchant: "", category: "Other", scope: preScope, userPickedScope: preScopeTouched,
          date: new Date().toISOString(), items: [], note: "",
          photo: thumb0 || undefined, fromReceipt: false
        });
        return;
      }
    } else {
      const thumb = await fileToThumb(file, 700);
      toastAction("Today's free scan is used — type this one in", "Go Pro",
        () => showUpgrade("Free reads " + FREE_SCANS_PER_DAY + " receipt a day. Pro reads them all — every receipt, every day."), null, 5500);
      openOrQueueDraft({
        amount: null, merchant: "", category: "Other", scope: preScope, userPickedScope: preScopeTouched,
        date: new Date().toISOString(), items: [], note: "",
        photo: thumb || undefined, fromReceipt: false
      });
      return;
    }
  }
  /* Cloud-first (default): race the local and cloud readers; the first usable
     result paints, the cloud result then merges authoritative. Off / offline /
     consent-off / no endpoint → the classic local-first path (resilience floor). */
  if (await cloudFirstActive()) return handleImageRaced(file, preScope, preScopeTouched);
  return handleImageLocalFirst(file, preScope, preScopeTouched);
}

/* Classic local-first read (unchanged behaviour): on-device first, cloud only
   when the on-device result is weak/empty. Runs when cloudFirst is off, the
   device is offline, or cloud reading is switched off. `preScope`/
   `preScopeTouched`: Phase 7's chooser-time capture, see handleImage(). */
async function handleImageLocalFirst(file, preScope, preScopeTouched) {
  /* Per-scan id, same monotonic counter handleImageRaced uses. Needed
     because this function has no supersede/queue awareness of its own —
     two overlapping calls (e.g. cloud off, user scans twice quickly) run
     fully independently. Without an id, cancellation below would target
     ANY in-flight scan rather than specifically this one: a shared
     boolean flag either discards every overlapping scan at once (one
     cancel-tap trips every "if (cancelled) return"), or gets silently
     reset by whichever scan starts next, letting an explicitly-cancelled
     scan proceed anyway (and still charge the daily quota) once a second
     one begins. state.cancelledScanIds.has(myId) only matches the scan the
     user actually meant, and (being a Set, not a single overwritable id)
     stays correct even if another, different scan gets cancelled afterward
     while this one is still in flight. */
  const myId = ++state._scanSeq;
  const cancelled = () => state.cancelledScanIds.has(myId);
  /* Is this scan's progress still worth showing on the shared pill —
     neither eclipsed by a newer scan NOR (this was missed the first time
     round) explicitly cancelled. Without the cancellation half, a scan
     whose OWN cancel-tap already hid the pill could still un-hide it the
     next time its still-running (uncancellable) OCR pass reports progress
     — ocr.js fires onProgress several times across real async passes,
     each seconds apart — leaving the pill stuck forever once this scan
     finally resolves and bails out without ever calling hideScanPill(). */
  const stillCurrent = () => myId === state._scanSeq && !cancelled();
  /* Non-blocking read: no full-screen overlay. The ledger shows a live
     "reading" row and a small pill breathes at the bottom (tap = cancel);
     the wait never blocks looking at your expenses. Only the LATEST scan's
     progress touches the shared pill text, same discipline as
     handleImageRaced, so two overlapping reads can't stomp each other's
     message. */
  state.scanning = true;
  switchView("home");
  renderHome();
  showScanPill("Reading receipt…");
  try {
    const parsed = await window.ReceiptOCR.scanReceipt(file, msg => { if (stillCurrent()) showScanPill(msg); });
    if (cancelled()) return;
    /* Phase 9 card-slip guard: checked BEFORE anything else touches this
       read — before the cloud fallback below can fire, before the raw text
       is cached (DB.setSetting("lastScan", ...) two lines down), before
       learning, before a photo thumbnail ever gets generated. Sequential
       path (classic/cloudFirst-off): local OCR has already fully finished
       by this point, so this is a REAL, guaranteed block — no network
       request for this photo has happened yet. */
    if (window.ReceiptOCR.looksLikeCardSlip(parsed.rawText)) {
      if (cancelled()) return;
      /* Only touch the shared pill/scanning flag if THIS is still the
         current scan — a newer, still-running scan owns them otherwise
         (same discipline as handleImageRaced's stillCurrent() guards). */
      if (stillCurrent()) { state.scanning = false; hideScanPill(); }
      renderHome();
      blockCardSlip();
      return;
    }
    DB.setSetting("lastScan", parsed.rawText || "");
    applyLearnedTotalHint(parsed);
    let source = "local";
    /* Cloud fallback: only when on-device reading came up empty or weak, and
       the user hasn't switched cloud reading off (it's on by default). */
    const weak = parsed.total === null || (parsed.totalConf || 0) <= 1;
    if (cloudEndpoint() && weak && state.cloudConsent !== "no") {
      {
        if (stillCurrent()) showScanPill("Reading with cloud…");
        try {
          const ai = await cloudRead(file);
          if (cancelled()) return;
          learnFromAI(parsed.rawText, ai, parsed.total, parsed.merchant);
          mergeAIResult(parsed, ai);
          if (ai && ai.readable !== false) source = "cloud";
        } catch (err) {
          /* A 429 decline already surfaced its own notice (or, for the
             per-minute rate limit, deliberately stays silent) inside
             cloudRead — don't also show the raw server message here. */
          if (err.status !== 429) toast(err.message || "Cloud reading failed");
        }
      }
    }
    if (cancelled()) return;
    if (stillCurrent()) state.scanning = false;
    renderHome();
    /* usableParsed() (also used by the raced/cloudFirst path) trims merchant
       before checking it — this used to reimplement the same bar without
       the trim, so a whitespace-only merchant (e.g. a 2-space cloud-AI
       reply, mergeAIResult has no trim check either) charged the daily
       scan and painted "Scan complete" here but NOT on the raced path,
       for the identical parse result. */
    const usable = usableParsed(parsed);
    if (usable) {
      if (stillCurrent()) completeScanPill("Scan complete ✓");
    } else {
      if (stillCurrent()) hideScanPill();
      toast(state.ghToken ? "Couldn't read it — save anyway, Claude will fill it in" : "That one was too blurry — try more light, or just type it in");
    }
    /* Only a read that actually produced something consumes the free daily
       scan — a blurry failure costs the user nothing. Re-checks
       scanChargeAllowed() (not just isPro()) for the same reason
       handleImageRaced does: an overlapping scan elsewhere may already have
       spent today's full allowance by the time this one gets here. */
    let charged = false;
    if (usable && !isPro() && scanChargeAllowed()) { await bumpScanUsed(); charged = true; }
    const draft = parsedToDraft(parsed);
    draft._file = file;
    draft._source = source;
    draft._charged = charged;
    draft.scope = preScope;
    draft.userPickedScope = preScopeTouched;
    openOrQueueDraft(draft);
  } catch (err) {
    if (cancelled()) return;
    if (stillCurrent()) { state.scanning = false; hideScanPill(); }
    renderHome();
    toast(err.message || "Something went wrong reading the receipt");
    openOrQueueDraft({
      id: null, amount: null, merchant: "", category: "Other", scope: preScope, userPickedScope: preScopeTouched,
      date: new Date().toISOString(), items: [], note: "", fromReceipt: false
    });
  }
}

/* Cloud-first RACE (Phase 5): fire the local and cloud readers at once. The
   first usable result paints the confirm sheet — usually local (~1-2s), but on
   a hard receipt where local runs its slow sniper passes the cloud read
   (~3s) often wins and paints first. When the cloud result lands it merges as
   AUTHORITATIVE into every field the user hasn't edited, and learnFromAI fires
   on every raced scan. A monotonic scanId (state._scanSeq) guarantees a
   cancelled or superseded scan's late cloud result can never touch the wrong
   sheet (no duplicate-sheet / lost-scan / cross-scan clobber). */
async function handleImageRaced(file, preScope, preScopeTouched) {
  const myId = ++state._scanSeq;
  state.scanning = true;
  switchView("home");
  renderHome();
  showScanPill("Reading receipt…");

  let parsed = null, cloudAi = null, painted = null;
  let localDone = false, cloudDone = false;
  let learned = false, sheetOpened = false, mergedIntoSheet = false, counted = false, painting = false, pillPending = false, paintedWithoutLocal = false;
  /* Phase 9 card-slip guard. Card-slip detection can ONLY run off local's
     own rawText (cloud returns a structured {merchant,total,...} result,
     never raw OCR text to pattern-match) — so unlike handleImageLocalFirst's
     fully sequential flow, this racing flow may already have fired the
     cloud request, or even painted a sheet from cloud's own answer, before
     local's check ever runs. This flag guards every downstream paint/
     merge/learn/charge function (each checks it first) so nothing further
     happens for this scan the instant it's known, however that happens to
     land; handleCardSlipDetected() also retroactively undoes a paint/queue
     that already happened. HONEST LIMIT (documented in the privacy notice
     too): if cloud's response ALREADY painted+charged before local's check
     completed, that one charge is not refunded — decrementing the shared
     scanCount counter here could just as easily reverse a DIFFERENT,
     legitimate overlapping scan's charge (it's a single counter, not a
     per-scan ledger) — a wrong "fix" worse than the rare case it targets. */
  let cardSlip = false;
  const handleCardSlipDetected = () => {
    if (cardSlip) return;
    cardSlip = true;
    if (queued && enqueuedDraft) {
      const idx = state.pendingScans.indexOf(enqueuedDraft);
      if (idx >= 0) state.pendingScans.splice(idx, 1);
      enqueuedDraft = null;
    }
    if (state.cancelledScanIds.has(myId)) return;   /* user explicitly cancelled — nothing to show */
    /* mySheetIsOpen(), NOT stillCurrent(): stillCurrent() tracks "am I the
       LATEST scan" and goes permanently false the moment any newer scan
       starts — even one that's merely queued behind THIS scan's still-open
       sheet. Gating the teardown on it left a stale card-slip sheet open
       and fully save-able with no warning shown (found in review). Ask the
       right question instead: is OUR sheet the one actually on screen. */
    const mySheetOpen = mySheetIsOpen();
    if (mySheetOpen) closeConfirmSheet(true);
    if (stillCurrent()) { state.scanning = false; hideScanPill(); renderHome(); }
    /* Closing our own sheet just above can surface a DIFFERENT, newer
       scan's queued draft (closeConfirmSheet -> showNextPendingScan, which
       fires its own deferred "also caught" toast). A confirm() dialog here
       would then interrupt that unrelated sheet, or — if "Enter manually"
       is tapped — destructively replace it before the user ever saw it.
       Only safe to show once the screen has genuinely ended up free;
       otherwise stay quiet rather than race the other scan's own toast for
       the single shared toast slot (same race finishBatch's fix avoids).
       The safety guarantee (no photo saved/learned/charged beyond what
       already landed) holds either way — this only affects whether the
       user is told about it. */
    if (!state.editing) blockCardSlip();
  };

  /* Is this still the scan on screen? (not cancelled, not superseded by a newer
     scan). UI-mutating steps require it; learnFromAI does not — it's
     scan-independent and always worth doing, even for a superseded scan. */
  const stillCurrent = () => myId === state._scanSeq && !state.cancelledScanIds.has(myId);
  /* Superseded specifically by a NEWER scan (not this scan's own explicit
     cancel). The pill only ever shows/updates for the current scan (its
     progress callback below checks stillCurrent()), so a cancel-tap always
     targets myId === state._scanSeq — that case must stay a true dead end,
     never queued or charged. Only a scan actually eclipsed by a later one is
     safe to resurrect. */
  const supersededByNewer = () => myId !== state._scanSeq;
  const sheetUsable = () => {
    if (!sheetOpened) return false;
    const amt = $("confirm-amount") ? $("confirm-amount").value.trim() : "";
    const mer = $("confirm-merchant") ? $("confirm-merchant").value.trim() : "";
    const items = state.editing && state.editing.items && state.editing.items.length;
    return !!(amt || mer || items);
  };
  /* A read that produced something consumes the free daily scan; a blurry
     failure costs nothing. Counted once, from machine output (before the user
     can type). Re-checks scanChargeAllowed() (not just isPro()): a rapid-fire
     sibling scan sharing this same burst may already have spent today's full
     allowance by the time this one gets here — see the matching guard in
     tryEnqueue. */
  const countIfUsable = () => {
    if (cardSlip) return;
    if (!counted && !isPro() && sheetUsable() && scanChargeAllowed()) { counted = true; bumpScanUsed(); }
    /* Phase 8 quota rule needs to know, per open sheet, whether THIS scan
       already spent the day's read — countIfUsable() is the only place that
       decision is made on the direct-paint path (tryEnqueue/
       refreshEnqueuedDraft already stamp their own draft/state.editing
       elsewhere). `counted` (this closure's own charge) OR whatever's
       already there (not a blind overwrite): `counted` only tracks THIS
       scan's own automatic race, but reReadWithAI can independently set
       state.editing._charged = true first (a manual re-read firing while
       this scan's own automatic race is, in some path this diff doesn't
       fully rule out, still settling) — a bare `= counted` would revert
       that back to false the next time this runs. */
    if (state.editing && state.editing._scanId === myId) state.editing._charged = counted || state.editing._charged;
  };
  const openSheet = (p, source) => {
    const draft = parsedToDraft(p);
    draft._file = file;
    draft._scanId = myId;
    draft._source = source;
    draft.scope = preScope;
    draft.userPickedScope = preScopeTouched;
    /* Phase 8: this scan's OWN automatic cloud leg may still be in flight
       (e.g. local painted first) — hold the "Re-read with AI" button back
       until it settles (synced to false at the cloud .then() below),
       so an automatic and a manual re-read for the SAME scan can never
       overlap. Trivially false already for a cloud-sourced paint. */
    draft._cloudPending = !cloudDone;
    /* Phase 9 (review fix): a cloud-painted sheet is fully save-able the
       instant it opens, but the card-slip check can only run once local's
       rawText is in — nothing was stopping a fast Save tap from persisting
       the photo (and learning from it) in that window. saveExpense() blocks
       while this is true; the local IIFE below clears it once the check
       actually resolves either way. Never true for a local-sourced paint —
       that source can't exist yet without already having passed the check. */
    draft._cardSlipPending = source === "cloud" && !localDone;
    openConfirmSheet(draft);
    painted = capturePaintedFields();
    sheetOpened = true;
  };
  /* Rest the pill. While the sheet holds nothing usable but the cloud read is
     still in flight, keep it breathing (cloud may still fill it) rather than
     declaring failure. */
  const settlePill = () => {
    if (!stillCurrent()) return;
    if (sheetUsable()) { pillPending = false; completeScanPill("Scan complete ✓"); }
    else if (!cloudDone) { pillPending = true; showScanPill("Reading with cloud…"); }
    else { pillPending = false; hideScanPill(); toast(state.ghToken ? "Couldn't read it — save anyway, Claude will fill it in" : "That one was too blurry — try more light, or just type it in"); }
  };
  /* Learn from the cloud read once BOTH readers are done (needs local rawText).
     Runs regardless of cancel/supersede. */
  const learnFromCloud = () => {
    if (learned || !localDone || !cloudDone || !cloudAi || !parsed) return;
    try { learnFromAI(parsed.rawText, cloudAi, parsed.total, parsed.merchant); } catch (e) {}
    learned = true;
  };
  /* Merge the cloud reading (authoritative) into the open sheet, once. A cloud
     result that couldn't read the receipt (failed / readable:false) contributes
     nothing — leave the sheet and its _source="local" tag untouched so Phase
     8's "Re-read with AI" affordance still applies to it. */
  const mergeCloudIntoSheet = () => {
    if (cardSlip) return;
    if (mergedIntoSheet || !cloudDone || !sheetOpened || !stillCurrent()) return;
    if (!cloudAi || !cloudUsable(cloudAi)) { mergedIntoSheet = true; return; }
    mergedIntoSheet = true;
    try {
      const merged = mergeAIResult(Object.assign({}, parsed || emptyParsed()), cloudAi);
      applyCloudToOpenSheet(myId, parsedToDraft(merged), painted);
    } catch (e) {}
    countIfUsable();
  };
  /* When the cloud read painted the sheet before the local read finished, the
     draft was built from emptyParsed() — so it carries no rawText and any field
     the cloud left null (e.g. a faded date) defaulted to "today". Once the real
     local read lands, fold it in: restore its rawText (so a later user total
     correction can still be learned) and let it fill cloud-null fields —
     WITHOUT clobbering cloud's values or the user's edits (applyCloudToOpenSheet's
     painted-baseline checks handle both). */
  const reconcileLocalIntoCloudSheet = () => {
    if (cardSlip) return;
    if (!paintedWithoutLocal || !parsed || !painted || !stillCurrent()) return;
    if (!state.editing || state.editing._scanId !== myId) return;
    if (!state.editing._rawText) state.editing._rawText = parsed.rawText || "";
    try { applyCloudToOpenSheet(myId, parsedToDraft(mergeAIResult(Object.assign({}, parsed), cloudAi)), painted); } catch (e) {}
  };
  /* Paint from the first usable read. Prefer cloud (more accurate); else local;
     `force` (both readers done, or the 6s cap elapsed with local in) paints
     whatever we have so the user is never stuck. A cloud-painted sheet needs no
     later local merge; a local-painted sheet takes the authoritative cloud
     merge when it lands. */
  let queued = false;
  const tryPaint = (force) => {
    if (cardSlip) return;
    if (painting || sheetOpened || queued) return;
    if (!stillCurrent()) {
      /* Cancelled by the user → true dead end, same as pre-Phase-5: no
         sheet, no queue, no quota charge — checked FIRST and unconditionally,
         because a newer scan starting afterward also makes
         supersededByNewer() true; without this order a cancelled scan would
         still get queued/resurrected the moment anything else starts. Only
         a scan that was never cancelled and is merely eclipsed by a newer
         one is safe to queue. */
      if (state.cancelledScanIds.has(myId)) return;
      if (supersededByNewer()) tryEnqueue(force);
      return;
    }
    if (!screenFree()) { tryEnqueue(force); return; }
    if (cloudDone && cloudUsable(cloudAi)) {
      painting = true;
      paintedWithoutLocal = !parsed;   /* cloud won the race before local finished — reconcile local's rawText + cloud-null fields when it lands */
      learnFromCloud();
      openSheet(mergeAIResult(Object.assign({}, parsed || emptyParsed()), cloudAi), "cloud");
      mergedIntoSheet = true;
    } else if (localDone && usableParsed(parsed)) {
      painting = true;
      openSheet(parsed, "local");
    } else if (force && localDone) {
      painting = true;
      openSheet(parsed || emptyParsed(), "local");
    } else {
      return;
    }
    state.scanning = false;
    renderHome();
    countIfUsable();
    mergeCloudIntoSheet();   /* if cloud is already in, merge it now */
    settlePill();
  };
  /* Best result available RIGHT NOW (cloud preferred, else local) — shared
     by tryEnqueue (the initial decision) and refreshEnqueuedDraft (any
     later reader completing after that). */
  const bestAvailable = () => {
    if (cloudDone && cloudUsable(cloudAi)) return { p: mergeAIResult(Object.assign({}, parsed || emptyParsed()), cloudAi), source: "cloud" };
    if (localDone && usableParsed(parsed)) return { p: parsed, source: "local" };
    return null;
  };
  /* Is MY draft the one actually visible right now — as opposed to
     stillCurrent(), which tracks state._scanSeq and is permanently false
     once superseded even after that draft has been shown via the queue. */
  const mySheetIsOpen = () => !!state.editing && state.editing._scanId === myId;
  let enqueuedDraft = null;
  let charged = false;
  /* Called for two distinct reasons — tryPaint routes both here:
     (a) superseded by a newer scan (rapid-fire) before this one had
         anything to show, or
     (b) still current, but the screen isn't free (an earlier scan from the
         same overlap already painted its own sheet, or batch mode owns it).
     Either way: don't discard the receipt or silently overwrite what's on
     screen — queue the same-quality result (cloud preferred, else local,
     else forced-local after the timeout) for review the moment the screen
     frees up. A reader that finishes AFTER this point is not dropped —
     see refreshEnqueuedDraft below, called from both completion callbacks. */
  const tryEnqueue = (force) => {
    if (cardSlip) return;
    const best = bestAvailable();
    let p, source;
    if (best) { p = best.p; source = best.source; }
    else if (force && localDone) { p = parsed || emptyParsed(); source = "local"; }
    else { return; }
    queued = true;
    const draft = parsedToDraft(p);
    draft._file = file;
    draft._scanId = myId;
    draft._source = source;
    draft.scope = preScope;
    draft.userPickedScope = preScopeTouched;
    draft._cloudPending = !cloudDone;   /* Phase 8, see openSheet's matching comment */
    draft._cardSlipPending = source === "cloud" && !localDone;   /* Phase 9 (review fix), see openSheet's matching comment */
    /* Fires once this draft actually renders (openConfirmSheet already ran)
       — captures the no-clobber baseline so a still-pending reader can
       merge in later without stomping anything the user's since edited. */
    draft.__markShown = () => { painted = capturePaintedFields(); };
    enqueuedDraft = draft;
    /* Re-check scanChargeAllowed() (not just isPro()) before charging: the
       CURRENT/surviving scan from this same rapid-fire burst may already
       have spent today's full allowance by the time this superseded scan
       gets here. Without this, two overlapping scans can both slip past
       handleImage()'s (racy, one-shot) entry gate and each bump the
       counter, letting a quick double-tap burn more than a day's
       allowance. The read already happened either way — not charging a
       second time here just avoids double-billing the user for it. */
    if (!isPro() && draftUsable(draft) && scanChargeAllowed()) { bumpScanUsed(); charged = true; }
    draft._charged = charged;
    evictOldestUnchargedIfFull(state.pendingScans);
    state.pendingScans.push(draft);
    /* If this scan is still current (queued only because the screen was
       occupied, not because a newer scan superseded it), nothing else will
       ever clear its own scanning flag/pill — a superseded scan's flag
       belongs to whichever newer scan is now current and must NOT be
       touched here. */
    if (stillCurrent()) {
      state.scanning = false;
      renderHome();
      hideScanPill();
    }
    showNextPendingScan();
  };
  /* A reader can finish AFTER tryEnqueue already ran (e.g. cloud lands after
     a local-only queue, or vice versa) — without this, that result would be
     silently dropped: the pushed draft is a one-time snapshot and nothing
     else ever revisits it. Keep it live: refresh the SAME object in place
     while it's still waiting in the queue (safe — nobody's looking at it
     yet), or merge into the open sheet via the existing no-clobber
     primitive if the user is already looking at it. */
  const refreshEnqueuedDraft = () => {
    if (cardSlip) return;
    if (!queued || !enqueuedDraft) return;
    const best = bestAvailable();
    if (!best) return;
    const sheetOpen = mySheetIsOpen();
    const stillQueued = state.pendingScans.includes(enqueuedDraft);
    /* The draft may already be gone by the time a slower reader (cloud can
       take up to CLOUD_HARD_CAP_MS) finally resolves — saved, discarded, or
       evicted (evictOldestUnchargedIfFull can drop an as-yet-uncharged
       queued draft under a large overlap). Bail BEFORE the charge check:
       charging for a result that has nowhere left to go would silently
       spend the user's daily scan on a receipt they'll never see. */
    if (!sheetOpen && !stillQueued) return;
    const fresh = parsedToDraft(best.p);
    /* tryEnqueue may have queued this as a blank/weak draft (nothing usable
       yet, so nothing charged) before either reader had enough to show —
       if THIS reader now makes it usable, charge now. Same "a read that
       produced something" rule the live path enforces via countIfUsable(),
       just applied on the delayed path instead of at paint time. */
    if (!charged && !isPro() && draftUsable(fresh) && scanChargeAllowed()) { bumpScanUsed(); charged = true; }
    if (sheetOpen) {
      if (!painted) return;   /* __markShown hasn't fired yet (shouldn't happen if mySheetIsOpen(), but stay safe) */
      /* applyCloudToOpenSheet only touches the DOM-bound fields (amount/
         merchant/category/date/items) — restore _rawText here too, same as
         reconcileLocalIntoCloudSheet does for the direct-paint path, so a
         later user total-correction can still be learned from. */
      if (!state.editing._rawText && fresh._rawText) state.editing._rawText = fresh._rawText;
      state.editing._charged = charged;
      try { applyCloudToOpenSheet(myId, fresh, painted); } catch (e) {}
      return;
    }
    Object.assign(enqueuedDraft, fresh, { _file: file, _scanId: myId, _source: best.source, _charged: charged });
  };

  /* Cloud read — fired concurrently with local below. Bounded by a generous
     hard cap (aborts a stalled socket) so the scan pill can never breathe
     forever; cloudReadTimed resolves null (never rejects) on error/timeout. */
  cloudReadTimed(file, CLOUD_HARD_CAP_MS).then(a => {
    if (cardSlip) return;   /* already blocked by local's check — see handleCardSlipDetected's HONEST LIMIT note above about a charge that may already have landed before this point */
    cloudAi = a; cloudDone = true;
    /* Phase 8: this scan's automatic cloud leg just settled (however it
       came out) — the "Re-read with AI" button was held back by
       _cloudPending while it was outstanding (openSheet/tryEnqueue),
       release it now regardless of whether mergeCloudIntoSheet below
       actually changes anything (an unusable/failed automatic read still
       means it's now safe for a manual one to run without overlapping it). */
    if (state.editing && state.editing._scanId === myId) state.editing._cloudPending = false;
    try {
      learnFromCloud();
      tryPaint(false);           /* cloud may be the first usable result */
      mergeCloudIntoSheet();     /* or merge into an already-open (local-painted) sheet */
      refreshEnqueuedDraft();    /* or fold into an already-queued/shown-via-queue draft */
      if (pillPending) settlePill();
      if (localDone) tryPaint(true);   /* both done, still nothing usable → paint what we have */
    } catch (e) {}
  });

  /* Local read. */
  (async () => {
    let p = null;
    try { p = await window.ReceiptOCR.scanReceipt(file, msg => { if (stillCurrent()) showScanPill(msg); }); }
    catch (e) { p = null; }
    localDone = true;
    try {
      /* Phase 9 card-slip guard — the ONLY point in this raced flow that can
         ever know: cloud returns a structured result, never raw OCR text to
         check. Discard p entirely (parsed stays null) BEFORE any of it can
         reach a paint/merge/learn/charge path; handleCardSlipDetected()
         retroactively tears down anything cloud already did first (see its
         own comment for the one thing it can't undo — a charge already
         landed via cloud's own race). */
      if (p && window.ReceiptOCR.looksLikeCardSlip(p.rawText)) {
        handleCardSlipDetected();
        return;
      }
      /* Cleared the check — release the Save gate openSheet/tryEnqueue may
         have set on a cloud-painted sheet/draft while this was still
         pending (see openSheet's matching comment). Set directly on
         whichever object is live right now, same pattern as _cloudPending
         just above; refreshEnqueuedDraft's Object.assign calls never touch
         this field, so it isn't at risk of being clobbered back on afterward. */
      if (state.editing && state.editing._scanId === myId) state.editing._cardSlipPending = false;
      if (enqueuedDraft && enqueuedDraft._scanId === myId) enqueuedDraft._cardSlipPending = false;
      if (p) { DB.setSetting("lastScan", p.rawText || ""); applyLearnedTotalHint(p); p._source = "local"; }
      parsed = p;
      learnFromCloud();
      reconcileLocalIntoCloudSheet();   /* if cloud already painted from empty, fold the real local read in */
      tryPaint(false);
      refreshEnqueuedDraft();    /* or fold into an already-queued/shown-via-queue draft */
      if (cloudDone) tryPaint(true);
    } catch (e) {}
  })();

  /* Cloud slower than the cap → proceed with the local result (once it's in);
     a late cloud result still merges into the open sheet before save. */
  delay(CLOUD_TIMEOUT_MS).then(() => { if (localDone) tryPaint(true); });
}

/* ---- Batch scan (Pro): read every receipt in the stack up front (one
   continuous progress indicator, no per-receipt wait), THEN let the user
   confirm each one — Save & Next / Skip just advance through the already-
   read drafts instantly, confirming the TYPE (Personal/Company/Family) on
   each before it saves. ---- */
async function startBatch(fileList) {
  const all = Array.from(fileList || []);
  const files = all.filter(f => f && f.type && f.type.indexOf("image/") === 0);
  const droppedNonImage = all.length - files.length;
  if (!files.length) { toast(all.length ? "Those weren't image files" : "No files selected"); return; }
  const MAX = 20;
  if (files.length > MAX) toast("Up to " + MAX + " at once — reading the first " + MAX);
  else if (droppedNonImage > 0) toast(droppedNonImage + " file" + (droppedNonImage > 1 ? "s" : "") + " skipped (not an image)");
  state.batchFiles = files.slice(0, MAX);
  state.batchDrafts = [];
  state.batchIndex = 0;
  state.batchSaved = 0;
  state.batchCardSlipSkipped = 0;
  state.batchTotal = state.batchFiles.length;
  state.batchMode = true;
  switchView("home");
  /* Phase 7 — "Batch: stack default": the ONE chooser-time "For:" pick
     applies to every receipt in this batch (captured here, before the file
     picker's native dialog even opens — see handleImage()'s matching note). */
  const preScope = state.preScanType === "yes" ? state.pendingScope : "Personal";
  const preScopeTouched = state.preScanType === "yes" && state.pendingScopeTouched;
  await scanAllInBatch(preScope, preScopeTouched);
  processNextInBatch();
}

/* Reads every queued file into a draft, in order, before any confirm sheet
   opens. Cancellable the same way a single scan is (tap the scan pill).
   Cloud-first (Phase 5): the cloud reads are fired up front and pipelined a few
   at a time (network-bound) while the local reads run one at a time
   (CPU-bound), so the two overlap — a receipt's cloud read is usually already
   done by the time the sequential local loop reaches it. Cloud is authoritative
   and learnFromAI fires on every raced receipt. cloudFirst off / offline /
   consent-off → each receipt keeps the classic local-first, cloud-when-weak
   behaviour. */
async function scanAllInBatch(preScope, preScopeTouched) {
  state.ocrCancelled = false;
  const files = state.batchFiles;
  const cloudOn = await cloudFirstActive();
  let cloudReads = null;
  if (cloudOn) {
    const limit = makeCloudLimiter(BATCH_CLOUD_CONCURRENCY);
    cloudReads = files.map(f => limit(() =>
      (!state.batchMode || state.ocrCancelled) ? null : cloudReadTimed(f, CLOUD_TIMEOUT_MS)
    ).catch(() => null));
  }
  for (let i = 0; i < files.length; i++) {
    if (!state.batchMode || state.ocrCancelled) break;
    const file = files[i];
    const pos = (i + 1) + " of " + state.batchTotal;
    showScanPill("Reading receipt " + pos + "…");
    let parsed = null;
    try {
      parsed = await window.ReceiptOCR.scanReceipt(file, msg => showScanPill(msg + " (" + pos + ")"));
    } catch (err) { parsed = null; }
    if (!state.batchMode || state.ocrCancelled) break;
    /* Phase 9 card-slip guard. Batch's own cloud reads (cloudOn path) are
       ALL fired up front via files.map() before this loop even starts —
       same HONEST LIMIT as the single-scan raced flow: this receipt's own
       cloud request may already be in flight by the time this check runs.
       What IS fully within reach: never await/use cloudReads[i]'s result
       (so nothing from it merges, gets learned from, or is shown), no
       photo, no draft pushed for review — skip straight to the next file.
       No mid-batch confirm() interruption (batch reads everything up front,
       before the user reviews anything) — summarized once at finishBatch()
       instead. */
    if (parsed && window.ReceiptOCR.looksLikeCardSlip(parsed.rawText)) {
      state.batchCardSlipSkipped++;
      continue;
    }
    if (parsed) applyLearnedTotalHint(parsed);

    let source = "local";
    if (cloudOn) {
      showScanPill("Reading with cloud… (" + pos + ")");
      const ai = await cloudReads[i];
      if (!state.batchMode || state.ocrCancelled) break;
      if (ai) {
        if (parsed) learnFromAI(parsed.rawText, ai, parsed.total, parsed.merchant);
        if (cloudUsable(ai)) { parsed = mergeAIResult(parsed || emptyParsed(), ai); source = "cloud"; }
      }
    } else if (parsed) {
      /* classic: cloud only when the local read is weak */
      const weak = parsed.total === null || (parsed.totalConf || 0) <= 1;
      if (cloudEndpoint() && weak && state.cloudConsent !== "no") {
        showScanPill("Reading with cloud… (" + pos + ")");
        try {
          const ai = await cloudRead(file);
          if (state.ocrCancelled || !state.batchMode) break;
          learnFromAI(parsed.rawText, ai, parsed.total, parsed.merchant);
          mergeAIResult(parsed, ai);
          if (ai && ai.readable !== false) source = "cloud";
        } catch (err) { /* keep the on-device result and carry on */ }
      }
    }

    if (parsed) {
      const draft = parsedToDraft(parsed);
      draft._file = file;
      draft._source = source;
      draft.scope = preScope;
      draft.userPickedScope = preScopeTouched;
      state.batchDrafts.push(draft);
    } else {
      /* Unreadable by both — still queue it so the user can type it in and keep going. */
      state.batchDrafts.push({
        amount: null, merchant: "", category: "Other", scope: preScope, userPickedScope: preScopeTouched,
        date: new Date().toISOString(), items: [], note: "", fromReceipt: true, _file: file, _source: "local"
      });
    }
  }
  hideScanPill();
}

function processNextInBatch() {
  if (!state.batchMode) return;
  if (state.batchIndex >= state.batchDrafts.length) { finishBatch(); return; }
  openConfirmSheet(state.batchDrafts[state.batchIndex]);
}

function finishBatch() {
  const saved = state.batchSaved, total = state.batchTotal, cardSlipSkipped = state.batchCardSlipSkipped;
  state.batchMode = false;
  state.batchFiles = []; state.batchDrafts = []; state.batchIndex = 0; state.batchTotal = 0; state.batchSaved = 0; state.batchCardSlipSkipped = 0;
  hideScanPill();
  switchView("home");
  renderHome();
  /* Phase 9 card-slip guard: batch skips these silently mid-scan (no
     mid-batch confirm() interruption — see scanAllInBatch's comment), so
     this is the first and only place the user learns why the count is
     short. A leftover state.pendingScans entry (from the independent
     single-scan racing flow — batch doesn't clear it) makes
     showNextPendingScan() below fire its own deferred toast that would
     otherwise silently clobber this one (see its own "reliably lands last
     and wins" comment) — so the card-slip message is threaded through as
     that call's priority message instead of raced against it. */
  let msg = null;
  if (cardSlipSkipped > 0) {
    msg = (saved > 0 ? "Added " + saved + " receipt" + (saved > 1 ? "s" : "") + " — " : "") +
      "skipped " + cardSlipSkipped + " that looked like payment cards or ID documents";
  } else if (saved > 0) {
    msg = "Added " + saved + " receipt" + (saved > 1 ? "s" : "") + (saved < total ? " of " + total : "");
  }
  if (msg) toast(msg);
  showNextPendingScan(cardSlipSkipped > 0 ? msg : null);
}

function parsedToDraft(parsed) {
  const d = parsed.date || new Date();
  if (parsed.time) d.setHours(parsed.time.h, parsed.time.min, 0, 0);
  else if (!parsed.date) { /* keep now */ }
  else { const now = new Date(); d.setHours(now.getHours(), now.getMinutes(), 0, 0); }
  const brand = brandOf(normMerchant(parsed.merchant || ""));
  const preferredName = safeGet(state.merchantNames, brand) || safeGet(SEED_RULES.names, brand);
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
    scope: state.preScanType === "yes" ? state.pendingScope : "Personal",
    userPickedScope: state.preScanType === "yes" && state.pendingScopeTouched,
    date: new Date().toISOString(), items: [], note: "", fromReceipt: false
  };
  const e = state.editing;

  $("confirm-title").textContent = e.id ? "Edit expense" : (e.fromReceipt ? "Check & save" : "New expense");
  /* Batch mode: a "Receipt X of N" badge, a Skip button, and a Save button that
     rolls straight on to the next receipt. The user's job here is the Type. */
  const bBadge = $("batch-badge"), bSkip = $("batch-skip"), bSave = $("save-btn");
  if (state.batchMode && !e.id) {
    const last = state.batchIndex + 1 >= state.batchTotal;
    if (bBadge) { bBadge.hidden = false; bBadge.textContent = "Receipt " + (state.batchIndex + 1) + " of " + state.batchTotal; }
    if (bSkip) bSkip.hidden = false;
    if (bSave) bSave.textContent = last ? "Save & finish" : "Save & next";
  } else {
    if (bBadge) bBadge.hidden = true;
    if (bSkip) bSkip.hidden = true;
    if (bSave) bSave.textContent = "Save";
  }
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
  $("confirm-date").value = localDateStr(d);
  $("confirm-time").value = localTimeStr(d);
  $("confirm-note").value = e.note || "";

  renderScopeChips();
  renderClaimChips();
  renderCategoryChips();
  renderPhotoBlock();
  renderItemsEditor();
  renderAiRecheckButton();

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
    img.loading = "lazy";
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
    price.addEventListener("input", () => { e.items[idx].price = parseAmountInput(price.value) || 0; });
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

/* A rapid-fire scan that finished after being superseded (see tryEnqueue in
   handleImageRaced) sits in state.pendingScans instead of being discarded.
   Surface it the moment the screen is actually free — never interrupts a
   scan still in flight, an open sheet, or Pro's own batch flow. */
function showNextPendingScan(priorityMsg) {
  if (state.scanning || !screenFree()) return;
  if (!state.pendingScans || !state.pendingScans.length) return;
  const draft = state.pendingScans.shift();
  openConfirmSheet(draft);
  /* Tell the originating scan's closure (if any — handleImageLocalFirst's
     drafts don't set this) that it's actually on screen now, so a
     still-pending reader can merge into it later without clobbering
     anything the user's since edited (see refreshEnqueuedDraft). */
  if (typeof draft.__markShown === "function") { draft.__markShown(); delete draft.__markShown; }
  /* toast()/toastAction() share one DOM slot with no queueing — every call
     site that leads here (save, delete, cancel, finishBatch) already fires
     its own toast in the same synchronous turn, in inconsistent order. Defer
     by a tick so this one — the only thing explaining why the sheet just
     changed under the user — reliably lands last and wins, instead of a coin
     flip on call-site ordering. A caller with something more important to say
     than the generic "also caught" line (finishBatch's card-slip-skip count,
     which explains why the batch total came up short) passes it as
     priorityMsg so it wins this slot instead of being silently overwritten. */
  const msg = priorityMsg || (draftUsable(draft)
    ? "Also caught this receipt — check & save"
    : "Also caught a receipt, but couldn't read it — check & save it manually");
  setTimeout(() => toast(msg), 300);
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
  /* Dismissing the sheet mid-stack (X / backdrop / Esc) ends the batch and
     keeps whatever was already saved. A save passes force=true and advances. */
  if (!force && state.batchMode) finishBatch();
  showNextPendingScan();
}

async function saveExpense() {
  const e = state.editing;
  if (!e) return;
  /* Phase 9 (review fix): a cloud-painted sheet from handleImageRaced opens
     fully save-able before the on-device card-slip check (which can only
     run once local's own rawText is in) has had a chance to resolve —
     without this gate, a fast Save tap in that window would persist a
     payment-card photo and learn from it, the exact thing the guard exists
     to prevent. Self-clears within ~1-2s once local's check lands either
     way (openSheet/tryEnqueue stamp it, the local IIFE in handleImageRaced
     clears it — see their matching comments); if it turns out to actually
     be a card slip the sheet gets torn down out from under this anyway. */
  if (e._cardSlipPending) { toast("Still checking this photo — try again in a moment"); return; }
  const amount = parseAmountInput($("confirm-amount").value);
  /* With the Claude inbox configured, a scanned receipt may be saved without
     an amount — Claude fills it in later. */
  const canPend = !!(!e.id && e.fromReceipt && e._file && state.ghToken);
  if (!(amount > 0) && !canPend) { toast("Enter an amount"); $("confirm-amount").focus(); return; }

  /* Save is async — a fast double-tap must not create two expenses. */
  if (state._saving) return;
  state._saving = true;
  const saveBtn = $("save-btn");
  if (saveBtn) saveBtn.disabled = true;
  try {

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

  /* The Claude inbox only receives receipts that still NEED filling (saved
     without an amount). Instant-read receipts are already complete — sending
     them too would just burn duplicate processing. */
  if (!e.id && e._file && state.ghToken && record.pending) {
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
  /* Batch: this receipt is saved — roll straight on to the next one. */
  if (state.batchMode && !e.id) {
    state.batchSaved++;
    state.batchIndex++;
    renderHome();
    processNextInBatch();
    return;
  }
  const saved = new Date(record.date);
  const now = new Date();
  state.monthOffset = (saved.getFullYear() - now.getFullYear()) * 12 + (saved.getMonth() - now.getMonth());
  /* An edit made from the Insights day sheet returns to Insights, not Home. */
  switchView(state.view === "insights" ? "insights" : "home");
  if (record.pending) {
    toast("Saved — Claude will fill it in");
  } else if (!e.id && e._file) {
    /* Fresh scan saved — keep the batch momentum going. */
    toastAction("Saved " + fmtRM(record.amount, true), "Snap another", () => pickImage("camera"), null, 6000);
  } else {
    toast(e.id ? "Updated" : "Saved " + fmtRM(record.amount, true));
  }

  } finally {
    state._saving = false;
    if (saveBtn) saveBtn.disabled = false;
  }
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

/* CSV/Excel formula-injection guard (CWE-1236): merchant/note/item text can
   come from OCR/cloud-AI reads of a receipt photo (an explicitly untrusted
   source — see the card-slip guard) or a restored backup file. A value
   starting with =, +, -, or @ is interpreted as a live formula by Excel/
   Sheets on open, not as a text label — CSV's own quoting only escapes the
   delimiter, it does nothing to stop formula evaluation. A leading
   apostrophe forces text and is the standard mitigation. */
function csvSafe(v) {
  const s = String(v == null ? "" : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function expenseExportRecords(f) {
  return filteredExpenses(f)
    .map(e => {
      const d = new Date(e.date);
      const amount = Number(e.amount) || 0;
      return {
        date: d.toLocaleDateString(appLocale()),
        time: d.toTimeString().slice(0, 5),
        merchant: csvSafe(e.merchant || ""),
        category: e.category || "",
        type: scopeOf(e),
        claim: e.claimStatus === "to-claim" ? "To claim" : e.claimStatus === "claimed" ? "Claimed" : "",
        amount,
        note: csvSafe(e.note || ""),
        items: csvSafe((e.items || []).map(i => `${(i && i.name) || ""} ${(Number(i && i.price) || 0).toFixed(2)}`.trim()).join("; "))
      };
    });
}

async function exportCSV(filter) {
  const recs = expenseExportRecords(filter);
  if (!recs.length) { toast("Nothing to export" + (filter ? " for those filters" : " yet")); return 0; }
  const rows = [exportHeaders()];
  for (const r of recs) rows.push([r.date, r.time, r.merchant, r.category, r.type, r.claim, r.amount.toFixed(2), r.note, r.items]);
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  try {
    await downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), "recap-expenses.csv");
  } catch (e) { toast(e.message || "Couldn't save the file"); return 0; }
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
  try {
    await downloadBlob(new Blob(["﻿" + html], { type: "application/vnd.ms-excel;charset=utf-8" }), (baseName || "recap-expenses") + ".xls");
  } catch (e) { toast(e.message || "Couldn't save the file"); return 0; }
  return recs.length;
}

/* Full backup: everything needed to rebuild the app on a new phone. Secrets
   (GitHub token, AI code) and the cached scan/photos are deliberately left out
   so the file is safe to store and small. */
async function exportBackup() {
  const settingsAll = await DB.getAllSettings();
  /* Never export: secrets, the Pro entitlement (a shared backup file must not
     grant Pro), this device's identity, or transient counters. */
  const SKIP = new Set(["ghToken", "aiSecret", "lastScan", "pro", "playEntitled", "deviceId", "lastBackupAt", "backupNudgeSnooze", "licenseKey", "lastKeyCheck", "ghProven", "skipResults"]);
  const settings = settingsAll.filter(s => s && s.key && !SKIP.has(s.key));
  const expenses = state.expenses.map(({ photo, ...rest }) => rest);
  const backup = { app: "recap", type: "backup", version: 1, exportedAt: new Date().toISOString(), expenses, settings };
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    await downloadBlob(new Blob([JSON.stringify(backup)], { type: "application/json" }), "recap-backup-" + stamp + ".json");
  } catch (e) { toast(e.message || "Couldn't save the backup"); return; }
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
    /* "Shared" is kept recognised even when it isn't in the CURRENT
       state.scopes (e.g. a fresh/erased device) — see the comment near
       DEFAULT_SCOPES: pre-1.10 data must never collapse to Personal. */
    scope: (allScopes().includes(e.scope) || e.scope === "Shared") ? e.scope : "Personal",
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
  /* Accept both the new "recap" tag and legacy "resit" backups (pre-rename). */
  if (!data || (data.app !== "recap" && data.app !== "resit") || !Array.isArray(data.expenses)) { toast("That doesn't look like a Recap backup"); return; }
  if (!confirm("Restore " + data.expenses.length + " expenses from this backup? It replaces everything currently in the app.")) return;

  /* Adopt custom types from the backup (settings and any sane scope strings
     on the expenses themselves) BEFORE sanitizing, so no expense loses its
     type by falling back to Personal. */
  const fromSettings = data.settings && Array.isArray(data.settings.customScopes) ? data.settings.customScopes : [];
  const foundScopes = new Set(fromSettings.filter(s => typeof s === "string" && s && s.length <= 14));
  for (const e of data.expenses) {
    const s = e && e.scope;
    if (typeof s === "string" && s && s.length <= 14 && !DEFAULT_SCOPES.includes(s) && s !== "Shared") foundScopes.add(s);
  }
  let scopesChanged = false;
  for (const s of foundScopes) if (!state.customScopes.includes(s)) { state.customScopes.push(s); scopesChanged = true; }
  if (scopesChanged) await DB.setSetting("customScopes", state.customScopes);

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
      /* aiUrl + cloudConsent are rejected too: a crafted backup must not be
         able to plant a photo-exfil endpoint or silently pre-approve cloud
         reading (security review, 1.9.0). Also reject the device-local
         bookkeeping fields SKIP already keeps out of every legitimate
         export, so a crafted file can't inject fake ones either — and
         playEntitled (Phase 18), a shared backup file must not be able to
         grant Play-billing Pro any more than the license-key/ghProven
         fields above it. */
      const REJECT = new Set(["pro", "playEntitled", "deviceId", "ghToken", "aiSecret", "aiUrl", "cloudConsent", "licenseKey", "lastKeyCheck", "ghProven", "skipResults", "shareQueue", "shareRules", "lastRuleUpload", "lastBackupAt", "backupNudgeSnooze"]);
      for (const s of data.settings) { if (s && s.key && !REJECT.has(s.key)) await DB.setSetting(s.key, s.value); }
      /* cloudConsent/shareRules are rejected above so a crafted backup can
         never silently switch them ON — but that also means a user's OWN
         legitimate opt-OUT is lost on erase+restore, quietly reverting to
         the enabled default. Restoring an explicit "no" only ever makes
         things MORE private, so it's safe in both directions — allow it. */
      const cc = data.settings.find(s => s && s.key === "cloudConsent");
      if (cc && cc.value === "no") await DB.setSetting("cloudConsent", "no");
      const sr = data.settings.find(s => s && s.key === "shareRules");
      if (sr && sr.value === "no") await DB.setSetting("shareRules", "no");
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
  const rsc = await DB.getSetting("scopes", DEFAULT_SCOPES);
  state.scopes = Array.isArray(rsc) && rsc.length ? rsc.filter(s => DEFAULT_SCOPES.includes(s) || s === "Shared") : DEFAULT_SCOPES.slice();
  if (!state.scopes.length) state.scopes = DEFAULT_SCOPES.slice();
  const rcsc = await DB.getSetting("customScopes", []);
  state.customScopes = Array.isArray(rcsc) ? rcsc.filter(s => typeof s === "string" && s && s.length <= 14) : [];
  /* Cloud reading is on by default (1.10.0); a restore keeps the on-device setting. */
  state.cloudConsent = await DB.getSetting("cloudConsent", "yes");
  state.shareRules = await DB.getSetting("shareRules", "");
  state.theme = await DB.getSetting("theme", "light");
  applyTheme();
  switchView("home");
  toast("Restored " + clean.length + " expenses");
}

/* Blob -> bare base64 (no data-URL prefix), for the native Filesystem
   bridge. Mirrors ocr.js's fileToBase64 (same pattern, kept local — ocr.js
   loads before app.js and neither depends on the other). */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || "");
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    fr.onerror = () => reject(new Error("Could not read the export data."));
    fr.readAsDataURL(blob);
  });
}

/* A plain `<a download>` click on a blob: URL is a no-op in the native
   Capacitor WebView — Chromium's blob-download handling needs a registered
   native download listener, which this app never wires up, so the click
   silently does nothing (confirmed live: no file, no dialog, nothing —
   OCR-ENGINE-PLAN.md Phase 4's backup/restore smoke check). On native,
   write the blob to the app's cache dir via @capacitor/filesystem, then
   hand it to the OS share sheet via @capacitor/share so the user can save
   it to Downloads/Drive/email/wherever — same two-plugin pattern as
   captureNative()'s Camera usage above (window.Capacitor.Plugins.X, no
   registerPlugin — this app has no bundler to resolve that). Web/PWA path
   is completely unchanged. */
async function downloadBlob(blob, name) {
  if (isNative()) {
    const Fs = window.Capacitor.Plugins.Filesystem;
    const Sh = window.Capacitor.Plugins.Share;
    if (Fs && Sh) {
      const base64 = await blobToBase64(blob);
      const written = await Fs.writeFile({ path: name, data: base64, directory: "CACHE" });
      await Sh.share({ title: name, url: written.uri, dialogTitle: "Save " + name });
      return;
    }
    throw new Error("Saving files isn't available on this build");
  }
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
    state.country = await DB.getSetting("country", "MY");
    state.language = await DB.getSetting("language", "en");
    const cscopes = await DB.getSetting("customScopes", []);
    state.customScopes = Array.isArray(cscopes) ? cscopes.filter(s => typeof s === "string" && s && s.length <= 14) : [];
    const sscopes = await DB.getSetting("scopes", DEFAULT_SCOPES);
    state.scopes = Array.isArray(sscopes) && sscopes.length ? sscopes.filter(s => DEFAULT_SCOPES.includes(s) || s === "Shared") : DEFAULT_SCOPES.slice();
    if (!state.scopes.length) state.scopes = DEFAULT_SCOPES.slice();
    state.recurring = await DB.getSetting("recurringTemplates", []);
    state.ghProven = await DB.getSetting("ghProven", false);
    state.skipResults = await DB.getSetting("skipResults", []);
    state.theme = await DB.getSetting("theme", "light");
    state.aiUrl = await DB.getSetting("aiUrl", "");
    state.aiSecret = await DB.getSetting("aiSecret", "");
    state.ghToken = await DB.getSetting("ghToken", "");
    /* Cloud reading is ON by default (1.10.0, informed default disclosed at
       setup); a user who turns it off in Settings persists "no". */
    state.cloudConsent = await DB.getSetting("cloudConsent", "yes");
    /* Phase 7/8 (OCR-ENGINE-PLAN.md) — both default ON, no Settings UI (same
       dark/silent-flag convention as cloudFirst). */
    state.preScanType = await DB.getSetting("preScanType", "yes");
    state.aiRecheck = await DB.getSetting("aiRecheck", "yes");
    state.lastScope = await DB.getSetting("lastScope", "Personal");
    state.pendingScope = state.lastScope;
    state.cardNoticeSeen = await DB.getSetting("cardNoticeSeen", "");
    state.deviceId = await DB.getSetting("deviceId", "");
    if (!state.deviceId) {
      state.deviceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      await DB.setSetting("deviceId", state.deviceId);
    }
    state.pro = await DB.getSetting("pro", false);
    state.playEntitled = await DB.getSetting("playEntitled", false);
    state.scanDay = await DB.getSetting("scanDay", "");
    state.scanCount = await DB.getSetting("scanCount", 0);
    state.quotaNoticeDay = await DB.getSetting("quotaNoticeDay", "");
    state.lastBackupAt = await DB.getSetting("lastBackupAt", null);
    state.backupNudgeSnooze = await DB.getSetting("backupNudgeSnooze", "");
    state.licenseKey = await DB.getSetting("licenseKey", "");
    state.lastKeyCheck = await DB.getSetting("lastKeyCheck", "");
    state.eulaAccepted = await DB.getSetting("eulaAccepted", "");
    state.setupDone = await DB.getSetting("setupDone", false);
    if (!state.setupDone && state.eulaAccepted) {
      /* Migration for installs from before setupDone existed. eulaAccepted
         truthy alone can't tell a genuinely-completed install apart from a
         genuinely-interrupted one — both look identical the very first time
         this code runs — so infer completion from a persisted "country"
         setting instead: it's the very next thing the wizard saves after
         terms (setup-country-next), so its presence means step 1 was
         actually cleared at some point. Without this, a real interruption
         happening AFTER this fix ships would grandfather itself away on its
         own next boot, silently defeating the whole point of the fix. */
      const pastStep1 = (await DB.getSetting("country", null)) !== null;
      if (pastStep1) {
        state.setupDone = true;
        try { await DB.setSetting("setupDone", true); } catch (e) {}
      }
    }
    /* Shared learning loop: outbox + share preference + weekly-upload clock. */
    state.shareQueue = await DB.getSetting("shareQueue", []);
    if (!Array.isArray(state.shareQueue)) state.shareQueue = [];
    state.shareRules = await DB.getSetting("shareRules", "");
    state.lastRuleUpload = await DB.getSetting("lastRuleUpload", 0);
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

  /* First run = the 5-step setup wizard (terms → country → types → budget
     → done). A returning user after a TERMS_VERSION bump only re-accepts
     the terms card. No backdrop-close, no cancel — Agree is the only way
     in. (If storage failed above, eulaAccepted reads "" — showing the gate
     again is the safe direction.) A user who accepted terms but never
     finished the rest of the wizard (app closed mid-setup) resumes at
     step 2 instead of being silently dropped onto the home screen with
     unconfirmed defaults — setupDone only becomes true at genuine finish. */
  const termsStale = (state.eulaAccepted || "").split("|")[0] !== TERMS_VERSION;
  if (termsStale || !state.setupDone) {
    const ov = $("setup-overlay");
    if (ov) {
      const resuming = !termsStale && !state.setupDone;
      /* mode="terms" only for the genuine "already fully finished, terms
         just changed" case (setupDone true) — NOT keyed off eulaAccepted
         alone, which is also truthy for a resuming (interrupted) user and
         would otherwise show the terms-only card instead of resuming the
         full wizard. */
      ov.dataset.mode = state.setupDone ? "terms" : "full";
      ov.dataset.step = resuming ? "2" : "1";
      if (resuming) {
        const sc = $("setup-country"), scur = $("setup-currency");
        if (sc) sc.value = state.country || "MY";
        if (scur) scur.value = state.currency || "RM";
      } else if (state.eulaAccepted) {
        const t = $("eula-title");
        if (t) t.textContent = "We've updated the terms";
      }
      ov.hidden = false;
      /* The veil only blocks pointers — make everything else inert so
         keyboard / screen-reader users can't operate the app beneath it. */
      for (const el of document.querySelectorAll("body > *:not(#setup-overlay):not(script)")) el.inert = true;
      const btn = resuming ? $("setup-country-next") : $("eula-accept");
      if (btn) btn.focus();
    }
  }

  /* Play Billing (Phase 18): configure RevenueCat + re-check the entitlement.
     Only AFTER the current terms are accepted — the SDK talks to RevenueCat's
     servers the moment it's configured, and the notice/terms cover that. A
     first-run user gets it from the eula-accept handler instead. Re-check on
     every foreground too (a lapsed or refunded subscription downgrades within
     the session; a pending payment that cleared unlocks). Inert on the web
     and while the key is unset. */
  if (!termsStale) initBilling();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && _billingConfigured) refreshPlayEntitlement();
  });

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

  /* Shared learning loop: at most once a week, upload the AI-derived reading
     rules this device has staged, so everyone's reader improves. Gated HARD on
     explicit cloud consent AND the share toggle (no consent -> no cloud -> no
     sharing). Fire-and-forget: only the {garbled,clean,hint} triples leave —
     no ids, amounts, dates or images — and any failure just retries next boot.
     See SHARED-RULES-PLAN.md privacy invariants. */
  (async () => {
    if (!cloudEndpoint() || state.cloudConsent !== "yes" || state.shareRules === "no") return;
    if (!navigator.onLine || !Array.isArray(state.shareQueue) || !state.shareQueue.length) return;
    const last = state.lastRuleUpload ? new Date(state.lastRuleUpload).getTime() : 0;
    if (last && Date.now() - last < 7 * 86400000) return;
    const rules = state.shareQueue.slice(0, 25);
    try {
      const res = await fetch(cloudEndpoint().replace(/\/+$/, "") + "/rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules, appVer: APP_VERSION })
      });
      if (res.ok) {
        /* Remove ONLY the rows we uploaded (by identity), never the whole
           queue — a scan can enqueue a fresh rule during the in-flight POST,
           and learnFromAI stages each rule once, so wiping it would drop it
           from the pool for good. */
        const sent = new Set(rules);
        state.shareQueue = (Array.isArray(state.shareQueue) ? state.shareQueue : []).filter(r => !sent.has(r));
        state.lastRuleUpload = new Date().toISOString();
        await DB.setSetting("shareQueue", state.shareQueue);
        await DB.setSetting("lastRuleUpload", state.lastRuleUpload);
      }
    } catch (e) { /* offline/transient — retry next boot */ }
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
  if (si) {
    /* Debounced: every keystroke used to rebuild the whole ledger. */
    let searchTimer = null;
    si.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = si.value; renderHome(); }, 150);
    });
  }

  /* Escape closes whichever dismissible sheet is open — never the EULA or
     consent gates (those need an explicit choice). The confirm sheet uses
     its normal close, which may ask about unsaved changes. */
  document.addEventListener("keydown", ev => {
    if (ev.key !== "Escape") return;
    for (const id of ["photo-overlay", "menu-overlay", "chooser-overlay", "upgrade-overlay",
      "export-overlay", "day-overlay", "statement-overlay", "bulk-overlay"]) {
      const ov = $(id);
      if (ov && !ov.hidden) {
        if (id === "statement-overlay") { const fr = $("statement-frame"); if (fr) fr.srcdoc = ""; }
        ov.hidden = true;
        return;
      }
    }
    if (state.selectMode) { exitSelectMode(); return; }
    const co = $("confirm-overlay");
    if (co && !co.hidden) closeConfirmSheet();
  });

  /* Focus trap (PROPOSED, 2026-08 a11y audit — Phase 10 design →
     Phase 11 implementation) for every role="dialog" overlay: remember the
     element that opened it, move focus inside on open, keep Tab/Shift+Tab
     cycling within it while open, restore focus to the opener on close.
     Esc + backdrop-click close already existed (above / per-overlay click
     handlers). A MutationObserver per dialog reacts to its `hidden`
     attribute however it gets toggled, rather than needing to touch the
     ~30 scattered open/close call sites individually — far less likely to
     miss one than threading trap logic through every site by hand. */
  const dialogOpeners = new WeakMap();
  const focusableIn = container => [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(el => el.offsetParent !== null);
  document.querySelectorAll('.overlay[role="dialog"]').forEach(ov => {
    new MutationObserver(() => {
      if (!ov.hidden) {
        dialogOpeners.set(ov, document.activeElement);
        const first = focusableIn(ov)[0];
        if (first) first.focus(); else { ov.setAttribute("tabindex", "-1"); ov.focus(); }
      } else {
        const opener = dialogOpeners.get(ov);
        dialogOpeners.delete(ov);
        if (opener && document.body.contains(opener) && typeof opener.focus === "function") opener.focus();
      }
    }).observe(ov, { attributes: true, attributeFilter: ["hidden"] });
  });
  document.addEventListener("keydown", ev => {
    if (ev.key !== "Tab") return;
    const open = document.querySelector('.overlay[role="dialog"]:not([hidden])');
    if (!open) return;
    const focusables = focusableIn(open);
    if (!focusables.length) { ev.preventDefault(); return; }
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (!open.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
    else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });

  /* Hero shortcuts: the big total jumps to the spending summary; the
     budget figure jumps straight to editing the budget. */
  on("month-total", () => switchView("insights"));
  on("hero-budget-col", () => {
    switchView("settings");
    setTimeout(() => {
      const b = $("budget-input");
      if (b) { b.scrollIntoView({ block: "center", behavior: "smooth" }); b.focus(); }
    }, 80);
  });

  /* Multi-select bar */
  on("select-cancel", exitSelectMode);
  on("select-edit", () => {
    if (!isPro()) { showUpgrade("Fix a whole month in one move — bulk editing comes with Pro."); return; }
    if (!state.selected || !state.selected.size) return;
    state._bulk = { cat: null, scope: null };
    $("bulk-title").textContent = "Bulk update (" + state.selected.size + ")";
    renderBulkChips();
    $("bulk-overlay").hidden = false;
  });
  on("bulk-back", () => { $("bulk-overlay").hidden = true; });
  on("bulk-overlay", ev => { if (ev.target === $("bulk-overlay")) $("bulk-overlay").hidden = true; });
  on("bulk-apply", async () => {
    const { cat, scope } = state._bulk || {};
    if (!cat && !scope) { toast("Pick a category or type first"); return; }
    let n = 0;
    for (const e of state.expenses) {
      if (!state.selected || !state.selected.has(e.id)) continue;
      if (cat) e.category = cat;
      if (scope) {
        e.scope = scope;
        if (scope === "Personal") e.claimStatus = "";
        else if (isPro() && scope === "Company" && !e.claimStatus) e.claimStatus = "to-claim";
      }
      await DB.updateExpense(e);
      n++;
    }
    $("bulk-overlay").hidden = true;
    exitSelectMode();
    toast("Updated " + n + " expense" + (n > 1 ? "s" : ""));
  });
  on("select-delete", async () => {
    const victims = state.expenses.filter(x => state.selected && state.selected.has(x.id));
    if (!victims.length) { exitSelectMode(); return; }
    state.expenses = state.expenses.filter(x => !state.selected.has(x.id));
    exitSelectMode();
    toastAction("Deleted " + victims.length + " expense" + (victims.length > 1 ? "s" : ""), "Undo",
      () => { state.expenses.push(...victims); renderCurrent(); },
      async () => { for (const v of victims) { try { await DB.deleteExpense(v.id); } catch (e) {} } });
  });

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
  $("choose-batch").addEventListener("click", () => {
    $("chooser-overlay").hidden = true;
    if (!isPro()) { showUpgrade("Scan a whole stack of receipts in one go with Pro — confirm the type on each as it flies past."); return; }
    $("batch-input").click();
  });
  $("batch-input").addEventListener("change", ev => { startBatch(ev.target.files); ev.target.value = ""; });
  $("choose-manual").addEventListener("click", () => { $("chooser-overlay").hidden = true; openConfirmSheet(null); });
  $("chooser-overlay").addEventListener("click", ev => { if (ev.target === $("chooser-overlay")) $("chooser-overlay").hidden = true; });

  $("camera-input").addEventListener("change", ev => { handleImage(ev.target.files[0]); ev.target.value = ""; });
  $("gallery-input").addEventListener("change", ev => { handleImage(ev.target.files[0]); ev.target.value = ""; });
  /* Tapping the breathing scan pill cancels the read (the ✓ state doesn't). */
  on("scan-pill", () => {
    const p = $("scan-pill");
    /* state.scanning only covers the single-scan paths — during a batch's
       up-front read (scanAllInBatch) it's never set, which used to make
       this tap a silent no-op with no way to abort a mid-batch read.
       state.batchMode also covers the later per-receipt confirm-sheet
       review phase, but the pill is hidden (unclickable) by then anyway. */
    if (!(state.scanning || state.batchMode) || (p && p.classList.contains("done"))) return;
    state.ocrCancelled = true;         /* stops an in-progress batch read (scanAllInBatch) */
    state.cancelledScanIds.add(state._scanSeq);  /* stops specifically the scan currently on the pill (handleImageRaced/handleImageLocalFirst) */
    state.scanning = false;
    hideScanPill();
    renderHome();
    toast("Cancelled");
    showNextPendingScan();
  });

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
  $("ai-recheck-btn").addEventListener("click", reReadWithAI);
  $("batch-skip").addEventListener("click", () => {
    if (!state.batchMode) return;
    state.batchIndex++;
    closeConfirmSheet(true); /* force = don't end the batch */
    processNextInBatch();
  });

  $("budget-input").addEventListener("change", async () => {
    const v = parseFloat($("budget-input").value) || 0;
    state.budget = v;
    await DB.setSetting("budget", v);
    toast("Budget saved");
  });
  /* Profile: country drives locale formats; language is English-only today. */
  const cosel = $("country-select");
  if (cosel) cosel.addEventListener("change", async () => {
    state.country = cosel.value;
    await DB.setSetting("country", state.country);
    renderHome();
  });
  const lgsel = $("language-select");
  if (lgsel) lgsel.addEventListener("change", async () => {
    state.language = lgsel.value;
    await DB.setSetting("language", state.language);
  });

  /* Monthly-expense form: add a repeating template directly from Settings. */
  const recCat = $("rec-cat");
  if (recCat) for (const c of CATS) { const o = document.createElement("option"); o.value = c.name; o.textContent = c.name; recCat.appendChild(o); }
  on("rec-add", async () => {
    /* Async — a fast double-tap must not push two duplicate templates
       (each of which would then materialize its own duplicate expense). */
    if (state._addingRecurring) return;
    const name = ($("rec-name").value || "").trim();
    const amount = parseFloat($("rec-amount").value);
    const day = Math.min(31, Math.max(1, parseInt($("rec-day").value, 10) || 1));
    const every = parseInt($("rec-freq").value, 10) || 1;
    if (!name) { toast("Give it a name"); $("rec-name").focus(); return; }
    if (!(amount > 0)) { toast("Enter an amount"); $("rec-amount").focus(); return; }
    state._addingRecurring = true;
    const recAddBtn = $("rec-add");
    if (recAddBtn) recAddBtn.disabled = true;
    try {
      const now = new Date();
      /* Backdate lastMonth by one interval so the first entry lands in the
         CURRENT month (dated its day) as soon as materializeRecurring runs. */
      const start = new Date(now.getFullYear(), now.getMonth() - every, 1);
      state.recurring.push({
        merchant: name.slice(0, 40), amount: Math.round(amount * 100) / 100,
        category: (recCat && recCat.value) || "Bills", scope: "Personal",
        day, every, note: "", lastMonth: monthKeyOf(start)
      });
      await DB.setSetting("recurringTemplates", state.recurring);
      $("rec-name").value = ""; $("rec-amount").value = ""; $("rec-day").value = "";
      renderRecurringList();
      await materializeRecurring();
      toast("Added — Recap takes it from here");
    } finally {
      state._addingRecurring = false;
      if (recAddBtn) recAddBtn.disabled = false;
    }
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
  /* --- First-run setup wizard --- */
  const finishSetup = () => {
    const ov = $("setup-overlay");
    if (ov) ov.hidden = true;
    for (const el of document.querySelectorAll("body > [inert]")) el.inert = false;
    if (!state.setupDone) {
      state.setupDone = true;
      DB.setSetting("setupDone", true).catch(() => {});
    }
    renderHome();
  };
  const COUNTRY_CURRENCY = { MY: "RM", SG: "SGD", ID: "IDR", TH: "THB", PH: "PHP", VN: "VND", BN: "BND", IN: "INR", AU: "AUD", GB: "GBP", US: "USD", OT: "RM" };
  on("eula-accept", async () => {
    state.eulaAccepted = TERMS_VERSION + "|" + new Date().toISOString(); /* terms version | when */
    try { await DB.setSetting("eulaAccepted", state.eulaAccepted); }
    catch (e) {} /* storage broken → the gate simply returns next launch; never a dead button */
    initBilling(); /* Play Billing waits for the terms (see init) — inert on web / unset key */
    const ov = $("setup-overlay");
    if (!ov || ov.dataset.mode === "terms") { finishSetup(); return; }
    const sc = $("setup-country"), scur = $("setup-currency");
    if (sc) sc.value = state.country || "MY";
    if (scur) scur.value = state.currency || "RM";
    ov.dataset.step = "2";
    ov.setAttribute("aria-labelledby", "setup-step2-title");
  });
  const scSel = $("setup-country");
  if (scSel) scSel.addEventListener("change", () => {
    const scur = $("setup-currency");
    if (scur) scur.value = COUNTRY_CURRENCY[scSel.value] || "RM";
  });
  on("setup-country-next", async () => {
    state.country = $("setup-country").value;
    const cur = $("setup-currency").value;
    if (/^[A-Z]{2,4}$/.test(cur)) state.currency = cur;
    await DB.setSetting("country", state.country);
    await DB.setSetting("currency", state.currency);
    const cp = $("currency-prefix");
    if (cp) cp.textContent = state.currency;
    renderSetupTypeChips();
    const ov3 = $("setup-overlay");
    ov3.dataset.step = "3";
    ov3.setAttribute("aria-labelledby", "setup-step3-title");
  });
  on("setup-types-next", async () => {
    if (!state.scopes.length) state.scopes = DEFAULT_SCOPES.slice();
    await DB.setSetting("scopes", state.scopes);
    await DB.setSetting("customScopes", state.customScopes);
    const ov4 = $("setup-overlay");
    ov4.dataset.step = "4";
    ov4.setAttribute("aria-labelledby", "setup-step4-title");
  });
  on("setup-budget-save", async () => {
    const v = parseFloat($("setup-budget").value);
    if (v > 0) { state.budget = v; await DB.setSetting("budget", v); }
    const ov5 = $("setup-overlay");
    ov5.dataset.step = "5";
    ov5.setAttribute("aria-labelledby", "setup-step5-title");
  });
  on("setup-budget-skip", () => {
    const ov5s = $("setup-overlay");
    ov5s.dataset.step = "5";
    ov5s.setAttribute("aria-labelledby", "setup-step5-title");
  });
  on("setup-finish", finishSetup);
  on("statement-close", () => {
    const ov = $("statement-overlay"), fr = $("statement-frame");
    if (fr) fr.srcdoc = "";
    if (ov) ov.hidden = true;
  });
  on("day-back", () => { $("day-overlay").hidden = true; });
  on("day-overlay", ev => { if (ev.target === $("day-overlay")) $("day-overlay").hidden = true; });
  on("export-filtered", () => { const ov = $("export-overlay"); if (ov) ov.hidden = false; });
  on("export-back", () => { $("export-overlay").hidden = true; });
  on("export-overlay", ev => { if (ev.target === $("export-overlay")) $("export-overlay").hidden = true; });
  on("exp-csv", async () => { if (await exportCSV(readExportFilter())) $("export-overlay").hidden = true; });
  on("exp-xls", async () => { if (await exportXLS(readExportFilter(), "recap-filtered")) $("export-overlay").hidden = true; });
  on("exp-claim-preset", async () => {
    if (!isPro()) { $("export-overlay").hidden = true; showUpgrade("Claim tracking and claim reports are Pro features."); return; }
    const f = readExportFilter();
    f.claim = "to-claim";
    const matches = filteredExpenses(f);
    if (!matches.length) { toast("No to-claim expenses in that range"); return; }
    await exportXLS(f, "recap-claim-report");
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
  /* (The legacy custom-relay/aiUrl override fields were removed from Advanced
     — cloudEndpoint() is hard-pinned, see its own comment. state.aiUrl/
     aiSecret are only kept around as dead state so a very old install's
     stored values don't error out on load; nothing reads them.) */
  on("cloud-toggle", async () => {
    state.cloudConsent = state.cloudConsent === "yes" ? "no" : "yes";
    await DB.setSetting("cloudConsent", state.cloudConsent);
    renderCloudSetting();
    toast(state.cloudConsent === "yes" ? "Cloud reading on" : "Cloud reading off — staying on-device");
  });
  on("share-toggle", async () => {
    state.shareRules = state.shareRules === "no" ? "yes" : "no";
    await DB.setSetting("shareRules", state.shareRules);
    renderCloudSetting();
    toast(state.shareRules === "no" ? "Sharing off — nothing leaves your phone" : "Thanks — sharing anonymous reading tips");
  });
  on("plan-btn", () => showUpgrade(""));
  on("plan-restore", restorePlayPurchases);
  on("upgrade-buy", async () => {
    /* Play build: Play Billing or nothing — Google's Payments policy forbids
       any in-app pointer to an outside checkout, so PAY_URL is web-only. */
    if (isNative()) {
      if (!billingReady()) return;
      /* The one CTA buys whichever card is selected — data-plan is set only
         when the offering holds a SINGLE plan and there is no chooser. Same
         purchasePro() as before: in-flight guard, silent user-cancel,
         pending payments, entitlement-led success. */
      const pick = () => $("upgrade-buy").dataset.plan || (_planChooser ? _planPick : "");
      let plan = pick();
      if (!plan && _offerPending) {
        /* The sheet opened moments ago and the offering is still in flight, so
           no plan is chosen yet. The pre-chooser sheet swallowed this window
           because its button always carried a plan and purchasePro() awaited
           the offering itself; the chooser must not answer a real buying
           intent with "not available". Wait for the paint, then buy what it
           picked. Claiming _billingBusy keeps a second tap out, and the
           handover to purchasePro() is synchronous after the await, so the
           slot is never open to another tap. */
        if (_billingBusy) return;
        _billingBusy = true; setUpgradeBusy(true);
        try { await _offerPending; }
        finally { _billingBusy = false; setUpgradeBusy(false); }
        plan = pick();
      }
      /* Backstop: with no offering the CTA is hidden, so this should be
         unreachable — but a paywall button that silently does nothing is the
         worst way to be wrong, so say something either way. */
      if (plan) purchasePro(plan);
      else toast("Pro plans aren't available right now — try again shortly");
      return;
    }
    if (PAY_URL) { window.open(PAY_URL, "_blank", "noopener"); return; }
    toast(PLAY_BILLING_LIVE ? "Recap Pro is sold in the Android app on Google Play" : "Online checkout is coming soon");
  });
  /* Tapping a card only selects it — it re-labels the CTA and the disclosure
     under it, and never starts a purchase by itself. */
  for (const k of ["monthly", "annual"]) on("upgrade-plan-" + k, () => selectPlan(k));
  on("upgrade-restore", restorePlayPurchases);
  on("upgrade-code", unlockPro);
  on("upgrade-close", () => { const ov = $("upgrade-overlay"); if (ov) ov.hidden = true; });
  on("upgrade-overlay", ev => { if (ev.target === $("upgrade-overlay")) $("upgrade-overlay").hidden = true; });
  $("app-version").textContent = "Recap " + APP_VERSION + " · ";
  /* Owner backdoor: 7 taps on the version line reveal the Claude-inbox setup. */
  let verTaps = 0, verTimer = null;
  $("app-version").addEventListener("click", () => {
    verTaps++;
    clearTimeout(verTimer);
    verTimer = setTimeout(() => { verTaps = 0; }, 2500);
    if (verTaps >= 7) {
      verTaps = 0;
      state._inboxReveal = true;
      renderInboxSetting();
      toast("Claude inbox settings revealed");
    }
  });
  $("erase-data").addEventListener("click", async () => {
    if (!confirm("Erase all expenses and settings? This cannot be undone.")) return;
    try {
      await DB.eraseAll();
    } catch (e) {
      /* IndexedDB rolls the transaction back on error (same guarantee
         importBackup's equivalent full-store rewrite relies on) — tell the
         user explicitly instead of leaving them on Settings with no
         feedback after confirming a destructive action. */
      toast("Erase failed — your data is unchanged");
      return;
    }
    /* Reload for a truly clean slate — resetting state field-by-field here
       kept drifting out of date as new state was added. */
    location.reload();
  });

  /* Service worker + auto-update: when a new version installs, the SW takes
     control and we reload once automatically — no more closing the app twice.
     Skipped in the native shell, which bundles its own assets offline. */
  if ("serviceWorker" in navigator && !isNative()) {
    const hadController = !!navigator.serviceWorker.controller;
    /* updateViaCache:"none" — the update check must never read version.js
       (imported by sw.js) from the HTTP cache, or a new release can hide
       behind Pages' ~10-minute max-age and feel like it "didn't deploy". */
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
      /* Also re-check whenever the app comes back to the foreground, not
         only at launch — an app left open picks updates up too. */
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (nw) nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) toast("Updating Recap…");
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
  /* A recurring expense whose due day arrives while the app is sitting open
     (not reloaded) would otherwise never materialize until next launch —
     re-check on foreground too, same idiom as syncInbox above. Idempotent
     (materializeRecurring only ever adds what's still due), so re-firing
     costs nothing. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") materializeRecurring();
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
