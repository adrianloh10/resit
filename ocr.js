/* On-device receipt reading: Tesseract.js OCR + Malaysian-receipt parsing heuristics. */

const TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_CDN;
      s.onload = () => resolve();
      s.onerror = () => { tesseractLoading = null; reject(new Error("Could not load OCR engine. Check your connection (only needed the first time).")); };
      document.head.appendChild(s);
    });
  }
  return tesseractLoading;
}

/* Load image onto a canvas, upscaling small photos (helps Tesseract) and
   capping huge ones. */
function loadCanvas(file, boost) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      /* Normal pass: proven scaling. Boost pass (only when no amount was
         found): heavy magnification so low-res photos and handwriting
         resolve — hurts clean scans, which is why it's not the default. */
      const maxDim = Math.max(width, height), minDim = Math.min(width, height);
      let scale;
      if (boost) {
        scale = Math.min(4, Math.max(2, 1400 / minDim));
        if (maxDim * scale > 3200) scale = 3200 / maxDim;
      } else {
        scale = Math.min(2, 2200 / maxDim);
      }
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.srcMinDim = minDim;
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
    img.src = url;
  });
}

function grayscale(px) {
  const gray = new Float64Array(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  }
  return gray;
}

/* Local adaptive threshold (integral-image mean): handles faded dot-matrix
   print, shadows and crumpled paper far better than global contrast. */
function adaptiveThreshold(canvas) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const gray = grayscale(px);
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const half = (Math.max(15, Math.round(w / 12)) | 1) >> 1;
  const C = 12;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), y1 = Math.max(0, y - half);
      const x2 = Math.min(w - 1, x + half), y2 = Math.min(h - 1, y + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integ[(y2 + 1) * (w + 1) + (x2 + 1)] - integ[y1 * (w + 1) + (x2 + 1)]
                - integ[(y2 + 1) * (w + 1) + x1] + integ[y1 * (w + 1) + x1];
      const v = gray[y * w + x] < (sum / count) - C ? 0 : 255;
      const i = (y * w + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/* Fallback: global grayscale + contrast stretch (the old approach) for the
   rare image where binarization eats the text. */
function contrastStretch(canvas) {
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  let min = 255, max = 0;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((px[i] - min) / range) * 255));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

let ocrWorker = null;
async function getOcrWorker() {
  await loadTesseract();
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker("eng");
  }
  return ocrWorker;
}

/* A usable read has real length AND money amounts in it. Binarization can
   shred small digits on noisy phone photos even when big text survives —
   if that happens, retry with the gentler contrast pass. */
function textUsable(t) {
  return t.trim().length >= 40 && /\d+\.\d{2}/.test(t);
}

async function recognizeWithBoxes(worker, canvas) {
  const res = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const lines = [];
  for (const b of (res.data.blocks || [])) {
    for (const par of (b.paragraphs || [])) {
      for (const ln of (par.lines || [])) {
        const words = ln.words || [];
        lines.push({ text: ln.text || words.map(w => w.text).join(" "), words, bbox: ln.bbox });
      }
    }
  }
  return { text: res.data.text || "", lines };
}

async function ocrImage(file, onProgress) {
  if (onProgress) onProgress("Reading text…");
  const worker = await getOcrWorker();
  const r = await ocrBest(worker, file, onProgress);
  return r.text;
}

async function ocrBest(worker, file, onProgress) {
  const sharpCanvas = adaptiveThreshold(await loadCanvas(file));
  let r = await recognizeWithBoxes(worker, sharpCanvas);
  let canvas = sharpCanvas;
  if (!textUsable(r.text)) {
    if (onProgress) onProgress("Trying harder…");
    const softCanvas = contrastStretch(await loadCanvas(file));
    const r2 = await recognizeWithBoxes(worker, softCanvas);
    if (textUsable(r2.text) || r2.text.trim().length > r.text.trim().length) {
      r = r2; canvas = softCanvas;
    }
  }
  return { ...r, canvas };
}

/* When no amount was found in the full read, zoom into the region to the
   right of the "TOTAL" label and re-read it in digits-only mode. Enlarged,
   isolated digits read far better — including most handwriting. */
