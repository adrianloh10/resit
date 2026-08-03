/* On-device receipt reading: Tesseract.js OCR + Malaysian-receipt parsing heuristics. */

/* Self-hosted tesseract.js 5.1.1 — vendored under ./vendor/, NO CDN (was a
   jsDelivr load, which contradicted the self-host-assets policy). tesseract.js
   resolves workerPath/corePath/langPath to absolute URLs against
   window.location.href before handing them to its worker, so the same
   relative "vendor/..." works from the GitHub Pages /resit/ path and the local
   dev-server root alike. The core glue (embedded-wasm) + eng.traineddata are
   large (~28MB together); they are runtime-cached by the service worker on the
   first scan (invariant #1: lazy-fetched once, cached, never per-scan) rather
   than force-precached at install — keeping install light and all-or-nothing
   addAll from ever bricking on a big binary over a flaky connection.

   Paths must be ABSOLUTE: tesseract.js spins its worker up as a blob (base
   URL blob:…), and the worker importScripts()/fetches corePath+langPath from
   its own context, so a relative "vendor/…" resolves against the wrong base
   and 404s. Resolve against document.baseURI once — correct from both the
   GitHub Pages /resit/ path and the dev-server root. No trailing slash: the
   worker joins these with "/tesseract-core-…"/"/eng.traineddata.gz". */
const TESSERACT_LIB = "vendor/tesseract.min.js";
const VENDOR_BASE = new URL("vendor", document.baseURI).href;
const TESSERACT_PATHS = { workerPath: VENDOR_BASE + "/worker.min.js", corePath: VENDOR_BASE, langPath: VENDOR_BASE };

/* Android's build tooling auto-decompresses any bundled asset ending in
   .gz and strips the extension when packaging the APK (OCR-ENGINE-PLAN.md
   Phase 3b device-bench finding) — vendor/eng.traineddata.gz (10.9MB)
   becomes assets/public/vendor/eng.traineddata (23.4MB, already
   decompressed) inside the native shell, so tesseract.js's default
   gzip:true fetch for "eng.traineddata.gz" 404s there. The web path is
   untouched (GitHub Pages / any plain static server serves the committed
   .gz file as-is), so the flag must be keyed on ocrIsNative(), not global. */
function tesseractWorkerPaths() {
  return Object.assign({}, TESSERACT_PATHS, { gzip: !ocrIsNative() });
}

let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_LIB;
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

/* ---------- Preprocessing v2 (prepV2, OCR-ENGINE-PLAN.md Phase 1) ----------

   A pure canvas/typed-array pipeline run before OCR, in this order:
     a. grayscale + shadow/background flattening (divide out illumination)
     b. deskew (projection-profile variance; applied as a vertical shear)
     c. Sauvola adaptive binarization (integral-image; contrast-stretch
        fallback when the image is already clean/bimodal)
     d. DPI floor + 10px white border (Tesseract guidance)
   No dependencies. Each sub-step is individually toggleable (PREP_CONFIG) so
   the bench can sweep combos; the whole tier is gated by the `prepV2` setting
   (DEFAULT OFF — the Phase 1 gate failed, see below; "yes" opts into this
   path, unset/"no" keeps the v1 adaptiveThreshold path). Invariants #1/#2/
   #4: on-device, no build step, feature-flagged. */

const PREP_DEFAULTS = { flatten: true, deskew: true, sauvola: true, border: true };
let PREP_CONFIG = { ...PREP_DEFAULTS };
/* master: null -> read the `prepV2` DB setting; true/false -> forced (bench). */
let prepMasterOverride = null;
/* DEFAULT OFF. The Phase 1 bench sweep (2026-07-22, my100) showed prepV2 FAILED
   its gate: every sub-step combo RAISED the weak rate (best combo +1pt vs the
   −3pt-or-better requirement) even though it improved raw totals/date accuracy
   — the clean scanned SROIE bench is the wrong instrument for a phone-photo
   pipeline, and the cleaner binary shifts the parser's totalConf gating. So the
   pipeline ships DORMANT behind an explicit-opt-in flag (set `prepV2`="yes" to
   enable) pending Phase 2 confidence recalibration / a real phone-photo bench.
   See reports/ocr-weekly.md (2026-07-22 Phase-1 row). */
async function prepV2Enabled() {
  if (prepMasterOverride === true) return true;
  if (prepMasterOverride === false) return false;
  try { return (await DB.getSetting("prepV2", "no")) === "yes"; }
  catch (e) { return false; }
}

/* Box-blur a gray plane via an integral image — O(N) regardless of radius. */
function boxBlurGray(gray, w, h, radius) {
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - radius), y2 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - radius), x2 = Math.min(w - 1, x + radius);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integ[(y2 + 1) * (w + 1) + (x2 + 1)] - integ[y1 * (w + 1) + (x2 + 1)]
                - integ[(y2 + 1) * (w + 1) + x1] + integ[y1 * (w + 1) + x1];
      out[y * w + x] = sum / count;
    }
  }
  return out;
}

/* Estimate illumination with a very large box blur, then divide it out and
   re-normalize to the mean — flattens phone-photo shadows and page gradients
   while leaving already-even scans essentially unchanged. */
function flattenShadow(gray, w, h) {
  const radius = Math.max(15, Math.round(Math.max(w, h) / 8));
  const illum = boxBlurGray(gray, w, h, radius);
  let mean = 0;
  for (let i = 0; i < illum.length; i++) mean += illum[i];
  mean /= illum.length;
  const out = new Float64Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const denom = illum[i] < 1 ? 1 : illum[i];
    const v = gray[i] / denom * mean;
    out[i] = v > 255 ? 255 : (v < 0 ? 0 : v);
  }
  return out;
}

function grayArrayToCanvas(gray, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const out = ctx.createImageData(w, h);
  const p = out.data;
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const v = gray[i] < 0 ? 0 : (gray[i] > 255 ? 255 : gray[i]);
    p[j] = p[j + 1] = p[j + 2] = v; p[j + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

/* Dominant text-skew angle (degrees) by projection-profile variance: shear
   the ink map by a candidate angle and measure the variance of the per-row
   ink counts — it peaks when text lines snap onto rows. Coarse ±10° at 1°,
   then fine ±1° at 0.25°. Returns 0 when the peak barely beats 0° (receipts
   are near-vertical crops — don't rotate on noise). Runs on a downscaled copy
   for speed. */
function estimateSkewAngle(gray, w, h) {
  const scale = Math.min(1, 500 / Math.max(w, h));
  const sw = Math.max(8, Math.round(w * scale)), sh = Math.max(8, Math.round(h * scale));
  const small = new Float64Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < sw; x++) {
      small[y * sw + x] = gray[sy * w + Math.min(w - 1, Math.floor(x / scale))];
    }
  }
  let m = 0;
  for (let i = 0; i < small.length; i++) m += small[i];
  m /= small.length;
  const ink = new Uint8Array(sw * sh);
  for (let i = 0; i < small.length; i++) ink[i] = small[i] < m - 10 ? 1 : 0;
  const cx = sw / 2;
  function variance(angleDeg) {
    const k = Math.tan(angleDeg * Math.PI / 180);
    const rows = new Float64Array(sh);
    for (let x = 0; x < sw; x++) {
      const shift = Math.round((x - cx) * k);
      for (let y = 0; y < sh; y++) {
        if (!ink[y * sw + x]) continue;
        const ry = y + shift;
        if (ry >= 0 && ry < sh) rows[ry] += 1;
      }
    }
    let mean = 0;
    for (let y = 0; y < sh; y++) mean += rows[y];
    mean /= sh;
    let v = 0;
    for (let y = 0; y < sh; y++) { const d = rows[y] - mean; v += d * d; }
    return v / sh;
  }
  const v0 = variance(0);
  let best = 0, bestV = v0;
  for (let a = -10; a <= 10; a += 1) {
    if (a === 0) continue;
    const v = variance(a);
    if (v > bestV) { bestV = v; best = a; }
  }
  for (let a = best - 1; a <= best + 1; a += 0.25) {
    const v = variance(a);
    if (v > bestV) { bestV = v; best = a; }
  }
  /* Confidence gate: demand a clear variance gain and a non-trivial angle. */
  if (Math.abs(best) < 0.5 || bestV < v0 * 1.08) return 0;
  return best;
}

