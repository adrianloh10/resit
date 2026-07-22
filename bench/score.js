/* Resit OCR bench scorer — hardened, reusable (OCR-ENGINE-PLAN.md Phase 0).

   NOT loaded by index.html — a testing tool only, evaluated the same way
   as .claude/skills/run-resit/smoke.js: fetch this file's text, eval the
   WHOLE thing in the running app page, then drive it from the console via
   window.OcrBench. Depends on globals the app page already defines
   (state, SEED_RULES, parseReceiptText, applyLearnedTotalHint, brandOf,
   normMerchant, window.ReceiptOCR) — run the fresh-code ritual first.

   Two bench sets:
     my100    -> /test-receipts/my/000..099        (SEED_RULES was mined
                 from these — this is the "tuned-against" set)
     sroie200 -> /test-receipts/sroie200/100..299   (fixed forever, built by
                 automation/bench/ingest-sroie.py — measures generalization)

   Workflow (a full scan takes minutes; the browser-tool eval has a hard
   ~30s cap, so scanning runs detached and is polled, never awaited inline):
     1. await OcrBench.startScan('my100')         // returns immediately
     2. OcrBench.progress('my100')                // poll this every so often
     3. once status is 'done' or 'cached':
        await OcrBench.runAll('my100')            // {summary, ...} compact
        OcrBench.getCsv('my100')                  // per-receipt CSV string
     4. repeat for 'sroie200'

   Cold vs seeded (matches the 07-20 ocr-weekly.md method exactly, so this
   baseline is comparable to it): both passes re-parse the SAME cached raw
   OCR text — cold = parseReceiptText(text) only; seeded = + applyLearned-
   TotalHint(parsed), with state.totalHints/merchantNames/merchantCats
   forced to {} for the duration (isolates the SEED_RULES effect on an
   otherwise-empty profile, then restores whatever was there). Because the
   cache stores TEXT (not pixels), a sniper rescue that only a pixel crop
   could find isn't reproduced by the cached-text re-parse — same known
   limitation the 07-20 row's numbers already carry, so reproducing them
   depends on replicating it, not "fixing" it. The actual scanReceipt()
   total (pixels and all) is captured too, as the separate liveTotal/
   liveTotalConf CSV columns, for diagnostic use — never the headline gate
   metric. */