async function sniperTotal(worker, canvas, lines) {
  const totalLines = lines.filter(l => /total|jumlah/i.test(l.text || "") && l.bbox);
  if (!totalLines.length) return null;
  const strong = totalLines.filter(l => /amount|amt|rm|payable|inclu/i.test(l.text));
  const target = strong.length ? strong[strong.length - 1] : totalLines[totalLines.length - 1];
  let cropX = target.bbox.x0;
  for (const w of target.words) {
    if (w.bbox && /total|amount|amt|jumlah|rm|payable|[:]/i.test(w.text || "")) {
      cropX = Math.max(cropX, w.bbox.x1);
    }
  }
  const lh = Math.max(8, target.bbox.y1 - target.bbox.y0);
  const y0 = Math.max(0, target.bbox.y0 - lh * 0.8);
  const y1 = Math.min(canvas.height, target.bbox.y1 + lh * 0.8);
  const x0 = Math.min(cropX + 4, canvas.width - 20);
  const w = canvas.width - x0 - 2;
  const h = y1 - y0;
  if (w < 20 || h < 8) return null;
  const scale = Math.max(1, Math.min(4, 120 / h));
  const crop = document.createElement("canvas");
  crop.width = Math.round(w * scale);
  crop.height = Math.round(h * scale);
  crop.getContext("2d").drawImage(canvas, x0, y0, w, h, 0, 0, crop.width, crop.height);
  await worker.setParameters({ tessedit_char_whitelist: "0123456789.,|/- ", tessedit_pageseg_mode: "7" });
  let text = "";
  try {
    text = (await worker.recognize(crop)).data.text || "";
  } finally {
    await worker.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
  }
  /* Conservative read: a wrong amount is worse than an empty field. */
  const groups = text.match(/\d+/g);
  if (!groups) return null;
  let amt = null;
  if (groups.length >= 2 && groups[groups.length - 1].length === 2) {
    const rm = groups.slice(0, -1).join("");
    if (rm.length >= 1 && rm.length <= 5) amt = parseFloat(rm + "." + groups[groups.length - 1]);
  } else if (groups.length === 1) {
    const g = groups[0];
    if (g.length >= 3 && g.length <= 6 && g.endsWith("00")) amt = parseInt(g.slice(0, -2), 10);
    else if (g.length <= 2) amt = parseInt(g, 10);
  }
  return amt !== null && amt > 0 && amt < 100000 ? amt : null;
}

/* Full scan pipeline: OCR (with retry), parse, then the digit-zoom rescue
   pass if the total is still missing. */
async function scanReceipt(file, onProgress) {
  if (onProgress) onProgress("Reading text…");
  const worker = await getOcrWorker();
  let r = await ocrBest(worker, file, onProgress);
  let parsed = parseReceiptText(r.text);
  /* Retry magnified when the total is missing, weakly evidenced, or the
     photo is low-res (where the normal pass misreads small digits). */
  const small = r.canvas.srcMinDim && r.canvas.srcMinDim < 700;
  if (parsed.total === null || parsed.totalConf <= 1 || (small && parsed.totalConf < 3)) {
    if (onProgress) onProgress("Looking closer…");
    try {
      const big = adaptiveThreshold(await loadCanvas(file, true));
      const r2 = await recognizeWithBoxes(worker, big);
      const p2 = parseReceiptText(r2.text);
      if (p2.total !== null && (parsed.total === null || p2.totalConf > parsed.totalConf || (small && p2.totalConf >= parsed.totalConf))) {
        r = { ...r2, canvas: big };
        parsed = p2;
      }
    } catch (e) { /* magnified retry is best-effort */ }
  }
  if (parsed.total === null && r.lines.length) {
    if (onProgress) onProgress("Zooming into the total…");
    try {
      const t = await sniperTotal(worker, r.canvas, r.lines);
      if (t) parsed.total = t;
    } catch (e) { /* rescue pass is best-effort */ }
  }
  return parsed;
}

/* ---------- Parsing ---------- */

const CATEGORIES = [
  { name: "Food", color: "#B05B36" },
  { name: "Groceries", color: "#75825F" },
  { name: "Fuel", color: "#C2A14D" },
  { name: "Transport", color: "#A89368" },
  { name: "Shopping", color: "#9A6B4F" },
  { name: "Bills", color: "#7D7466" },
  { name: "Health", color: "#5C6B52" },
  { name: "Entertainment", color: "#8C4A32" },
  { name: "Other", color: "#B6AE9E" }
];