/* Apply a vertical shear of `angleDeg` (the projection-profile deskew), growing
   the canvas so nothing clips and filling the new area white. */
function shearCanvasY(canvas, angleDeg) {
  const k = Math.tan(angleDeg * Math.PI / 180);
  const w = canvas.width, h = canvas.height, cx = w / 2;
  const extra = Math.ceil(Math.abs(k) * w / 2) + 1;
  const out = document.createElement("canvas");
  out.width = w; out.height = h + 2 * extra;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height);
  /* y' = k*x + y + (extra - k*cx) → setTransform(1, k, 0, 1, 0, extra - k*cx). */
  ctx.setTransform(1, k, 0, 1, 0, extra - k * cx);
  ctx.drawImage(canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  out.srcMinDim = canvas.srcMinDim;
  return out;
}

/* DPI floor (gently upscale small crops so median char height clears ~20px)
   plus a 10px white quiet-zone border — both help Tesseract's line finder. */
function ensureDpiAndBorder(canvas) {
  let c = canvas;
  const minDim = Math.min(c.width, c.height);
  if (minDim < 1000) {
    const s = Math.min(2.5, 1000 / minDim);
    const nc = document.createElement("canvas");
    nc.width = Math.round(c.width * s); nc.height = Math.round(c.height * s);
    const nctx = nc.getContext("2d");
    nctx.imageSmoothingEnabled = true; nctx.imageSmoothingQuality = "high";
    nctx.drawImage(c, 0, 0, nc.width, nc.height);
    nc.srcMinDim = c.srcMinDim;
    c = nc;
  }
  const pad = 10;
  const out = document.createElement("canvas");
  out.width = c.width + 2 * pad; out.height = c.height + 2 * pad;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, pad, pad);
  out.srcMinDim = c.srcMinDim;
  return out;
}

/* Is the (flattened) image already clean — a near-bimodal white-bg/black-ink
   histogram with few midtones? Then a gentle global contrast stretch reads
   better than Sauvola, which can gnaw clean strokes. */
function isBimodalClean(canvas) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const px = ctx.getImageData(0, 0, w, h).data;
  let mid = 0, n = 0;
  /* Sample every 4th pixel — plenty for a histogram decision, 16× cheaper. */
  for (let i = 0; i < px.length; i += 16) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (g > 70 && g < 190) mid++;
    n++;
  }
  return n > 0 && (mid / n) < 0.14;
}

/* Sauvola local threshold: t = mean * (1 + k*(std/R - 1)), integral images for
   both sum and sum-of-squares so it stays O(N) at any window size. */
function sauvolaBinarize(canvas) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const gray = grayscale(px);
  const stride = w + 1;
  const I = new Float64Array(stride * (h + 1));
  const I2 = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const g = gray[y * w + x];
      rs += g; rs2 += g * g;
      const idx = (y + 1) * stride + (x + 1);
      I[idx] = I[y * stride + (x + 1)] + rs;
      I2[idx] = I2[y * stride + (x + 1)] + rs2;
    }
  }
  const half = (Math.max(15, Math.round(Math.min(w, h) / 30)) | 1) >> 1;
  const k = 0.34, R = 128;
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const s = I[(y2 + 1) * stride + (x2 + 1)] - I[y1 * stride + (x2 + 1)]
              - I[(y2 + 1) * stride + x1] + I[y1 * stride + x1];
      const s2 = I2[(y2 + 1) * stride + (x2 + 1)] - I2[y1 * stride + (x2 + 1)]
               - I2[(y2 + 1) * stride + x1] + I2[y1 * stride + x1];
      const mean = s / count;
      const variance = Math.max(0, s2 / count - mean * mean);
      const t = mean * (1 + k * (Math.sqrt(variance) / R - 1));
      const v = gray[y * w + x] <= t ? 0 : 255;
      const i = (y * w + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/* Run the full v2 pipeline on a loaded (color) canvas. Returns BOTH a
   binarized canvas (fed to Tesseract) and a grayscale canvas in the SAME
   geometry (flattened/deskewed/bordered but not binarized) — the totals-sniper
   crops from the gray one so its bbox coordinates, which come from recognizing
   the binary, line up exactly (thin strokes survive un-binarized). */
async function preprocessV2(base) {
  const w = base.width, h = base.height;
  const cfg = PREP_CONFIG;
  let gray = grayscale(base.getContext("2d").getImageData(0, 0, w, h).data);
  if (cfg.flatten) gray = flattenShadow(gray, w, h);
  let grayCanvas = grayArrayToCanvas(gray, w, h);
  grayCanvas.srcMinDim = base.srcMinDim;
  if (cfg.deskew) {
    const ang = estimateSkewAngle(gray, w, h);
    if (ang !== 0) grayCanvas = shearCanvasY(grayCanvas, ang);
  }
  if (cfg.border) grayCanvas = ensureDpiAndBorder(grayCanvas);
  const binary = document.createElement("canvas");
  binary.width = grayCanvas.width; binary.height = grayCanvas.height;
  binary.getContext("2d").drawImage(grayCanvas, 0, 0);
  binary.srcMinDim = base.srcMinDim;
  if (cfg.sauvola) {
    isBimodalClean(binary) ? contrastStretch(binary) : sauvolaBinarize(binary);
  } else {
    adaptiveThreshold(binary); /* sub-step off → the v1 mean threshold, so the sweep isolates Sauvola's delta */
  }
  return { binary, gray: grayCanvas };
}

/* Preprocess a loaded canvas for OCR: the v2 pipeline when enabled, else the
   v1 adaptiveThreshold path (bit-for-bit today's behavior). */
async function preprocess(base) {
  if (!(await prepV2Enabled())) return { binary: adaptiveThreshold(base), gray: null };
  return preprocessV2(base);
}

let ocrWorkerPromise = null;
async function getOcrWorker() {
  await loadTesseract();
  /* Cache the PROMISE, not the resolved worker. Phase 5's warm-up (fired
     fire-and-forget on chooser-open) and the first scan can call this
     concurrently; a resolved-value guard (`if (!ocrWorker)`) isn't atomic
     across the createWorker await, so both callers would boot a worker and
     orphan one (double traineddata download, leaked thread). Mirrors
     getSniperWorker's promise guard. Clear the cache on failure so a boot
     error isn't stuck forever. */
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker("eng", 1, tesseractWorkerPaths())
      .catch(e => { ocrWorkerPromise = null; throw e; });
  }
  return ocrWorkerPromise;
}

/* Warm-up (Phase 5 speed pass): called when the Add chooser opens, before the
   user has even picked a photo, so the first scan doesn't pay the tesseract.js
   load + worker-boot cost (~0.5-1s cold). getOcrWorker() caches, so the scan
   that follows reuses this exact worker. Best-effort and idempotent — a
   warm-up failure must never surface or affect a real scan. Only the main
   full-page worker is pre-started (the sniper pool stays lazy — it's only
   needed for the minority of weak/missing-total receipts). */
async function warmUp() {
  try { await getOcrWorker(); } catch (e) { /* best-effort; the real scan retries */ }
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
  const prep = await preprocess(await loadCanvas(file));
  let r = await recognizeWithBoxes(worker, prep.binary);
  let canvas = prep.binary, prepGray = prep.gray;
  if (!textUsable(r.text)) {
    if (onProgress) onProgress("Trying harder…");
    const softCanvas = contrastStretch(await loadCanvas(file));
    const r2 = await recognizeWithBoxes(worker, softCanvas);
    if (textUsable(r2.text) || r2.text.trim().length > r.text.trim().length) {
      /* Soft path re-loads the raw file with no v2 geometry, so its lines are
         in the file's own space — drop prepGray and let the sniper reload the
         file (bboxes then match loadCanvas, exactly as in the v1 flow). */
      r = r2; canvas = softCanvas; prepGray = null;
    }
  }
  return { ...r, canvas, prepGray };
}