(function () {
  const SETS = {
    my100: {
      base: "/test-receipts/my/",
      manifestUrl: null,
      staticIds: Array.from({ length: 100 }, (_, i) => String(i).padStart(3, "0"))
    },
    sroie200: {
      base: "/test-receipts/sroie200/",
      manifestUrl: "/test-receipts/sroie200/manifest.json",
      staticIds: null
    }
  };

  /* ---------- Truth-date parsing (LOCAL midnight, no UTC anywhere) ---------- */

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function validYMD(y, mo, d) {
    return y >= 2000 && y <= 2030 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  }
  /* A handful of SROIE truth rows are US-style MDY (month > 12 gives it
     away) — swap back to DMY when that's the only way the triple is valid. */
  function fixMoD(y, mo, d) {
    if (mo > 12 && d <= 12) return [y, d, mo];
    return [y, mo, d];
  }

  /* Handles every date format actually present in bench-sroie/raw/key/*.json
     (validated against all 626 files — zero unparsed): ISO Y-M-D, an
     8-digit run (tried as YYYYMMDD then DDMMYYYY), "D MON (YY|YYYY)",
     "MON D, YYYY", D/M/YYYY and D/M/YY with /,-,. separators, plus the
     odd US-style MDY outlier. */
  function parseTruthDate(raw) {
    const s = String(raw || "").trim().replace(/^\(|\)$/g, "").trim();
    let m;

    if ((m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/.exec(s))) {
      const y = +m[1], mo = +m[2], d = +m[3];
      const [fy, fmo, fd] = fixMoD(y, mo, d);
      if (validYMD(fy, fmo, fd)) return { y: fy, mo: fmo, d: fd };
    }
    if ((m = /^(\d{8})$/.exec(s))) {
      const digits = m[1];
      let y = +digits.slice(0, 4), mo = +digits.slice(4, 6), d = +digits.slice(6, 8);
      if (validYMD(y, mo, d)) return { y, mo, d };
      const d2 = +digits.slice(0, 2), mo2 = +digits.slice(2, 4), y2 = +digits.slice(4, 8);
      const [fy, fmo, fd] = fixMoD(y2, mo2, d2);
      if (validYMD(fy, fmo, fd)) return { y: fy, mo: fmo, d: fd };
    }
    if ((m = /^(\d{1,2})[\s\-\/]+([A-Za-z]{3,9})[\s\-\/]*,?\s*(\d{2,4})$/.exec(s))) {
      const d = +m[1];
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      let y = +m[3];
      if (y < 100) y = y < 70 ? 2000 + y : 1900 + y;
      if (mo && validYMD(y, mo, d)) return { y, mo, d };
    }
    if ((m = /^([A-Za-z]{3,9})[\s]+(\d{1,2}),?\s*(\d{4})$/.exec(s))) {
      const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
      const d = +m[2], y = +m[3];
      if (mo && validYMD(y, mo, d)) return { y, mo, d };
    }
    if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s))) {
      const d = +m[1], mo = +m[2], y = +m[3];
      const [fy, fmo, fd] = fixMoD(y, mo, d);
      if (validYMD(fy, fmo, fd)) return { y: fy, mo: fmo, d: fd };
    }
    if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/.exec(s))) {
      const d = +m[1], mo = +m[2], y2 = +m[3];
      const y = y2 < 70 ? 2000 + y2 : 1900 + y2;
      const [fy, fmo, fd] = fixMoD(y, mo, d);
      if (validYMD(fy, fmo, fd)) return { y: fy, mo: fmo, d: fd };
    }
    return null;
  }

  function dateMatches(guessDate, truthYmd) {
    if (!guessDate || !truthYmd) return false;
    return guessDate.getFullYear() === truthYmd.y &&
      guessDate.getMonth() === truthYmd.mo - 1 &&
      guessDate.getDate() === truthYmd.d;
  }
  /* Local-component formatting ONLY — .toISOString() converts to UTC and
     would silently shift the displayed calendar date by a day in any
     positive-UTC-offset zone (Malaysia included). This is the exact class
     of bug the 07-20 row's scorer fix was about; never reintroduce it. */
  function fmtLocalDate(d) {
    if (!d) return "";
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtTruthYmd(ymd) {
    if (!ymd) return "";
    return ymd.y + "-" + String(ymd.mo).padStart(2, "0") + "-" + String(ymd.d).padStart(2, "0");
  }

  /* ---------- Totals: exact + tolerance bands ---------- */

  /* Truth totals are usually plain "9.00" but ~89 of the 626 raw SROIE
     truth files (a whole merchant cluster plus scattered others) prefix
     the amount with "$" or "RM" (with/without a space, with/without a
     thousands comma) — parseFloat on those returns NaN and silently drops
     every one of those receipts from the total-match count. Strip
     anything that isn't a digit, dot, or leading minus before parsing. */
  function parseTruthTotal(raw) {
    const s = String(raw || "").trim();
    if (!s) return NaN;
    return parseFloat(s.replace(/[^\d.\-]/g, ""));
  }

  function totalBand(guess, truthNum) {
    if (guess === null || guess === undefined || !isFinite(truthNum)) {
      return { exact: false, within5: false, within10: false };
    }
    const diff = Math.abs(guess - truthNum);
    return { exact: diff < 0.005, within5: diff <= 0.0501, within10: diff <= 0.1001 };
  }

  /* ---------- Merchant: fuzzy match ---------- */

  const LEGAL_SUFFIX_RE = /\b(sdn\.?\s*bhd\.?|s\/b|berhad|bhd|enterprise|trading|holdings?|corporation|corp|company|co\.?|ltd\.?|inc\.?)\b/gi;
  function normForMatch(s) {
    return String(s || "")
      .toLowerCase()
      .replace(LEGAL_SUFFIX_RE, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function fuzzyMerchantMatch(guess, truth) {
    const g = normForMatch(guess), t = normForMatch(truth);
    if (!g || !t) return false;
    if (g === t) return true;
    if (g.length >= 4 && t.includes(g)) return true;
    if (t.length >= 4 && g.includes(t)) return true;
    const gTokens = new Set(g.split(" ").filter(w => w.length >= 4));
    const tTokens = t.split(" ").filter(w => w.length >= 4);
    return tTokens.some(w => gTokens.has(w));
  }

  /* ---------- Fetch helpers ---------- */

  async function fetchBlob(url) {
    const res = await fetch(url, { cache: "reload" });
    if (!res.ok) throw new Error("fetch failed " + url + " " + res.status);
    return await res.blob();
  }
  async function fetchJson(url) {
    const res = await fetch(url, { cache: "reload" });
    if (!res.ok) throw new Error("fetch failed " + url + " " + res.status);
    return await res.json();
  }
  async function loadSet(setKey) {
    const def = SETS[setKey];
    if (!def) throw new Error("unknown set " + setKey);
    let ids = def.staticIds;
    if (!ids) {
      const manifest = await fetchJson(def.manifestUrl);
      ids = manifest.ids;
    }
    return { base: def.base, ids };
  }

  /* ---------- localStorage raw-text cache ---------- */

  function cacheKey(setKey) { return "resit_bench_raw_" + setKey; }
  function readCache(setKey) {
    try {
      const raw = localStorage.getItem(cacheKey(setKey));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeCache(setKey, data) {
    localStorage.setItem(cacheKey(setKey), JSON.stringify(data));
  }

  /* ---------- Slow-path scan: detached, polled (never awaited inline —
     a full scan can take many minutes, the eval tool cannot). ---------- */

  window.__ocrBenchJobs = window.__ocrBenchJobs || {};

  async function startScan(setKey, opts) {
    opts = opts || {};
    const { base, ids } = await loadSet(setKey);

    if (!opts.force) {
      const cached = readCache(setKey);
      if (cached && cached.texts && Object.keys(cached.texts).length === ids.length) {
        window.__ocrBenchJobs[setKey] = { status: "cached", setKey, total: ids.length, scanned: ids.length, errors: [], startedAt: Date.now(), finishedAt: Date.now() };
        return { status: "cached", total: ids.length, savedAt: cached.savedAt };
      }
    }

    const job = { status: "running", setKey, total: ids.length, scanned: 0, errors: [], startedAt: Date.now(), finishedAt: null };
    window.__ocrBenchJobs[setKey] = job;

    (async () => {
      const texts = {};
      const liveTotals = {};
      for (const id of ids) {
        try {
          const blob = await fetchBlob(base + id + ".jpg");
          const parsed = await window.ReceiptOCR.scanReceipt(blob, () => {});
          texts[id] = parsed.rawText || "";
          liveTotals[id] = { total: parsed.total, totalConf: parsed.totalConf || 0 };
        } catch (e) {
          job.errors.push({ id, error: String((e && e.message) || e) });
          texts[id] = "";
          liveTotals[id] = { total: null, totalConf: 0 };
        }
        job.scanned++;
      }
      writeCache(setKey, { savedAt: Date.now(), texts, liveTotals });
      job.status = "done";
      job.finishedAt = Date.now();
    })().catch(e => { job.status = "error"; job.error = String((e && e.message) || e); });

    return { status: "started", total: ids.length };
  }

  function progress(setKey) {
    const job = window.__ocrBenchJobs[setKey];
    if (!job) return { status: "idle" };
    const elapsedMs = (job.finishedAt || Date.now()) - job.startedAt;
    return { status: job.status, total: job.total, scanned: job.scanned, errorCount: (job.errors || []).length, elapsedMs, error: job.error };
  }

  /* ---------- Scoring (fast path: re-parses cached raw text only) ---------- */

  /* One id's worth of scoring. Isolated in its own try/catch (mirroring
     startScan's per-id isolation) so a single flaky truth-JSON fetch can't
     throw out of the whole pass and discard every other receipt's already-
     computed row — that used to kill the entire runAll() (including a
     cold pass that had already fully succeeded) over one transient 404/500. */
  async function scoreOne(id, base, cached, mode) {
    try {
      const rawText = cached.texts[id] || "";
      const truth = await fetchJson(base + id + ".json");
      const truthYmd = parseTruthDate(truth.date);
      const truthTotal = parseTruthTotal(truth.total);

      const parsed = parseReceiptText(rawText);
      let merchantGuess = parsed.merchant || "";
      if (mode === "seeded") {
        applyLearnedTotalHint(parsed);
        const brand = brandOf(normMerchant(parsed.merchant || ""));
        merchantGuess = state.merchantNames[brand] || SEED_RULES.names[brand] || parsed.merchant || "";
      }

      const weak = parsed.total === null || (parsed.totalConf || 0) <= 1;
      const tb = totalBand(parsed.total, truthTotal);
      const dOk = dateMatches(parsed.date, truthYmd);
      const mOk = fuzzyMerchantMatch(merchantGuess, truth.company);
      const live = (cached.liveTotals && cached.liveTotals[id]) || {};

      return {
        id, mode,
        totalGuess: parsed.total, totalTruth: truthTotal,
        totalExact: tb.exact, totalWithin5: tb.within5, totalWithin10: tb.within10,
        dateGuess: fmtLocalDate(parsed.date), dateTruth: fmtTruthYmd(truthYmd), dateMatch: dOk,
        merchantGuess, merchantTruth: truth.company, merchantMatch: mOk,
        weak, totalConf: parsed.totalConf || 0,
        liveTotal: live.total === undefined ? null : live.total, liveTotalConf: live.totalConf || 0
      };
    } catch (e) {
      return {
        id, mode, error: String((e && e.message) || e),
        totalGuess: null, totalTruth: NaN, totalExact: false, totalWithin5: false, totalWithin10: false,
        dateGuess: "", dateTruth: "", dateMatch: false,
        merchantGuess: "", merchantTruth: "", merchantMatch: false,
        weak: true, totalConf: 0, liveTotal: null, liveTotalConf: 0
      };
    }
  }

  function summarize(setKey, mode, rows) {
    const n = rows.length;
    const count = key => rows.filter(r => r[key]).length;
    const weakCount = count("weak");
    return {
      setKey, mode, n,
      totalExact: count("totalExact"), totalWithin5: count("totalWithin5"), totalWithin10: count("totalWithin10"),
      dateMatch: count("dateMatch"), merchantMatch: count("merchantMatch"),
      weakCount, weakPct: n ? Math.round((weakCount / n) * 1000) / 10 : null,
      errorCount: rows.filter(r => r.error).length,
      rows
    };
  }

  /* Cold needs no shared-state isolation — runs freely, any number in flight. */
  async function scoreCold(setKey, cached, base, ids) {
    const rows = [];
    for (const id of ids) rows.push(await scoreOne(id, base, cached, "cold"));
    return summarize(setKey, "cold", rows);
  }

  /* Seeded temporarily clears state.totalHints/merchantNames/merchantCats to
     isolate the SEED_RULES-only effect, then restores whatever was really
     there. That mutates a single shared global, so two seeded passes MUST
     NOT overlap (a second one starting before the first's restore would
     snapshot the first's empty scratch objects instead of the real
     profile, and could leave state permanently pointing at {} — which
     production code then persists to IndexedDB on the next save). Chain
     every seeded pass through one lock so they always run one at a time,
     regardless of how many runAll()/scorePass() calls are in flight. */
  window.__ocrBenchSeedLock = window.__ocrBenchSeedLock || Promise.resolve();

  async function scoreSeeded(setKey, cached, base, ids) {
    const run = window.__ocrBenchSeedLock.then(async () => {
      const snapshot = { totalHints: state.totalHints, merchantNames: state.merchantNames, merchantCats: state.merchantCats };
      state.totalHints = {}; state.merchantNames = {}; state.merchantCats = {};
      try {
        const rows = [];
        for (const id of ids) rows.push(await scoreOne(id, base, cached, "seeded"));
        return summarize(setKey, "seeded", rows);
      } finally {
        Object.assign(state, snapshot);
      }
    });
    /* Never let one failed seeded pass wedge the lock for the next caller. */
    window.__ocrBenchSeedLock = run.then(() => {}, () => {});
    return await run;
  }

  async function scorePass(setKey, mode) {
    const cached = readCache(setKey);
    if (!cached) throw new Error("no cache for " + setKey + " — call startScan() and wait for status 'done'/'cached' first");
    const { base, ids } = await loadSet(setKey);
    return mode === "seeded" ? scoreSeeded(setKey, cached, base, ids) : scoreCold(setKey, cached, base, ids);
  }

  /* ---------- CSV dump (per-receipt, both passes side by side — diffable run to run) ---------- */

  function toCsvField(v) {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(coldResult, seededResult) {
    const header = ["id", "totalTruth", "totalGuessCold", "coldExact", "coldWithin5", "coldWithin10",
      "totalGuessSeeded", "seededExact", "seededWithin5", "seededWithin10",
      "dateTruth", "dateGuess", "dateMatch",
      "merchantTruth", "merchantGuessCold", "coldMerchantMatch", "merchantGuessSeeded", "seededMerchantMatch",
      "weakCold", "weakSeeded", "liveTotal", "liveTotalConf", "coldError", "seededError"];
    const byId = {};
    for (const r of coldResult.rows) byId[r.id] = { cold: r };
    for (const r of seededResult.rows) { byId[r.id] = byId[r.id] || {}; byId[r.id].seeded = r; }
    const lines = [header.join(",")];
    for (const id of Object.keys(byId).sort()) {
      const c = byId[id].cold || {}, s = byId[id].seeded || {};
      lines.push([
        id, c.totalTruth, c.totalGuess, c.totalExact, c.totalWithin5, c.totalWithin10,
        s.totalGuess, s.totalExact, s.totalWithin5, s.totalWithin10,
        c.dateTruth, c.dateGuess, c.dateMatch,
        c.merchantTruth, c.merchantGuess, c.merchantMatch, s.merchantGuess, s.merchantMatch,
        c.weak, s.weak, c.liveTotal, c.liveTotalConf, c.error, s.error
      ].map(toCsvField).join(","));
    }
    return lines.join("\n");
  }

  window.__ocrBenchLast = window.__ocrBenchLast || {};

  async function runAll(setKey) {
    const cold = await scorePass(setKey, "cold");
    const seeded = await scorePass(setKey, "seeded");
    window.__ocrBenchLast[setKey] = { cold, seeded };
    if (cold.dateMatch !== seeded.dateMatch) {
      /* Sanity check: SEED_RULES has no date logic, so this should never fire. */
      console.warn("OcrBench: dateMatch differs between cold/seeded passes for " + setKey + " — investigate.");
    }
    return {
      setKey, n: cold.n,
      totals: { exactSeeded: seeded.totalExact, within5Seeded: seeded.totalWithin5, within10Seeded: seeded.totalWithin10, exactCold: cold.totalExact },
      dates: { match: cold.dateMatch },
      merchants: { matchCold: cold.merchantMatch, matchSeeded: seeded.merchantMatch },
      weak: { seededPct: seeded.weakPct, coldPct: cold.weakPct, seededCount: seeded.weakCount, coldCount: cold.weakCount }
    };
  }

  function getCsv(setKey) {
    const last = window.__ocrBenchLast[setKey];
    if (!last) throw new Error("no scored results for " + setKey + " yet — call runAll() first");
    return toCsv(last.cold, last.seeded);
  }

  window.OcrBench = {
    SETS, startScan, progress, runAll, getCsv, scorePass,
    parseTruthDate, dateMatches, fuzzyMerchantMatch, totalBand, parseTruthTotal, loadSet, readCache
  };
})();
"ocr-bench loaded";