const CATEGORY_KEYWORDS = {
  Groceries: ["tesco", "lotus", "aeon", "giant", "mydin", "99 speedmart", "speedmart", "econsave", "village grocer", "jaya grocer", "nsk", "supermarket", "pasar", "mini market", "minimart", "mini mart", "grocer", "hero market", "tf value", "kk mart", "kk super", "7-eleven", "7 eleven", "seven eleven", "family mart", "familymart", "emart", "billion", "segi fresh", "bens independent", "ben's independent", "cold storage", "mercato", "groceria", "maslee", "pasaraya", "st rosyam", "everrise", "servay", "farley", "hypermarket", "kedai runcit", "convenience"],
  Food: ["restoran", "restaurant", "cafe", "kafe", "kopitiam", "nasi", "mamak", "mcdonald", "kfc", "pizza", "subway", "starbucks", "tealive", "zus", "secret recipe", "sushi", "bakery", "bakeri", "bistro", "food court", "foodcourt", "burger", "satay", "chicken rice", "dim sum", "mixue", "domino", "marrybrown", "oldtown", "grabfood", "foodpanda", "shopeefood", "bbq", "steamboat", "western", "warung", "gerai", "char kuey", "char koay", "kuey teow", "koay teow", "chee cheong", "kedai makan", "medan selera", "hawker", "ayam", "ikan bakar", "tomyam", "tom yam", "cendol", "laksa", "kopi", "teh tarik", "chatime", "gigi coffee", "coffee bean", "san francisco coffee", "kenangan", "luckin", "richiamo", "llaollao", "baskin", "inside scoop", "sushi king", "kenny rogers", "texas chicken", "nando", "a&w", "wendy", "shihlin", "4fingers", "dragon-i", "din tai fung", "pelita", "bak kut teh", "haidilao", "hotpot", "seafood", "ramen", "donut", "dunkin", "krispy", "big apple", "boost juice", "coolblog", "banana leaf", "claypot", "economy rice", "chap fan", "wantan", "catering", "stall"],
  Fuel: ["petronas", "shell", "petron", "caltex", "bhp", "esso", "petrol", "fuel", "setel", "stesen minyak", "five petroleum"],
  Transport: ["grab", "touch n go", "touch 'n go", "tng", "rapidkl", "rapid bus", "rapid rail", "prasarana", "ktm", "mrt", "lrt", "klia ekspres", "klia transit", "toll", "tol", "plus highway", "duke", "kesas", "lekas", "besraya", "litrak", "parking", "parkir", "car park", "carpark", "valet", "airasia", "batik air", "firefly", "malindo", "malaysia airlines", "taxi", "teksi", "ferry", "bas ekspres", "smarttag", "smart tag", "socar", "trevo", "jpj", "roadtax", "road tax", "puspakom"],
  Health: ["farmasi", "pharmacy", "guardian", "watsons", "caring", "klinik", "poliklinik", "clinic", "hospital", "alpro", "big pharmacy", "dental", "dentist", "pergigian", "pathlab", "bp healthcare", "lablink", "kpj", "sunway medical", "columbia asia", "gleneagles", "pantai hospital", "prince court", "vitamin", "supplement", "vitahealth", "physio", "tcm", "chinese medicine", "gym", "fitness", "anytime fitness", "celebrity fitness", "chi fitness", "optical", "optometry", "eyecare"],
  Bills: ["tnb", "tenaga", "syabas", "air selangor", "unifi", "maxis", "celcom", "digi", "umobile", "u mobile", "astro", "indah water", "telekom", "yes 4g", "redone", "insurans", "insurance", "takaful", "time internet", "time dotcom", "hotlink", "tune talk", "prepaid", "postpaid", "streamyx", "pos malaysia", "mbpj", "dbkl", "mbsa", "mpsj", "majlis perbandaran"],
  Shopping: ["mr diy", "mr. diy", "ikea", "uniqlo", "padini", "h&m", "h & m", "decathlon", "lazada", "shopee", "harvey norman", "courts", "senheng", "machines", "switch", "popular", "kaison", "eco shop", "noko", "daiso", "parkson", "metrojaya", "sports direct", "al-ikhsan", "brands outlet", "miniso", "typo", "cotton on", "zara", "lovisa", "sephora", "mph", "borders", "times bookstore", "bookstore", "stationery", "toys r us", "mr toy", "ace hardware", "homepro", "hardware", "ssf", "jakel", "kamdar", "furniture", "electrical", "elektronik", "poh kong", "habib", "tomei", "wah chan", "goldsmith", "perfume", "thrift", "bundle"],
  Entertainment: ["gsc", "tgv", "mbo", "lfs", "dadi cinema", "cinema", "karaoke", "ktv", "netflix", "spotify", "steam", "playstation", "genting", "zoo", "aquaria", "theme park", "sunway lagoon", "escape room", "arcade", "bowling", "bowl", "snooker", "concert", "disney", "hbo", "youtube premium", "viu", "iqiyi"]
};