/* ---------- Totals rescue v2 (sniperV2, OCR-ENGINE-PLAN.md Phase 2) ----------

   Extends the v1 digit-crop sniper (below) with three additions, all gated
   behind the `sniperV2` setting (default OFF — dark-shipped like prepV2):
     - digit-mode second pass over up to 3 candidate total-line REGIONS
       (v1 only ever tried the single best-scoring line) as a fallback
       chain — try region 1, only fall through to region 2/3 if it yields
       no usable digit read. Regions are never pooled together (a Subtotal
       line and a Total line are DIFFERENT numbers; blending their crop
       votes would corrupt the consensus).
     - a confusion-table (O/o->0, B/S/s->8/5, l/I/i->1, Z/z->2) rescue for a
       total-scored line whose amount regex found nothing — likely an
       isolated OCR digit/letter swap. Accepted ONLY when a second signal
       (subtotal+tax arithmetic, items-sum, or cash/change) corroborates it;
       a lone confusion "fix" is worse than staying weak.
     - cross-validation: when the text parser already found a total but at
       low confidence, re-read the same candidate region(s) digit-only and,
       ONLY on agreement, raise totalConf (never overwrite the value on the
       crop-read's own say-so — the Teo Heng lesson from 07-20: an
       unverified "fix" that looks confident is worse than an honest weak
       read, since weak still offers the user a cloud re-read).
   `parseSniperDigits`/`sniperTotal`'s crop-reading mechanics are unchanged;
   sniperV2 only widens the region search when the master flag is on. */

let sniperMasterOverride = null;
/* DEFAULT ON since Phase 4 (OCR-ENGINE-PLAN.md) — Phase 2's bench gate PASSED
   (my100 liveWeak 25%->22%, sroie200 38%->32%, zero previously-correct totals
   flipped) and the consolidated-release code review found + fixed one real
   corroboration bug (itemsAgree double-counting a printed Service Charge
   line) before this flip — see reports/ocr-weekly.md and OCR-ENGINE-PLAN.md.
   set `sniperV2`="no" to opt back out. */
async function sniperV2Enabled() {
  if (sniperMasterOverride === true) return true;
  if (sniperMasterOverride === false) return false;
  try { return (await DB.getSetting("sniperV2", "yes")) === "yes"; }
  catch (e) { return true; }
}
function setSniper(o) {
  o = o || {};
  if ("master" in o) sniperMasterOverride = (o.master === "db" || o.master === null) ? null : !!o.master;
  return getSniper();
}
function getSniper() { return { master: sniperMasterOverride }; }

/* Confusable OCR digit/letter pairs seen on total lines when a whitelist-
   free read drops a digit for its look-alike letter. Applied only to a
   short decimal-shaped token so it can't misfire on ordinary words. */
const CONFUSION_MAP = { O: "0", o: "0", B: "8", S: "5", s: "5", l: "1", I: "1", i: "1", Z: "2", z: "2" };
/* Character class deliberately mirrors CONFUSION_MAP's exact keys (no
   lowercase b, no uppercase L — those aren't confusions this table fixes) —
   a wider class here would admit tokens confusionCorrectedAmount() can never
   actually resolve, silently no-oping instead of rescuing (Phase 4 review). */
const CONFUSABLE_AMOUNT_RE = /\b([0-9OoBSslIiZz]{1,4}[.,][0-9OoBSslIiZz]{2})\b/;
function confusionCorrectedAmount(line) {
  const m = line.match(CONFUSABLE_AMOUNT_RE);
  if (!m || /^[\d.,]+$/.test(m[1])) return null; /* already clean digits — nothing to fix */
  let fixed = "";
  for (const ch of m[1]) fixed += (ch in CONFUSION_MAP ? CONFUSION_MAP[ch] : ch);
  fixed = fixed.replace(",", ".");
  if (!/^\d{1,4}\.\d{2}$/.test(fixed)) return null;
  const amt = parseFloat(fixed);
  return amt > 0 && amt < 100000 ? amt : null;
}

/* Cheap items-sum estimate for corroboration only (the full named item list
   is extracted separately by extractItems()) — same line-shape rules,
   without the name-cleaning cost. Used as a synthetic subtotal so a receipt
   with no printed "Subtotal" line (common on simple/handwritten stalls)
   can still be cross-validated. */
function candidateItemsSum(lines) {
  let sum = 0, n = 0;
  for (const line of lines) {
    if (totalLineScore(line) > 0) continue;
    if (EXCLUDE_TOTAL_RE.test(line)) continue;
    const matches = [...line.matchAll(AMOUNT_RE)];
    if (!matches.length) continue;
    const price = parseAmount(matches[matches.length - 1][1]);
    if (!(price > 0 && price < 100000)) continue;
    sum += price; n++;
    if (n > 30) break;
  }
  return (n >= 1 && n <= 25) ? Math.round(sum * 100) / 100 : null;
}

/* Conservative read of a digits-only OCR result: a wrong amount is worse
   than an empty field. */
function parseSniperDigits(text) {
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

/* Rank OCR'd lines that look total-related by how likely each is to be the
   FINAL total (strong keyword lines — amount due/payable/inclusive — before
   plain "total"/"jumlah" lines), most-recent-first within each tier (the
   grand total usually sits closest to the bottom of the receipt). With
   max=1 this reproduces the v1 sniper's single-candidate pick exactly;
   sniperV2 raises max to try up to 3 REGIONS as a fallback chain (never
   pooled — a Subtotal line and a Total line are different numbers). */
function rankTotalLineCandidates(lines, max) {
  const totalLines = lines.filter(l => /total|jumlah/i.test(l.text || "") && l.bbox);
  const strong = [], plain = [];
  for (const l of totalLines) (/amount|amt|rm|payable|inclu/i.test(l.text) ? strong : plain).push(l);
  const ordered = [...strong.slice().reverse(), ...plain.slice().reverse()];
  return ordered.slice(0, max);
}

function cropXFor(target, canvasWidth) {
  let cropX = target.bbox.x0;
  for (const w of target.words) {
    if (w.bbox && /total|amount|amt|jumlah|rm|payable|[:]/i.test(w.text || "")) {
      cropX = Math.max(cropX, w.bbox.x1);
    }
  }
  return Math.min(cropX + 4, canvasWidth - 20);
}

/* Digit-mode second pass over ONE candidate region: tight and tall crops
   (handwriting overflows the printed line), raw grayscale and binarized
   (thin pen strokes can vanish when binarized), two paddings x two
   binarization modes = up to 4 readings, returned as raw votes (not yet
   reduced to a consensus — callers decide how to combine across regions). */
/* `workers`: a single worker (v1 / sniperTotal — UNCHANGED sequential path,
   byte-identical to before pooling existed) or an array (sniperCrossValidate's
   pool, OCR-ENGINE-PLAN.md Phase 4 latency fix) — crops are built up front,
   then recognized concurrently across the pool. Promise.all preserves
   result order by input index regardless of which crop's recognize()
   settles first, so `votes` reconstructs in the exact same order the
   sequential loop would have produced it in; only wall-clock time changes,
   consensusFromVotes sees the same set either way. Pool members are
   pre-configured (see getSniperWorkerPool) — no per-job setParameters,
   since concurrent setParameters calls on a worker mid-dispatch would race. */
async function digitVotesForLine(workers, raw, target, canvas) {
  const pool = Array.isArray(workers) ? workers : [workers];
  const votes = [];
  const lh = Math.max(8, target.bbox.y1 - target.bbox.y0);
  const x0 = cropXFor(target, canvas.width);
  const cw = canvas.width - x0 - 2;
  if (cw < 20) return votes;
  const crops = [];
  for (const pad of [0.9, 1.6]) {
    const y0 = Math.max(0, target.bbox.y0 - lh * pad);
    const y1 = Math.min(canvas.height, target.bbox.y1 + lh * pad);
    const ch = y1 - y0;
    if (ch < 8) continue;
    for (const useBin of [false, true]) {
      const scale = Math.max(1, Math.min(4, 130 / ch));
      const crop = document.createElement("canvas");
      crop.width = Math.round(cw * scale);
      crop.height = Math.round(ch * scale);
      crop.getContext("2d").drawImage(raw, x0, y0, cw, ch, 0, 0, crop.width, crop.height);
      if (useBin) adaptiveThreshold(crop);
      crops.push(crop);
    }
  }
  if (pool.length === 1) {
    for (const crop of crops) {
      await pool[0].setParameters({ tessedit_char_whitelist: "0123456789.,|/- ", tessedit_pageseg_mode: "7" });
      try {
        const amt = parseSniperDigits((await pool[0].recognize(crop)).data.text || "");
        if (amt !== null) votes.push(amt);
      } catch (e) { /* keep trying other variants */ }
    }
    return votes;
  }
  const results = await Promise.all(crops.map((crop, i) =>
    pool[i % pool.length].recognize(crop).then(
      r => parseSniperDigits(r.data.text || ""),
      () => null
    )
  ));
  for (const amt of results) if (amt !== null) votes.push(amt);
  return votes;
}

/* Magnitude consensus over one region's votes: a hallucinated extra digit
   lands 10x off the other readings — keep only votes near the median, and
   demand either agreement or a modest single value. */
function consensusFromVotes(votes) {
  if (!votes.length) return null;
  const sorted = [...votes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const kept = votes.filter(v => v <= median * 2 && v >= median / 2);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0] < 10000 ? kept[0] : null;
  const counts = {};
  let best = kept[0], bestN = 0;
  for (const v of kept) {
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > bestN) { bestN = counts[v]; best = v; }
  }
  return best;
}

