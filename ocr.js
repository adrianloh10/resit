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

/* Downscale + grayscale + contrast stretch for better OCR. */
function preprocessImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1800;
      let { width, height } = img;
      const scale = Math.min(1, MAX / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height);
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
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
    img.src = url;
  });
}

let ocrWorker = null;
async function getOcrWorker() {
  await loadTesseract();
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker("eng");
  }
  return ocrWorker;
}

async function ocrImage(file, onProgress) {
  const canvas = await preprocessImage(file);
  if (onProgress) onProgress("Reading text…");
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas);
  return data.text || "";
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

const TOTAL_KEYWORDS = [
  { re: /\b(grand\s*total|jumlah\s*(besar|keseluruhan)?|net\s*total|total\s*(amount|due|payable|sales)?|amount\s*(due|payable)|jum\.?)\b/i, score: 10 },
  { re: /\bsub\s*-?\s*total\b/i, score: 4 }
];
const EXCLUDE_TOTAL_RE = /\b(change|chg|baki|tunai|cash|credit|visa|master|debit|tendered|payment|bayaran|balance|point|rounding|item count|qty|gst|sst|tax|cukai|saving|diskaun|discount)\b/i;
const NOISE_LINE_RE = /\b(tax\s*invoice|invoice|resit|receipt|cashier|juruwang|terminal|trans|ref\s*no|reg\s*no|gst\s*(id|no)|sst|co\.?\s*no|sdn\.?\s*bhd|tel[:\s]|fax[:\s]|www\.|http|welcome|thank|terima kasih|sila|please|open daily|operating)\b/i;

const DATE_PATTERNS = [
  { re: /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/, order: "dmy" },
  { re: /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/, order: "ymd" },
  { re: /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})(?!\d)/, order: "dmy2" },
  { re: /(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[,.]?\s*(\d{4})/i, order: "dMonY" }
];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TIME_RE = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i;

function parseAmount(str) {
  return parseFloat(str.replace(/[,\s]/g, ""));
}

function extractDate(text) {
  for (const p of DATE_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    let d, mo, y;
    if (p.order === "dmy") { d = +m[1]; mo = +m[2] - 1; y = +m[3]; }
    else if (p.order === "ymd") { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    else if (p.order === "dmy2") { d = +m[1]; mo = +m[2] - 1; y = 2000 + (+m[3]); }
    else { d = +m[1]; mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; y = +m[3]; }
    if (mo > 11 && p.order !== "dMonY") { const t = d; d = mo + 1 - 1; mo = t - 1; }
    if (y >= 2000 && y <= 2100 && mo >= 0 && mo <= 11 && d >= 1 && d <= 31) {
      const date = new Date(y, mo, d);
      if (date <= new Date()) return date;
    }
  }
  return null;
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

function guessMerchant(lines) {
  for (const line of lines.slice(0, 6)) {
    const clean = line.replace(/[^a-zA-Z0-9&'’.\- ]/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length < 3) continue;
    const letters = (clean.match(/[a-zA-Z]/g) || []).length;
    if (letters < 3) continue;
    if (NOISE_LINE_RE.test(clean)) continue;
    if (/^\d/.test(clean) && letters < 5) continue;
    return clean.replace(/\b(sdn\.?\s*bhd\.?|berhad|enterprise|trading)\b/gi, "").replace(/\s+/g, " ").trim() || clean;
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

function extractTotal(lines) {
  let best = null, bestScore = -1;
  for (const line of lines) {
    const amounts = [...line.matchAll(AMOUNT_RE)].map(m => parseAmount(m[1]));
    if (!amounts.length) continue;
    const amt = Math.max(...amounts);
    if (!(amt > 0) || amt > 100000) continue;
    let score = 0;
    for (const k of TOTAL_KEYWORDS) if (k.re.test(line)) score = Math.max(score, k.score);
    if (EXCLUDE_TOTAL_RE.test(line) && score < 10) continue;
    if (score > bestScore || (score === bestScore && best !== null && amt > best)) {
      best = amt; bestScore = score;
    }
  }
  return best;
}

function extractItems(lines, total) {
  const items = [];
  for (const line of lines) {
    if (TOTAL_KEYWORDS.some(k => k.re.test(line))) continue;
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
  const total = extractTotal(lines);
  const date = extractDate(joined);
  const time = extractTime(joined);
  const merchant = guessMerchant(lines);
  const category = guessCategory(joined, merchant);
  const items = extractItems(lines, total);
  return { total, date, time, merchant, category, items, rawText: text };
}

window.ReceiptOCR = { ocrImage, parseReceiptText, guessCategory, CATEGORIES };