const AMOUNT_RE = /(\d{1,3}(?:[,\s]\d{3})*\.\d{2})(?!\d)/g;
/* OCR often reads a decimal point as a comma or adds stray spaces
   ("100,20", "43 . 50"). Only trusted on lines that already talk about
   totals/cash/change. */
const LOOSE_AMOUNT_RE = /(\d{1,4})\s*[.,]\s*(\d{2})(?!\d)/;
/* Mamak and stall receipts often print whole ringgit: "TOTAL RM 43". */
const RM_INT_RE = /\brm\b\s*:?\s*(\d{1,5})(?!\s*[.,]?\d)/i;
/* Invoice books write ringgit and sen in separate columns: "2269 | 00"
   OCRs as "2269 00" (sometimes with a stray | or l between). */
const COLUMN_AMOUNT_RE = /\b(\d{1,5})\s*[|/lI!]?\s+(\d{2})\b(?!\s*[.,]?\d)/;

const EXCLUDE_TOTAL_RE = /\b(change|chg|baki|tunai|cash|credit|visa|master|debit|tendered|payment|bayaran|balance|point|rounding|item count|qty|gst|sst|tax|cukai|saving|diskaun|discount)\b/i;
const NOISE_LINE_RE = /\b(tax\s*invoice|invoice|resit|receipt|cashier|juruwang|terminal|trans|ref\s*no|reg\s*no|gst\s*(id|no)|co\.?\s*no|tel[:\s]|fax[:\s]|www\.|http|welcome|thank|terima kasih|sila|please|open daily|operating|licensee|franchis)\b/i;

/* Lines that identify the business — including OCR manglings of "SDN BHD". */
const COMPANY_HINT_RE = /(s[do0]n\.?\s*[b8]h[do0]|berhad|\bbhd\b|\bs\/b\b|enterprise|trading|holdings?|syarikat|perniagaan|stationery|restoran|restaurant|cafe|kafe|bakery|kitchenette|\bmart\b|store|shop|pharmacy|farmasi|hardware|craft|tailor|book|retail|company|corporation|\bgroup\b|\bgift\b|\bdeco\b|boutique|florist|bistro)/i;
const ADDRESS_RE = /\b(no[.\s]*\d|lot\s+\d|jalan|jln|taman|tmn|lorong|lrg|persiaran|lebuh|kampung|bandar|seksyen|kawasan|floor|flr\b|wisma|plaza\s+\d|\d{5})\b/i;