/* Dedicated persistent worker for sniperV2's digit-crop passes, isolated
   from the main full-page-recognition worker (getOcrWorker()'s worker) —
   found the hard way, on the my100 bench: sharing one worker between full-
   page recognition and many whitelist+PSM7 digit-crop reads measurably
   degrades LATER receipts' full-page OCR within the SAME scan session
   (confirmed: a fresh worker reading a previously-corrupted receipt in
   isolation got it right; the same receipt, reached after ~25 other
   receipts' worth of sniperV2 cross-validation crops on the SHARED worker,
   came out wrong — Tesseract's engine evidently carries some state across
   recognize() calls that a run of digit-only micro-crops visibly disturbs).
   v1's occasional (total-missing-only) rescue crop is rare enough that this
   was never a practical problem; sniperV2's cross-validation runs on every
   weak-but-present receipt too, frequent enough to compound across a scan.
   One worker, created once, reused for every sniperV2 digit-crop call. */
let sniperWorkerPromise = null;
async function getSniperWorker() {
  await loadTesseract();
  if (!sniperWorkerPromise) sniperWorkerPromise = Tesseract.createWorker("eng", 1, tesseractWorkerPaths());
  return sniperWorkerPromise;
}

/* OCR-ENGINE-PLAN.md Phase 4 latency fix: sniperCrossValidate measured
   50-140s on a real device (2 real scans, Samsung S25 Ultra debug APK) —
   up to 3 candidate regions x up to 4 sequential recognize() calls each,
   often finding no agreement and falling back to cloud anyway (the on-
   device work bought nothing). A dedicated 2-worker pool, SEPARATE from
   getSniperWorker() above (sniperTotal — the "total is missing entirely"
   path that writes parsed.total directly with no fallback — is deliberately
   left untouched; only sniperCrossValidate, which can only ever raise
   totalConf and never write a wrong total, gets the pool). Parameters are
   set ONCE here, not per-call (digitVotesForLine's pool branch never calls
   setParameters) — both members stay in digit-whitelist/PSM7 mode
   permanently, since that's the pool's only purpose. */
const SNIPER_POOL_SIZE = 2;
let sniperPoolPromise = null;
async function getSniperWorkerPool() {
  await loadTesseract();
  if (!sniperPoolPromise) {
    sniperPoolPromise = Promise.all(
      Array.from({ length: SNIPER_POOL_SIZE }, () => Tesseract.createWorker("eng", 1, tesseractWorkerPaths()))
    ).then(async workers => {
      for (const w of workers) await w.setParameters({ tessedit_char_whitelist: "0123456789.,|/- ", tessedit_pageseg_mode: "7" });
      return workers;
    });
  }
  return sniperPoolPromise;
}

/* When no amount was found in the full read, zoom into the region to the
   right of the "TOTAL" label and re-read it digits-only. sniperV2 tries up
   to 3 candidate regions as a fallback chain (region 1 first; only moves to
   region 2/3 if it yields no usable digit read at all) — v1 (sniperV2
   false/undefined) tries exactly the one region it always has, on the SAME
   shared worker as before this refactor (byte-for-byte the same crop/vote/
   consensus math AND the same worker instance — v1's behavior is untouched;
   only sniperV2 moves to the isolated worker above). */
async function sniperTotal(worker, file, boostFlag, canvas, lines, prepGray, sniperV2) {
  const candidates = rankTotalLineCandidates(lines, sniperV2 ? 3 : 1);
  if (!candidates.length) return null;
  const raw = prepGray || await loadCanvas(file, boostFlag);
  const w = sniperV2 ? await getSniperWorker() : worker;
  let result = null;
  for (const target of candidates) {
    const v = consensusFromVotes(await digitVotesForLine(w, raw, target, canvas));
    if (v !== null) { result = v; break; }
  }
  await w.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
  return result;
}

/* sniperV2 only: the text parser already found a total but at low
   confidence — re-read up to 1 candidate region digit-only (Phase 4 latency
   fix: was up to 3 — see getSniperWorkerPool's comment; the region-3 fallback
   rarely paid for its own cost, per the measured 50-140s scans) and report
   whether it agrees (to the sen). Never returns a value: agreement only
   raises the caller's confidence, it never overwrites what the text parser
   found (see the Teo Heng lesson in the section comment above). Uses the
   pooled sniper workers (parallel digit-crop reads), never the singular one
   sniperTotal uses — this path only ever runs when sniperV2 is on. */
async function sniperCrossValidate(file, boostFlag, canvas, lines, prepGray, candidateTotal) {
  const candidates = rankTotalLineCandidates(lines, 1);
  if (!candidates.length) return false;
  const raw = prepGray || await loadCanvas(file, boostFlag);
  const pool = await getSniperWorkerPool();
  let agreed = false;
  for (const target of candidates) {
    const v = consensusFromVotes(await digitVotesForLine(pool, raw, target, canvas));
    if (v !== null && Math.abs(v - candidateTotal) <= 0.02) { agreed = true; break; }
  }
  return agreed;
}

/* ---------- Native OCR (nativeOcr, OCR-ENGINE-PLAN.md Phase 3a) ----------

   On the Capacitor native app (Android), read receipts with Google ML Kit
   Text Recognition v2 (unbundled / Play-services) through the recap-mlkit-ocr
   plugin instead of Tesseract — near-instant, and far stronger on phone
   photos. Gated behind the `nativeOcr` setting (default OFF — dark-shipped
   like prepV2/sniperV2) AND behind actually running inside the native shell
   WITH the plugin present. In a browser/PWA `window.Capacitor` is undefined,
   so isNativeOcrAvailable() is false and this whole tier is inert: the web
   path is byte-for-byte unchanged (the Phase 3a gate). Tesseract stays the web
   engine and the automatic fallback when the plugin is absent or errors. */

/* Mirrors app.js isNative(), kept local so ocr.js has NO load-order dependency
   on app.js (index.html loads ocr.js first). */
function ocrIsNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
}

/* The ML Kit plugin proxy. window.Capacitor.registerPlugin() (what the
   plugin's own README describes) is a WRAPPER exported by the @capacitor/core
   NPM package's JS bundle — never loaded here since this is a no-build-step
   vanilla app (confirmed live via chrome://inspect during the Phase 3b device
   bench: window.Capacitor.registerPlugin is not a function on a real device,
   even though the plugin registers fine natively). The native bridge itself
   auto-populates window.Capacitor.Plugins[name] for every properly-registered
   plugin regardless of how the JS side reaches it — app.js's captureNative()
   already relies on exactly this for Capacitor.Plugins.Camera, so mirror that
   working pattern instead of registerPlugin. window.Capacitor is undefined on
   the web, so this stays null there — the root reason the native path can
   never fire in a browser. Memoised. */
let mlkitPlugin;
function getMlkitPlugin() {
  if (mlkitPlugin !== undefined) return mlkitPlugin;
  mlkitPlugin = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.RecapMlkitOcr) || null;
  return mlkitPlugin;
}

function isNativeOcrAvailable() {
  return ocrIsNative() && getMlkitPlugin() !== null;
}

let nativeOcrMasterOverride = null;
/* DEFAULT OFF. Ships dark behind the `nativeOcr` setting; Phase 3b benches it
   on a real device and Phase 4 flips the default on with the rest of Part 1.
   The AVAILABILITY gate is checked FIRST, so even a forced-on master cannot
   activate the native path in a browser — keeping the Phase 3a web-inert gate
   airtight (a bench double-run with the flag on vs off is identical on web). */
async function nativeOcrEnabled() {
  if (!isNativeOcrAvailable()) return false;
  if (nativeOcrMasterOverride === true) return true;
  if (nativeOcrMasterOverride === false) return false;
  try { return (await DB.getSetting("nativeOcr", "no")) === "yes"; }
  catch (e) { return false; }
}
function setNative(o) {
  o = o || {};
  if ("master" in o) nativeOcrMasterOverride = (o.master === "db" || o.master === null) ? null : !!o.master;
  return getNative();
}
function getNative() { return { master: nativeOcrMasterOverride, available: isNativeOcrAvailable() }; }

/* File -> bare base64 (no data-URL prefix) for the plugin bridge. */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || "");
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    fr.onerror = () => reject(new Error("Could not read the image file."));
    fr.readAsDataURL(file);
  });
}

/* ML Kit already segments text into lines, but a receipt's label and its
   amount often land in TWO separate ML Kit lines at the same height (two
   visual columns). Merge lines whose vertical spans overlap into one row,
   order each row left-to-right, and emit the SAME { text, bbox, words } shape
   recognizeWithBoxes() produces from Tesseract — so parseReceiptText() sees
   "TOTAL   23.50" on one line, and the digit-sniper's crop math
   (rankTotalLineCandidates/cropXFor/digitVotesForLine) works unchanged.
   Frames are scaled by (sx,sy) from source-image pixels into loadCanvas()'s
   coordinate space, so a sniper crop taken from that canvas lines up with the
   boxes. */
function mlkitRowsToLines(mlLines, sx, sy) {
  /* A frame must have all-finite coords: a box-less ML Kit line would otherwise
     yield a NaN bbox that still passes the sniper's truthy-bbox filter and then
     throws mid-crop (defense in depth — the plugin already drops null boxes). */
  const finiteFrame = fr => fr && [fr.left, fr.top, fr.right, fr.bottom].every(Number.isFinite);
  const frags = [];
  for (const l of mlLines) {
    if (!l || !finiteFrame(l.frame) || typeof l.text !== "string" || !l.text.trim()) continue;
    const f = l.frame;
    const bbox = { x0: f.left * sx, y0: f.top * sy, x1: f.right * sx, y1: f.bottom * sy };
    const words = [];
    for (const e of (l.elements || [])) {
      if (!e || !finiteFrame(e.frame)) continue;
      words.push({ text: e.text || "", bbox: { x0: e.frame.left * sx, y0: e.frame.top * sy, x1: e.frame.right * sx, y1: e.frame.bottom * sy } });
    }
    frags.push({ text: l.text.trim(), bbox, words, cy: (bbox.y0 + bbox.y1) / 2, h: Math.max(1, bbox.y1 - bbox.y0) });
  }
  frags.sort((a, b) => a.cy - b.cy || a.bbox.x0 - b.bbox.x0);
  const rows = [];
  for (const fr of frags) {
    const row = rows.length ? rows[rows.length - 1] : null;
    if (row && Math.abs(fr.cy - row.cy) <= Math.max(fr.h, row.h) * 0.6) {
      row.frags.push(fr);
      row.cy = (row.cy * row.n + fr.cy) / (row.n + 1);
      row.n++;
      row.h = Math.max(row.h, fr.h);
    } else {
      rows.push({ frags: [fr], cy: fr.cy, h: fr.h, n: 1 });
    }
  }
  return rows.map(row => {
    const ordered = row.frags.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const bbox = {
      x0: Math.min(...ordered.map(f => f.bbox.x0)),
      y0: Math.min(...ordered.map(f => f.bbox.y0)),
      x1: Math.max(...ordered.map(f => f.bbox.x1)),
      y1: Math.max(...ordered.map(f => f.bbox.y1))
    };
    const words = [];
    for (const f of ordered) {
      if (f.words.length) words.push(...f.words);
      else words.push({ text: f.text, bbox: f.bbox });
    }
    return { text: ordered.map(f => f.text).join(" "), bbox, words };
  });
}

/* Native scan path: ML Kit reads the photo on-device, we reshape its lines into
   the parser's text/line shape, parse, then run the SAME digit-sniper rescue /
   cross-validation the web path uses (Tesseract re-reads the crop for the
   double-check — the digit-sniper runs on ML Kit output too, per the plan).
   Returns a parsed result, or null to signal "fall back to Tesseract" (no
   lines read, or the plugin/engine unavailable). Any throw propagates and
   scanReceipt() catches it into the same Tesseract fallback. */
async function scanReceiptNative(file, onProgress, sniperV2) {
  if (sniperV2 === undefined) sniperV2 = await sniperV2Enabled();
  const plugin = getMlkitPlugin();
  if (!plugin) return null;
  if (onProgress) onProgress("Reading text…");
  const res = await plugin.recognize({ image: await fileToBase64(file) });
  if (!res || !Array.isArray(res.lines) || !res.lines.length) return null;
  /* Load the raw photo at the web path's scale so the sniper's crops (taken
     from THIS canvas) line up with the ML Kit boxes we scale to match it.
     NOTE (verify in Phase 3b): ML Kit reads the bitmap as-is (rotation 0),
     while loadCanvas() decodes via <img>, which applies EXIF orientation in the
     WebView. For an EXIF-rotated photo the two coordinate spaces disagree, so
     the sniper's re-crop lands off. That is HARMLESS — the sniper is
     conservative (a wrong crop yields no digit consensus, never a wrong total),
     it only disables the native rescue on such photos. On-device, check whether
     Capacitor Camera already normalises orientation; if not, pass the EXIF
     rotation to InputImage and map boxes into display space. */
  const raw = await loadCanvas(file);
  const sw = res.width > 0 ? res.width : raw.width;
  const sh = res.height > 0 ? res.height : raw.height;
  const rows = mlkitRowsToLines(res.lines, raw.width / sw, raw.height / sh);
  if (!rows.length) return null;
  const text = rows.map(r => r.text).join("\n");
  let parsed = await parseReceiptText(text, sniperV2);
  if (parsed.total === null) {
    if (onProgress) onProgress("Zooming into the total…");
    try {
      const worker = await getOcrWorker();
      const t = await sniperTotal(worker, file, false, raw, rows, raw, sniperV2);
      if (t) parsed.total = t;
    } catch (e) { /* rescue is best-effort */ }
  } else if (sniperV2 && parsed.totalConf <= 1) {
    if (onProgress) onProgress("Double-checking the total…");
    try {
      const agree = await sniperCrossValidate(file, false, raw, rows, raw, parsed.total);
      if (agree) parsed.totalConf = 2;
    } catch (e) { /* corroboration is best-effort */ }
  }
  return parsed;
}

/* Full scan pipeline: OCR (with retry), parse, then the digit-zoom rescue
   pass if the total is still missing (or, sniperV2 only, a cross-validation
   pass if a total was found but weak). On the native app the ML Kit path runs
   first (dark by default); it returns null / throws to fall back to Tesseract,
   the web engine. */