const DATE_PATTERNS = [
  { re: /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})/, order: "dmy" },
  { re: /(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/, order: "ymd" },
  { re: /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2})(?!\d)/, order: "dmy2" },
  { re: /(\d{1,2})[\s\-.,]*(jan|feb|ma[rx]|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-.,]*(\d{4})/i, order: "dMonY" },
  { re: /(\d{1,2})[\s\-.,]*(jan|feb|ma[rx]|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-.,]*(\d{2})(?!\d)/i, order: "dMonY2" }
];
const MONTHS = { jan: 0, feb: 1, mar: 2, max: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TIME_RE = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i;

function parseAmount(str) {
  return parseFloat(str.replace(/[,\s]/g, ""));
}

function validDate(d, mo, y) {
  /* OCR fixes: "2618" is 2018 with 0 read as 6; month "61" is "01" with a
     phantom tens digit. */
  if (y > 2100 && y < 3000) y = 2000 + (y % 100);
  if (mo > 11 && (mo % 10) >= 0 && (mo % 10) <= 11 && mo >= 12) {
    if ((mo + 1) % 10 >= 1) mo = ((mo + 1) % 10) - 1;
  }
  if (y >= 2015 && y <= 2100 && mo >= 0 && mo <= 11 && d >= 1 && d <= 31) {
    const date = new Date(y, mo, d);
    if (date <= new Date()) return date;
  }
  return null;
}

function dateFromString(text) {
  for (const p of DATE_PATTERNS) {
    const re = new RegExp(p.re.source, "gi");
    for (const m of text.matchAll(re)) {
      let d, mo, y;
      if (p.order === "dmy") { d = +m[1]; mo = +m[2] - 1; y = +m[3]; }
      else if (p.order === "ymd") { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
      else if (p.order === "dmy2") { d = +m[1]; mo = +m[2] - 1; y = 2000 + (+m[3]); }
      else if (p.order === "dMonY2") { d = +m[1]; mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; y = 2000 + (+m[3]); }
      else { d = +m[1]; mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; y = +m[3]; }
      if (mo > 11 && p.order.startsWith("dmy") === false && p.order !== "ymd") { /* month names always valid */ }
      else if (mo > 11 && d >= 1 && d <= 12 && mo + 1 <= 31) { const t = d; d = mo + 1; mo = t - 1; }
      const date = validDate(d, mo, y);
      if (date) return date;
    }
  }
  return null;
}

/* "Date: 120022018" / "Date: 1603/2018" — separators eaten by OCR.
   Reassemble: day = first 2 digits, year = last 4, month = what's left. */
function dateFromDigitRun(segment) {
  const digits = (segment.match(/\d[\d\s\/\-.:]*/) || [""])[0].replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 10) return null;
  const d = +digits.slice(0, 2);
  const y = +digits.slice(-4);
  const mid = +digits.slice(2, -4);
  return validDate(d, mid - 1, y);
}

/* Prefer a date sitting on a "Date:"-style line — random digit runs in
   item rows otherwise masquerade as dates. */
function extractDate(lines, joined) {
  for (const line of lines) {
    const km = line.match(/\b([dp]ate|tarikh)\b/i);
    if (km) {
      const seg = line.slice(km.index);
      const d = dateFromString(seg) || dateFromDigitRun(seg);
      if (d) return d;
    }
  }
  return dateFromString(joined);
}

function extractTime(text) {
  const m = text.match(TIME_RE);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const ampm = m[3] ? m[3].toLowerCase() : null;
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, min };
}