async function scanReceipt(file, onProgress) {
  if (await nativeOcrEnabled()) {
    try {
      const nativeParsed = await scanReceiptNative(file, onProgress);
      if (nativeParsed) return nativeParsed;
    } catch (e) { /* any native/plugin failure → fall through to Tesseract */ }
  }
  if (onProgress) onProgress("Reading text…");
  const worker = await getOcrWorker();
  const sniperV2 = await sniperV2Enabled();
  let r = await ocrBest(worker, file, onProgress);
  /* IMPORTANT: the retry-or-not decision below, and which of the two OCR
     passes wins, is always made on the sniperV2=false parse — never the
     sniperV2-corroborated one. sniperV2's items-sum/confusion-table can
     raise totalConf on a coincidentally-corroborated but WRONG first-pass
     read; if that boosted conf fed the retry trigger, it could silently
     suppress the exact magnified-retry safety net v1 relies on to self-
     correct a noisy first read (found the hard way: several my100 receipts
     that were correct via the boost retry came out wrong once sniperV2's
     early confidence bump skipped it). sniperV2 is applied ONLY at the end,
     as a final re-parse of whichever text already won on v1-identical
     terms — so it can only add confidence/rescue a still-missing total,
     never quietly steer which OCR pass gets trusted. */
  let parsed = await parseReceiptText(r.text, false);
  let rBoost = false;
  /* Retry magnified when the total is missing, weakly evidenced, or the
     photo is low-res (where the normal pass misreads small digits). */
  const small = r.canvas.srcMinDim && r.canvas.srcMinDim < 700;
  let boosted = null;
  if (parsed.total === null || parsed.totalConf <= 1 || (small && parsed.totalConf < 3)) {
    if (onProgress) onProgress("Looking closer…");
    try {
      const bigPrep = await preprocess(await loadCanvas(file, true));
      const r2 = await recognizeWithBoxes(worker, bigPrep.binary);
      const p2 = await parseReceiptText(r2.text, false);
      boosted = { r: { ...r2, canvas: bigPrep.binary, prepGray: bigPrep.gray }, p: p2 };
      if (p2.total !== null && (parsed.total === null || p2.totalConf > parsed.totalConf || (small && p2.totalConf >= parsed.totalConf))) {
        r = boosted.r;
        parsed = p2;
        rBoost = true;
      }
    } catch (e) { /* magnified retry is best-effort */ }
  }
  if (sniperV2) parsed = await parseReceiptText(r.text, true);
  if (parsed.total === null) {
    if (onProgress) onProgress("Zooming into the total…");
    /* Prefer the magnified pass's geometry for the zoom — finer detail. */
    const src = (boosted && boosted.r.lines.length) ? { rr: boosted.r, flag: true } : (r.lines.length ? { rr: r, flag: rBoost } : null);
    if (src) {
      try {
        const t = await sniperTotal(worker, file, src.flag, src.rr.canvas, src.rr.lines, src.rr.prepGray, sniperV2);
        if (t) parsed.total = t;
      } catch (e) { /* rescue pass is best-effort */ }
    }
  } else if (sniperV2 && parsed.totalConf <= 1) {
    if (onProgress) onProgress("Double-checking the total…");
    const src = (boosted && boosted.r.lines.length) ? { rr: boosted.r, flag: true } : (r.lines.length ? { rr: r, flag: rBoost } : null);
    if (src) {
      try {
        const agree = await sniperCrossValidate(file, src.flag, src.rr.canvas, src.rr.lines, src.rr.prepGray, parsed.total);
        if (agree) parsed.totalConf = 2;
      } catch (e) { /* corroboration pass is best-effort */ }
    }
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

/* (?<!\d) on both: without it, a comma-less 4+-digit amount ("3859.00")
   silently matches its own LAST 3-4 digits instead of failing to match —
   the engine can't take \d{1,3}/\d{1,4} across the whole run, so on the
   first anchor position it backtracks to failure and just retries one
   character later, which happens to succeed on the truncated suffix
   ("3859.00" -> "859.00"). The lookbehind forces a match to start at the
   actual beginning of a digit run, so a too-long run correctly matches
   nothing here and falls through to LOOSE_AMOUNT_RE / RM_INT_RE instead of
   silently returning a wrong, smaller value (found live: a real RM3859.00
   invoice read as RM859 with no error, discovered testing the learned-hint
   path, where a hint-confirmed total skips the cloud safety net entirely). */
const AMOUNT_RE = /(?<!\d)(\d{1,3}(?:[,\s]\d{3})*\.\d{2})(?!\d)/g;
/* OCR often reads a decimal point as a comma or adds stray spaces
   ("100,20", "43 . 50"). Only trusted on lines that already talk about
   totals/cash/change. Same (?<!\d) reasoning as AMOUNT_RE — otherwise a
   5+-digit amount ("12345.67") truncates to its last 4-6 digits instead of
   falling through to RM_INT_RE/COLUMN_AMOUNT_RE (both already anchored on
   \b, which a mid-digit-run position can never satisfy — they were never
   vulnerable to this). */
const LOOSE_AMOUNT_RE = /(?<!\d)(\d{1,4})\s*[.,]\s*(\d{2})(?!\d)/;
/* Mamak and stall receipts often print whole ringgit: "TOTAL RM 43". */
const RM_INT_RE = /\brm\b\s*:?\s*(\d{1,5})(?!\s*[.,]?\d)/i;
/* Invoice books write ringgit and sen in separate columns: "2269 | 00"
   OCRs as "2269 00" (sometimes with a stray | or l between). */
const COLUMN_AMOUNT_RE = /\b(\d{1,5})\s*[|/lI!]?\s+(\d{2})\b(?!\s*[.,]?\d)/;

/* "service"/"charge" belong here too (not just extractTotal's dedicated c.svc
   capture ~line 1476): candidateItemsSum() and extractItems() both filter
   candidate item lines through this same regex, and without these tokens a
   printed "Service Charge" line was being folded into BOTH c.svc (correctly)
   AND the items-sum (as if it were a purchased item) — double-counting it in
   itemsAgree()'s corroboration arithmetic (OCR-ENGINE-PLAN.md Phase 4 review). */
const EXCLUDE_TOTAL_RE = /\b(change|chg|baki|tunai|cash|credit|visa|master|debit|tendered|payment|bayaran|balance|point|rounding|item count|qty|gst|sst|tax|cukai|saving|diskaun|discount|service|charge)\b/i;
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
  /* OCR debris after the name ("... TRADING . see", "... TRADING . 5") —
     drop short trailing lowercase or digit tokens. */
  while (words.length > 2 && /^([a-z]{1,4}|\d{1,2})\.?$/.test(words[words.length - 1])) words.pop();
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

/* sniperV2 only — real Malaysian company names mined from the SROIE truth
   set (OCR-ENGINE-PLAN.md Phase 2), used to validate a candidate header
   line even when it carries none of COMPANY_HINT_RE's keywords (many small
   shops print no "SDN BHD"/"enterprise" at all — "ASIA MART", "YAM FRESH",
   "THREE STOOGES"). Static, parser-intrinsic data (no device/user state),
   so it applies identically whether scoring runs cold or seeded.
   Deliberately mined EXCLUDING ids 100-299 — that range is `sroie200`, the
   fixed-forever held-out generalization sample, and must stay uncontaminated
   by anything the parser was tuned against. Source: 426 of the 626
   `bench-sroie/raw/key/*.json` truth files (ids 000-099 + 300-625), deduped;
   see OCR-ENGINE-PLAN.md Phase 2. */
const MERCHANT_LEXICON = [
  "10 GRAM GOURMET SBN BHD",
  "32 PUB & BISTRO OWN BY CNU TRADING",
  "99 SPEED MART S/B",
  "ABC HO TRADING",
  "ADVANCO COMPANY",
  "AEON CO. (M) BHD",
  "AEON CO. (M) BHD.",
  "AEON CO. (M) SDN BHD",
  "AIK HUAT HARDWARE ENTERPRISE (SETIA ALAM) SDN BHD",
  "AMTECH ELECTRICAL SUPPLIES",
  "ANEKA INTERTRADE MARKETING SDN BHD",
  "ANN GIAP TRADING SDN BHD",
  "ASIA MART",
  "BANH MI CAFE SDN BHD",
  "BECON STATIONER BECON ENTERPRISE SDN BHD",
  "BENS INDEPENDENT GROCER SDN. BHD",
  "BERRY'S CAKE HOUSE",
  "BEST DENKI MALAYSIA",
  "BOOK TA .K (TAMAN DAYA) SDN BHD",
  "C W KHOO HARDWARE SDN BHD",
  "CARREFOUR RESTAURANT",
  "CHECKERS HYPERMARKET SDN BHD (JALAN KLANG LAMA)",
  "CHEF LEE SDN BHD",
  "COSWAY (M) SDN BHD",
  "DE LUXE CIRCLE FRESH MART SDN BHD",
  "DE MAXIMUM THAI EXPRESS SDN BHD",
  "DIGI TELECOMMUNICATIONS SDN BHD",
  "DIMILIKI OLEH : DOVE HOLDINGS SDN BHD",
  "DIMILIKI OLEH T PLUS F&B SDN. BHD.",
  "DION REALTIES SDN BHD",
  "DOMINO'S PIZZA",
  "DOMINO'S PIZZA TAMAN UNIVERSITI",
  "ECO-SHOP MARKETING SDN BHD",
  "ECOSWAY.COM SDN BHD",
  "EDEN IMPRESSION SDN BHD",
  "EIGHT OUNCE COFFEE CO.",
  "ENW HARDWARE CENTRE (M) SDN. BHD.",
  "ESJAY FUEL ENTERPRISE",
  "FAMILYMART",
  "FARMASI LIGAMAS",
  "FILL IN ENTERPRISE",
  "FOUR QUARTERS SDN BHD",
  "FTOF NOODLE HOUSE",
  "FUYI MINI MARKET",
  "FY EAGLE ENTERPRISE",
  "GARDENIA BAKERIES (KI ) SDN BHD",
  "GARDENIA BAKERIES (KL) SDN BHD",
  "GERBANG ALAF RESTAURANTS SDN BHD",
  "GH DISTRIBUTOR & MARKETING SDN BHD",
  "GHEE HIANG GH DISTRIBUTOR & MARKETING SDN BHD",
  "GL HANDICRAFT & TAIL ORING",
  "GOLDEN ARCHES RESTAURANTS SDN BHD",
  "GRANDMA HOMES RESTAURANT",
  "GREEN LANE PHARMACY SDN BHD",
  "GUARDIAN HEALTH AND BEAUTY SDN BHD",
  "HAI-O RAYA BHD",
  "HAXINCONE RESOURCES SDN BHD",
  "HOME MASTER HARDWARE & ELECTRICAL",
  "HON HWA HARDWARE TRADING",
  "IDEAL MENU GROUP SDN BHD",
  "IKANO HANDEL SDN BHD",
  "INDAH GIFT & HOME DECO",
  "K STATIONERY & OFFICE SUPPLIES",
  "KEDAI PAPAN YEW CHUAN",
  "KEDAI RUNCIT ZBH",
  "KEDAI UHAT DAN RUNCIT CHONG HWA",
  "KFA SUPPLY",
  "KHIAM AIK CHAN SDN BHD",
  "KT WONG TRADING",
  "LAVENDER CONFECTIONERY & BAKERY S/B",
  "LEMON TREE RESTAURANT JTJ FOODS SDN BHD",
  "LEONG HENG SHELL SERVICE STATION",
  "LIAN CHI PU TIAN VEGETARIAN RESTAURANT SDN BHD",
  "LIAN HING STATIONERY SDN BHD",
  "LIGHTROOM GALLERY SDN BHD",
  "MAKASSAR FRESH MARKET S/B",
  "MEGAH RETAIL SDN BHD",
  "MENTAI INITIAL SDN BHD",
  "MIZU MENTAI SDN. BHD.",
  "MOONLIGHT CAKE HOUSE SDN BHD",
  "MPH BOOKSTORES SDN BHD",
  "MR D.I.Y. (JOHOR) SDN BHD",
  "MR D.I.Y. (M) SDN BHD",
  "MR. D.I.Y. (KUCHAI) SDN BHD",
  "MR. D.I.Y. (M) SDN BHD",
  "MR. D.I.Y. SDN BHD",
  "MR.D.I.Y(M)SDN BHD",
  "MYNEWS RETAIL SB",
  "NADEJE PLATINUM SDN BHD",
  "NANDO'S CHICKENLAND MALAYSIA SDN BHD",
  "OCEAN LC PACKAGING ENTERPRISE",
  "OGN GROUP SDN BHD",
  "OLD TOWN KOPITIAM SDN BHD",
  "ONE ONE THREE SEAFOOD RESTAURANT SDN BHD",
  "OWNER BY CASTLE BLUE S/B",
  "PAGOH REST AND SERVICE AREA",
  "PANDAH INDAH PULAU KETAM RESTAURANT",
  "PAPPARICH BMC",
  "PASAR MINI JIN SENG",
  "PASAR RAYA MEGA MAJU (SEMENYIH) SDN BHD",
  "PASARAYA BORONG PINTAR SDN BHD",
  "PASARAYA CINWA SDN BHD",
  "PASARAYA JALAL SDN BHD",
  "PASIR EMAS HARDWARE SDN BHD",
  "PERNIAGAAN ZHENG HUI",
  "PETRODELI ENTERPRISE",
  "PINGHWAI TRADING SDN BHD",
  "POPULAR BOOK CO. (M) SDN BHD",
  "PROSPER NIAGA",
  "R&C VENTURE SDN BHD",
  "RAPID RAIL SDN BHD",
  "RESTAURANT JIAWEI JIAWEI HOUSE",
  "RESTAURANT SIN DU",
  "RESTORAN DE COFFEE O",
  "RESTORAN HASSANBISTRO",
  "RESTORAN WAN SHENG",
  "S&Y STATIONERY",
  "S.H.H. MOTOR (SUNGAI RENGIT) SDN. BHD.",
  "SAM SAM TRADING CO",
  "SANG KEE CHERAS RESTAURANT",
  "SANJUNG REALITI SDN. BHD.",
  "SANYU STATIONERY SHOP",
  "SHELL ISNI PETRO TRADING",
  "SIN THYE & COMPANY",
  "SKCA HARDWARE & TIMBER SDN. BHD.",
  "SOON HUAT MACHINERY ENTERPRISE",
  "SUBANG HEALTHCARE SDN BHD",
  "SUN WONG KUT SDN BHD",
  "SWC ENTERPRISE SDN BHD",
  "SYARIKAT PERNIAGAAN GIN KEE",
  "SYL ROASTED DELIGHTS SDN. BHD.",
  "TASTE OF THE WORLD SDN BHD",
  "TED HENG STATIONERY & BOOKS",
  "TEO HENG STATIONERY & BOOKS",
  "TF VALUE-MART SDN BHD",
  "THAI DELICIOUS RESTAURANT",
  "THE MARCO POLO KITCH BUKIT INDAH",
  "THE ROTI MAN BAKERY",
  "THE TOAST F&B SDN BHD",
  "THREE STOOGES",
  "TIMELESS KITCHENETTE SDN BHD",
  "TRI SHAAS SDN BHD",
  "TRIPLE SIX POINT ENTERPRISE 666",
  "UNIHAKKA INTERNATIONAL SDN BHD",
  "UROKO JAPANESE CUISINE SDN BHD",
  "VERBENA CONFECTIONERY SDN BHD",
  "VIVOPAC MARKETING SDN BHD",
  "WAHIN HARDWARE SDN BHD",
  "WARAKUYA PERMAS CITY SDN BHD",
  "WESTERN EASTERN ST TIONERY SDN. BHD",
  "WESTERN EASTERN STATIONERY SDN. BHD",
  "YAM FRESH",
  "YHM AEON TEBRAU CITY",
  "YONG TAT HARDWARE TRADING",
  "YONGFATT ENTERPRISE"
];

const MERCHANT_LEGAL_SUFFIX_RE = /\b(sdn\.?\s*bhd\.?|s\/b|berhad|bhd|enterprise|trading|holdings?|corporation|corp|company|co\.?|ltd\.?|inc\.?)\b/gi;
function normForFuzzy(s) {
  return String(s || "").toLowerCase().replace(MERCHANT_LEGAL_SUFFIX_RE, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
/* "Token-set ratio": strongest of (a) one normalized name containing the
   other outright, (b) sharing a distinctive (>=4-char) token — the same
   style already proven by bench/score.js's fuzzyMerchantMatch (not shared
   directly: score.js isn't loaded in production), reused here so
   guessMerchant can validate a candidate line against a known-name lexicon. */
function tokenSetMatch(a, b) {
  const g = normForFuzzy(a), t = normForFuzzy(b);
  if (!g || !t) return 0;
  if (g === t) return 1;
  if (g.length >= 4 && t.includes(g)) return 0.9;
  if (t.length >= 4 && g.includes(t)) return 0.9;
  const gTokens = new Set(g.split(" ").filter(w => w.length >= 4));
  const tTokens = t.split(" ").filter(w => w.length >= 4);
  return tTokens.some(w => gTokens.has(w)) ? 0.75 : 0;
}

/* Best lexicon-validated header line, or null. A high bar (containment or a
   shared distinctive token) keeps false positives rare — this is a
   fallback/booster ahead of the keyword heuristic below, not a replacement
   for it. */
function lexiconMerchantMatch(lines) {
  const head = lines.slice(0, 10);
  let best = null, bestScore = 0;
  for (const line of head) {
    if (NOISE_LINE_RE.test(line) || ADDRESS_RE.test(line)) continue;
    if (!lineQuality(line)) continue;
    for (const name of MERCHANT_LEXICON) {
      const score = tokenSetMatch(line, name);
      if (score > bestScore) { bestScore = score; best = line; }
    }
  }
  return bestScore >= 0.75 ? cleanMerchantLine(best) : null;
}

function guessMerchant(lines, sniperV2) {
  if (sniperV2) {
    const lex = lexiconMerchantMatch(lines);
    if (lex) return lex;
  }
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
      /* 6-digit cap: a 7-digit run means OCR hallucinated a digit
         (RM 22,649.08 expenses don't appear on receipts; RM 2,269.00 does). */
      if (digits.length >= 3 && digits.length <= 6) {
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
function extractTotal(lines, ccInfo, sniperV2) {
  const c = { boosted: null, boostedIsRound: false, plain: null, sub: null, tax: null, svc: null, rounding: 0, fallbackMax: null, confusion: null };
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
    if (!amounts.length) {
      /* sniperV2: a total-scored line with NO parseable amount is often an
         isolated OCR digit/letter confusion rather than truly blank text —
         keep a candidate, arbitrated (with corroboration required) below. */
      if (sniperV2 && score >= 10) {
        const cx = confusionCorrectedAmount(line);
        if (cx !== null && (c.confusion === null || cx > c.confusion.amt)) c.confusion = { amt: cx };
      }
      continue;
    }
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

  /* sniperV2: items-sum as a synthetic subtotal — corroborates a candidate
     total even when the receipt prints no labeled "Subtotal" line (common
     on simple/handwritten stalls). Never computed (or trusted) off. */
  const itemsSum = sniperV2 ? candidateItemsSum(lines) : null;
  const itemsAgree = v => itemsSum !== null && v !== null && close(r2(itemsSum + (c.tax || 0) + (c.svc || 0) + c.rounding), v, 0.05);

  /* conf: 3 = arithmetic-confirmed by two independent sources,
     2 = strong single source, 1 = lone printed line, 0 = guesswork. */
  if (close(cc, kt, 0.06)) return { value: kt, conf: 3 };
  if (roundConfirmed) return { value: c.plain, conf: 3 };
  if (close(st, kt, 0.02) && kt !== null) return { value: kt, conf: 3 };
  if (sniperV2 && itemsAgree(kt)) return { value: kt, conf: 3 };
  /* The "total" line the parser found is just the subtotal echoed (GST
     summary rows do this) — the real total is subtotal + tax. */
  if (st !== null && kt !== null && c.sub !== null && Math.abs(kt - c.sub) < 0.01) return { value: st, conf: 2 };
  /* Two independent printed total lines agreeing beat a cash/change pair
     that might itself be misread. */
  if (c.boosted !== null && c.plain !== null && Math.abs(c.boosted - c.plain) <= 0.015) return { value: kt, conf: 2 };
  if (close(st, cc, 0.06)) return { value: cc, conf: 2 };
  /* sniperV2: a confusion-table candidate is only ever trusted here — it
     needs a second signal (subtotal+tax, items-sum, or cash/change) to be
     accepted at all (see the section comment: a lone "fix" is worse than
     staying weak). */
  if (sniperV2 && c.confusion !== null &&
      (close(st, c.confusion.amt, 0.02) || itemsAgree(c.confusion.amt) || close(cc, c.confusion.amt, 0.06))) {
    return { value: c.confusion.amt, conf: 2 };
  }
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

/* Async only for sniperV2's DB-setting lookup when the caller doesn't pass
   it explicitly (scanReceipt resolves it once and passes it through) — the
   text-eating contract itself (string in, parsed fields out) is unchanged;
   see the sniperV2 param, invariant #3. */
async function parseReceiptText(text, sniperV2) {
  if (sniperV2 === undefined) sniperV2 = await sniperV2Enabled();
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 1);
  const joined = lines.join("\n");
  const tt = extractTotal(lines, cashChangeTotal(lines), sniperV2);
  let total = tt.value;
  let totalConf = total !== null ? tt.conf : 0;
  const date = extractDate(lines, joined);
  const time = extractTime(joined);
  const merchant = guessMerchant(lines, sniperV2);
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

function amountFromLine(line) {
  const a = totalLineAmounts(line, 12);
  return a.length ? Math.max(...a) : null;
}

/* ---------- Card-slip guard (OCR-ENGINE-PLAN.md Phase 9) ----------

   Detects text that looks like a payment card slip or terminal receipt
   (an unmasked card number, or the printed labels a card terminal uses),
   so the app can refuse to send it to the cloud reader, keep no photo of
   it, and not learn from it. Two independent signals, either is enough:

   PRIMARY: an unmasked, CARD-GROUPED 13-19-digit run that passes the Luhn
   checksum. "Card-grouped" is deliberately narrower than "any digit run":
   an earlier version matched any 13-19 digit sequence with spaces/dashes
   stripped, benched against my100+sroie200 (300 real Malaysian receipts,
   cached raw OCR text), and found 23 real false positives — every one of
   them EAN-13 barcodes, GST/invoice reference numbers, or (the case that
   forced this redesign) a "Shell Loyalty Card" number printed as one bare
   16-digit block that happens to satisfy Luhn (loyalty/membership schemes
   commonly use Luhn deliberately too — it's a generic check-digit
   algorithm, not exclusive to payment cards). A real card slip prints the
   number in one of a handful of universal POS/EDC groupings (4-4-4-N,
   Amex's 4-6-5, or the older 4-4-5) — a bare ungrouped block, the exact
   shape that produced every false positive here, is now REQUIRED to also
   carry a SECONDARY keyword hit to trigger (see below) rather than
   tripping PRIMARY on Luhn alone. Re-benched at 0/300 after this change.
   A masked number (****1234, XXXX-XXXX-XXXX-1234) never forms a matching
   run at all — the mask characters break any grouping — so masking
   correctly, and automatically, defeats PRIMARY without special-case code.

   SECONDARY (for a real card number the OCR garbled past Luhn or grouping,
   an ungrouped-but-real card number, or a masked slip PRIMARY can never
   see the number on): 2+ of the printed labels a card-terminal receipt
   actually carries — CARDHOLDER, MERCHANT/CUSTOMER COPY, APPR(OVAL) CODE,
   SIGNATURE, MID/TID (merchant/terminal id). One alone is too common a
   false-positive risk (e.g. a receipt that happens to say "signature" for
   an unrelated reason); two together are specific enough to real
   card-terminal printouts. */
const CARD_GROUPED_RE = /(?<!\d)(\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{5}|\d{4}[ -]\d{4}[ -]\d{5})(?!\d)/g;
const CARD_BARE_RUN_RE = /(?<!\d)(\d{13,19})(?!\d)/g;
const CARD_SLIP_KEYWORD_RES = [
  /\bcard\s*holder\b/i,
  /\b(merchant|customer)\s*copy\b/i,
  /\bappr(?:oval)?\.?\s*code\b/i,
  /\bsignature\b/i,
  /\b(mid|tid)\b/i
];
function luhnValid(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
function looksLikeCardSlip(rawText) {
  const text = String(rawText || "");
  if (!text) return false;
  let groupedLuhn = false;
  for (const m of text.matchAll(CARD_GROUPED_RE)) {
    const digits = m[1].replace(/[ \-]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) { groupedLuhn = true; break; }
  }
  if (groupedLuhn) return true;
  let bareLuhn = false;
  for (const m of text.matchAll(CARD_BARE_RUN_RE)) {
    if (luhnValid(m[1])) { bareLuhn = true; break; }
  }
  let hits = 0;
  for (const re of CARD_SLIP_KEYWORD_RES) { if (re.test(text)) hits++; }
  if (bareLuhn && hits >= 1) return true;   /* ungrouped block alone isn't enough (loyalty/membership cards use Luhn too) -- needs at least one corroborating label */
  return hits >= 2;
}

/* Bench-sweep hooks (harmless in prod): force the prepV2 master on/off and
   toggle individual sub-steps without touching the DB flag, so score.js can
   sweep combos in one session. `master`: true/false forces, "db"/null reverts
   to the `prepV2` setting. */
function setPrep(o) {
  o = o || {};
  if ("master" in o) prepMasterOverride = (o.master === "db" || o.master === null) ? null : !!o.master;
  for (const key of ["flatten", "deskew", "sauvola", "border"]) {
    if (key in o) PREP_CONFIG[key] = !!o[key];
  }
  return getPrep();
}
function getPrep() {
  return { master: prepMasterOverride, config: { ...PREP_CONFIG } };
}

window.ReceiptOCR = { ocrImage, scanReceipt, warmUp, parseReceiptText, guessCategory, amountFromLine, CATEGORIES, setPrep, getPrep, setSniper, getSniper, setNative, getNative, looksLikeCardSlip };