function cleanMerchantLine(line) {
  let clean = line.replace(/\(\s*[A-Z0-9]{4,}\s*-\s*[A-Z0-9]\s*\)/gi, " ")
    .replace(/[^a-zA-Z0-9&'’.\- ]/g, " ")
    .replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  while (words.length > 1 && words[0].length <= 2 && /[a-z]/.test(words[0])) words.shift();
  /* OCR debris after the name ("... TRADING . see") — drop short trailing
     lowercase tokens. */
  while (words.length > 2 && /^[a-z]{1,4}\.?$/.test(words[words.length - 1])) words.pop();
  clean = words.join(" ");
  const display = clean.replace(/\b(s[do0]n\.?\s*[b8]h[do0]\.?|berhad|bhd\.?)\b/gi, "")
    .replace(/\s+/g, " ").replace(/[\s.\-&']+$/, "").trim();
  /* "AEON CO. (M) BHD" should read as just "AEON" — drop trailing
     corporate fluff tokens. */
  const toks = display.split(" ");
  while (toks.length > 1 && /^(co\.?|m\.?|my|malaysia|corp\.?|holdings?)$/i.test(toks[toks.length - 1])) toks.pop();
  const slim = toks.join(" ").replace(/[\s.\-&']+$/, "").trim();
  return slim || display || clean;
}

function lineQuality(line) {
  const letters = (line.match(/[a-zA-Z]/g) || []).length;
  const longestWord = Math.max(0, ...line.split(/\s+/).map(w => (w.match(/[a-zA-Z]/g) || []).length));
  return letters >= 6 && longestWord >= 4;
}

function guessMerchant(lines) {
  const head = lines.slice(0, 10);
  for (let i = 0; i < head.length; i++) {
    const line = head[i];
    if (NOISE_LINE_RE.test(line)) continue;
    if (COMPANY_HINT_RE.test(line) && (line.match(/[a-zA-Z]/g) || []).length >= 5) {
      let name = cleanMerchantLine(line);
      /* "ELECTRICAL TRADING" / "BISTRO & CAFE" with the brand on the line
         above — pull up to two brand words down when the company line
         starts with a generic trade word. */
      if (i > 0 && /^(electrical|electronic|hardware|trading|enterprise|marketing|furniture|motor|machinery|engineering|construction|stationery|services|bistro|cafe|kafe|restaurant|restoran|bakery|pharmacy|farmasi)\b/i.test(name)) {
        const prev = head[i - 1];
        if (!NOISE_LINE_RE.test(prev) && !ADDRESS_RE.test(prev)) {
          const toks = prev.trim().split(/\s+/)
            .map(t => t.replace(/[^A-Za-z]/g, ""))
            .filter(t => /^[A-Z]{3,12}$/.test(t))
            .slice(0, 2);
          if (toks.length) name = toks.join(" ") + " " + name;
        }
      }
      return name;
    }
  }
  for (const line of head) {
    if (NOISE_LINE_RE.test(line)) continue;
    if (!lineQuality(line)) continue;
    if (ADDRESS_RE.test(line)) continue;
    if (/\d{4,}/.test(line)) continue;
    if (totalLineScore(line) > 0 || /\d+\.\d{2}/.test(line)) continue;
    return cleanMerchantLine(line);
  }
  return "";
}

function kwHits(lower, words) {
  let hits = 0, first = Infinity;
  for (const w of words) {
    let idx = -1;
    if (w.length <= 3) {
      const re = new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      const m = re.exec(lower);
      if (m) idx = m.index;
    } else {
      idx = lower.indexOf(w);
    }
    if (idx >= 0) { hits++; if (idx < first) first = idx; }
  }
  return { hits, first };
}

/* Merchant-name matches count 3x: the shop name is a far stronger signal
   than a keyword buried in the item lines. Ties go to the keyword that
   appears earliest in the merchant name ("GSC Aeon Mall" -> the brand GSC,
   not the mall it sits in). */
function guessCategory(text, merchant) {
  const lowerAll = (text || "").toLowerCase();
  const lowerMerchant = (merchant || "").toLowerCase();
  let best = "Other", bestScore = 0, bestFirst = Infinity;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    const m = kwHits(lowerMerchant, words);
    const t = kwHits(lowerAll, words);
    const score = m.hits * 3 + t.hits;
    const first = m.first !== Infinity ? m.first : 10000 + (t.first === Infinity ? 10000 : t.first);
    if (score > bestScore || (score === bestScore && score > 0 && first < bestFirst)) {
      bestScore = score; bestFirst = first; best = cat;
    }
  }
  return best;
}

function totalLineScore(line) {
  if (/\bsub\s*-?\s*total\b/i.test(line)) return 4;
  /* "GST @6% included in total" and "Total GST 0.42" are tax breakdowns. */
  if (/\b(gst|sst)\b.*inclu/i.test(line) && !/^\s*total/i.test(line)) return 0;
  if (/\btotal\s*(gst|sst|tax|cukai)\b/i.test(line)) return 0;
  if (/\btotal\s*qty\b|\bqty\b[^a-z]*\btotal\b/i.test(line)) return 0;
  if (/\b(total|jumlah|jum\.?)\b/i.test(line) || /\bamount\s*(due|payable)\b/i.test(line)) {
    if (/exclu/i.test(line)) return 3;
    if (/payable|due|\bincl/i.test(line) || /round|grand|net|bersih|keseluruhan|total\s*amount/i.test(line)) return 12;
    return 10;
  }
  return 0;
}

function lineAmounts(line, allowLoose) {
  const amounts = [...line.matchAll(AMOUNT_RE)].map(m => parseAmount(m[1]));
  if (!amounts.length && allowLoose) {
    const m = line.match(LOOSE_AMOUNT_RE) || line.match(COLUMN_AMOUNT_RE);
    if (m) amounts.push(parseFloat(m[1] + "." + m[2]));
  }
  return amounts.filter(a => a > 0 && a < 100000);
}

function totalLineAmounts(line, score) {
  let amounts = lineAmounts(line, score >= 10);
  if (!amounts.length && score >= 10) {
    const m = line.match(RM_INT_RE);
    if (m && +m[1] > 0) amounts.push(+m[1]);
  }
  /* Column invoices ("TOTAL AMOUNT RM | 2269 | 00") often OCR with fake
     dots in the ringgit part: "22.69 00". A lone trailing 2-digit sen
     group means the real amount is all the digits joined. */
  if (score >= 10 && /\brm\b|amount/i.test(line)) {
    const m = line.match(/(\d[\d.,]*)\s+(\d{2})\s*\|?\s*$/);
    if (m) {
      const digits = m[1].replace(/\D/g, "") + m[2];
      if (digits.length >= 3 && digits.length <= 7) {
        amounts = [parseFloat(digits.slice(0, -2) + "." + digits.slice(-2))];
      }
    }
  }
  /* "Grand Total: 9280" — decimal point eaten by OCR: sen-jammed integer.
     A letter glued to the digits ("C310") means garbage — don't trust it. */
  if (!amounts.length && score >= 10) {
    const m = line.match(/(?<![A-Za-z])(\d{3,6})\D*$/);
    if (m) amounts.push(parseInt(m[1], 10) / 100);
  }
  return amounts.filter(a => a > 0 && a < 100000);
}

/* Collect every money fact the receipt offers, then arbitrate between the
   printed total, subtotal+tax+service arithmetic, and cash-change. */
function extractTotal(lines, ccInfo) {
  const c = { boosted: null, boostedIsRound: false, plain: null, sub: null, tax: null, svc: null, rounding: 0, fallbackMax: null };
  for (const line of lines) {
    const score = totalLineScore(line);
    if (/round/i.test(line) && score < 10) {
      const m = line.match(/(-)?\s*(\d{1,2}\.\d{2})(?!\d)/);
      if (m && parseFloat(m[2]) <= 0.09) c.rounding = (m[1] ? -1 : 1) * parseFloat(m[2]);
      continue;
    }
    if (score === 0 && /\b(gst|sst|tax|cukai)\b/i.test(line) && !/summary/i.test(line)) {
      const a = lineAmounts(line, false);
      if (a.length && (c.tax === null || a[a.length - 1] > c.tax)) c.tax = a[a.length - 1];
      continue;
    }
    if (/\b(service|svc)\b/i.test(line) && /charge|chg|caj|%/i.test(line) && score < 10) {
      if (c.svc === null) {
        const a = lineAmounts(line, false);
        if (a.length) c.svc = a[a.length - 1];
      }
      continue;
    }
    if (EXCLUDE_TOTAL_RE.test(line) && score < 10) continue;
    const amounts = totalLineAmounts(line, score);
    if (!amounts.length) continue;
    const amt = Math.max(...amounts);
    if (score === 4) { if (c.sub === null || amt > c.sub) c.sub = amt; }
    else if (score === 12) { if (c.boosted === null || amt > c.boosted) { c.boosted = amt; c.boostedIsRound = /round/i.test(line); } }
    else if (score >= 10) { if (c.plain === null || amt > c.plain) c.plain = amt; }
    else if (score === 0 && (c.fallbackMax === null || amt > c.fallbackMax)) c.fallbackMax = amt;
  }

  const close = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
  const r2 = x => Math.round(x * 100) / 100;
  let kt = c.boosted !== null ? c.boosted : c.plain;
  if (c.boostedIsRound && c.plain !== null && Math.abs(c.boosted - c.plain) > 0.05) kt = c.plain;
  const st = (c.sub !== null && (c.tax !== null || c.svc !== null))
    ? r2(c.sub + (c.tax || 0) + (c.svc || 0) + c.rounding) : null;
  const cc = ccInfo ? ccInfo.cc : null;
  const ccWeak = ccInfo ? ccInfo.weak : false;
  /* boosted + rounding === plain means the receipt's own arithmetic confirms
     the printed totals — they outrank a possibly-misread cash/change pair. */
  const roundConfirmed = c.boosted !== null && c.plain !== null && !c.boostedIsRound
    && Math.abs(r2(c.boosted + c.rounding) - c.plain) <= 0.015;

  /* conf: 3 = arithmetic-confirmed by two independent sources,
     2 = strong single source, 1 = lone printed line, 0 = guesswork. */
  if (close(cc, kt, 0.06)) return { value: kt, conf: 3 };
  if (roundConfirmed) return { value: c.plain, conf: 3 };
  if (close(st, kt, 0.02) && kt !== null) return { value: kt, conf: 3 };
  /* The "total" line the parser found is just the subtotal echoed (GST
     summary rows do this) — the real total is subtotal + tax. */
  if (st !== null && kt !== null && c.sub !== null && Math.abs(kt - c.sub) < 0.01) return { value: st, conf: 2 };
  /* Two independent printed total lines agreeing beat a cash/change pair
     that might itself be misread. */
  if (c.boosted !== null && c.plain !== null && Math.abs(c.boosted - c.plain) <= 0.015) return { value: kt, conf: 2 };
  if (close(st, cc, 0.06)) return { value: cc, conf: 2 };
  if (cc !== null && !ccWeak) return { value: cc, conf: 2 };
  if (st !== null && kt === null) return { value: st, conf: 2 };
  if (ccWeak && cc !== null && kt !== null && c.tax !== null && close(cc, r2(kt + c.tax), 0.06)) return { value: cc, conf: 2 };
  if (kt !== null) return { value: kt, conf: 1 };
  if (cc !== null) return { value: cc, conf: 1 };
  if (st !== null) return { value: st, conf: 1 };
  if (c.sub !== null) return { value: c.sub, conf: 0 };
  return { value: c.fallbackMax, conf: 0 };
}

/* Malaysian receipts print Cash and Change: cash - change IS the amount paid.
   Two independent numbers beat one possibly-misread total line. */
function cashChangeTotal(lines) {
  let cash = null, change = null;
  for (const line of lines) {
    if (cash === null && /\b(cash|tunai|paid|payment|tender\w*)\b/i.test(line) && !/refund/i.test(line)) {
      const a = lineAmounts(line, true);
      if (a.length) cash = Math.max(...a);
    } else if (change === null && /\b(change|chg|baki|kembali)\b/i.test(line)) {
      const a = [...line.matchAll(AMOUNT_RE)].map(m => parseAmount(m[1]));
      if (!a.length) {
        const m = line.match(LOOSE_AMOUNT_RE) || line.match(COLUMN_AMOUNT_RE);
        if (m) a.push(parseFloat(m[1] + "." + m[2]));
      }
      if (!a.length) {
        const m = line.match(/(?<![A-Za-z])(\d{3,6})\D*$/);
        if (m) a.push(parseInt(m[1], 10) / 100);
      }
      const valid = a.filter(x => x >= 0 && x < 100000);
      if (valid.length) change = valid[valid.length - 1];
    }
  }
  if (cash === null || change === null) return null;
  const cc = Math.round((cash - change) * 100) / 100;
  if (!(cc > 0 && change < cash)) return null;
  /* change of 0.00 adds no arithmetic cross-check — cash alone is one
     possibly-misread number, so mark it weak. */
  return { cc, weak: change === 0 };
}

function extractItems(lines, total) {
  const items = [];
  for (const line of lines) {
    if (totalLineScore(line) > 0) continue;
    if (EXCLUDE_TOTAL_RE.test(line)) continue;
    const matches = [...line.matchAll(AMOUNT_RE)];
    if (!matches.length) continue;
    const price = parseAmount(matches[matches.length - 1][1]);
    if (!(price > 0)) continue;
    if (total && price > total) continue;
    let name = line.slice(0, matches[matches.length - 1].index)
      .replace(/[^a-zA-Z0-9&'’.\-% ]/g, " ")
      .replace(/\b\d{6,}\b/g, "")
      .replace(/\s+/g, " ").trim();
    if (name.length < 2 || !(name.match(/[a-zA-Z]/g) || []).length) continue;
    if (name.length > 40) name = name.slice(0, 40);
    items.push({ name, price });
    if (items.length >= 25) break;
  }
  return items;
}

function parseReceiptText(text) {
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 1);
  const joined = lines.join("\n");
  const tt = extractTotal(lines, cashChangeTotal(lines));
  let total = tt.value;
  let totalConf = total !== null ? tt.conf : 0;
  const date = extractDate(lines, joined);
  const time = extractTime(joined);
  const merchant = guessMerchant(lines);
  const category = guessCategory(joined, merchant);
  const items = extractItems(lines, total);
  /* Last resort: a receipt with readable item prices but no readable
     total — the items sum is better than an empty field. */
  if (total === null && items.length >= 1 && items.length <= 15) {
    const sum = Math.round(items.reduce((s, i) => s + i.price, 0) * 100) / 100;
    if (sum > 0 && sum < 100000) { total = sum; totalConf = 0; }
  }
  return { total, totalConf, date, time, merchant, category, items, rawText: text };
}

window.ReceiptOCR = { ocrImage, scanReceipt, parseReceiptText, guessCategory, CATEGORIES };
