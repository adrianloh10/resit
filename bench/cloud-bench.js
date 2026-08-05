/* Resit GEMINI REFERENCE ROW bench (OCR-ENGINE-PLAN.md Phase 4, step 4b — north star).

   NOT loaded by index.html — a testing tool only, evaluated the same way as
   score.js: fetch this file's text, eval the WHOLE thing in the running app
   page, then drive it from the console via window.CloudBench. Depends on
   globals the app page already defines (cloudRead, state, window.OcrBench's
   truth-parsing/matching helpers from score.js) — run the fresh-code ritual
   and load score.js FIRST.

   Sends my100 through the REAL production cloud path (cloudRead(), the exact
   function app.js's own scan flow calls) so the measurement reflects what a
   user's phone actually gets back, not a reimplementation. Throttled to
   respect Gemini's 15/min rate limit (~10/min target incl. request latency)
   and to stay a trivial fraction of the shared free daily quota. Each request
   uses a distinct synthetic deviceId (gemini-refrow-<id>) so this bench run
   cannot trip the Worker's per-device daily cap (default 20/day) or count
   against any real user's quota.

   Workflow (matches score.js's detached/polled pattern — a full run takes
   ~10+ minutes at the throttled rate, the eval tool's ~30s cap can't await it
   inline):
     1. CloudBench.startBench()          // returns immediately
     2. CloudBench.progress()            // poll this every so often
     3. once status is 'done':
        CloudBench.summary()             // {n, totalExact, merchantMatch, dateMatch, medianLatencyMs, rows}
        CloudBench.getCsv()              // per-receipt CSV string */
(function () {
  const IDS = Array.from({ length: 100 }, (_, i) => String(i).padStart(3, "0"));
  const BASE = "/test-receipts/my/";

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

  window.__cloudBenchJob = window.__cloudBenchJob || null;

  function startBench(opts) {
    opts = opts || {};
    if (window.__cloudBenchJob && window.__cloudBenchJob.status === "running") {
      return { status: "already-running" };
    }
    /* Spacing between request STARTS = provider latency + this sleep. ~5.5s
       sleep + ~1.5-2.5s typical Gemini flash-lite latency lands near 8s/req
       (~7.5/min) -- comfortably under the plan's ~10/min target and the
       provider's 15/min hard cap, never right at either edge. */
    const intervalMs = opts.intervalMs || 5500;
    const ids = opts.ids || IDS;
    const job = { status: "running", total: ids.length, scanned: 0, rows: [], errors: [], startedAt: Date.now(), finishedAt: null };
    window.__cloudBenchJob = job;
    const savedDeviceId = state.deviceId;

    (async () => {
      for (const id of ids) {
        const t0 = Date.now();
        try {
          const blob = await fetchBlob(BASE + id + ".jpg");
          const truth = await fetchJson(BASE + id + ".json");
          /* Restore immediately after the call, not just once at job end —
             state.deviceId used to sit at this synthetic value for the
             ENTIRE ~5.5s inter-request sleep too, not just the cloudRead()
             call itself, so a real scan performed in the same tab while a
             multi-minute bench job was still running could get its own
             quota/license check misattributed to this fake id. */
          let ai;
          state.deviceId = "gemini-refrow-" + id;
          try { ai = await cloudRead(blob); } finally { state.deviceId = savedDeviceId; }
          const latencyMs = Date.now() - t0;

          const truthYmd = window.OcrBench.parseTruthDate(truth.date);
          const truthTotal = window.OcrBench.parseTruthTotal(truth.total);
          const tb = window.OcrBench.totalBand(ai && typeof ai.total === "number" ? ai.total : null, truthTotal);
          /* Local-midnight parse, matching score.js's fmtLocalDate discipline --
             never .toISOString(), which would shift the calendar date in a
             positive-UTC-offset zone (Malaysia included). */
          const guessDate = ai && ai.date ? new Date(ai.date + "T00:00:00") : null;
          const dOk = window.OcrBench.dateMatches(guessDate, truthYmd);
          const mOk = window.OcrBench.fuzzyMerchantMatch(ai && ai.merchant, truth.company);

          job.rows.push({
            id, latencyMs, readable: ai ? ai.readable !== false : false,
            totalGuess: ai && typeof ai.total === "number" ? ai.total : null, totalTruth: truthTotal,
            totalExact: tb.exact, totalWithin5: tb.within5, totalWithin10: tb.within10,
            merchantGuess: (ai && ai.merchant) || "", merchantTruth: truth.company, merchantMatch: mOk,
            dateGuess: (ai && ai.date) || "", dateTruth: truth.date, dateMatch: dOk,
            error: ""
          });
        } catch (e) {
          const msg = String((e && e.message) || e);
          job.errors.push({ id, error: msg });
          job.rows.push({
            id, latencyMs: Date.now() - t0, readable: false,
            totalGuess: null, totalTruth: NaN, totalExact: false, totalWithin5: false, totalWithin10: false,
            merchantGuess: "", merchantTruth: "", merchantMatch: false,
            dateGuess: "", dateTruth: "", dateMatch: false, error: msg
          });
        }
        job.scanned++;
        if (job.scanned < ids.length) await new Promise(r => setTimeout(r, intervalMs));
      }
      state.deviceId = savedDeviceId;
      job.status = "done";
      job.finishedAt = Date.now();
    })().catch(e => {
      job.status = "error"; job.error = String((e && e.message) || e);
      state.deviceId = savedDeviceId;
    });

    return { status: "started", total: ids.length, intervalMs };
  }

  function progress() {
    const job = window.__cloudBenchJob;
    if (!job) return { status: "idle" };
    return {
      status: job.status, total: job.total, scanned: job.scanned,
      errorCount: job.errors.length, elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
      error: job.error
    };
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  function summary() {
    const job = window.__cloudBenchJob;
    if (!job) throw new Error("no bench job -- call startBench() and wait for status 'done' first");
    const rows = job.rows;
    const n = rows.length;
    const count = k => rows.filter(r => r[k]).length;
    const lat = rows.filter(r => !r.error).map(r => r.latencyMs);
    return {
      n, errorCount: job.errors.length,
      totalExact: count("totalExact"), totalWithin5: count("totalWithin5"), totalWithin10: count("totalWithin10"),
      merchantMatch: count("merchantMatch"), dateMatch: count("dateMatch"),
      medianLatencyMs: median(lat), minLatencyMs: lat.length ? Math.min(...lat) : null, maxLatencyMs: lat.length ? Math.max(...lat) : null
    };
  }

  function toCsvField(v) {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function getCsv() {
    const job = window.__cloudBenchJob;
    if (!job) throw new Error("no bench job yet");
    const header = ["id", "totalTruth", "totalGuess", "totalExact", "totalWithin5", "totalWithin10",
      "merchantTruth", "merchantGuess", "merchantMatch", "dateTruth", "dateGuess", "dateMatch", "latencyMs", "error"];
    const lines = [header.join(",")];
    for (const r of job.rows) lines.push(header.map(h => toCsvField(r[h])).join(","));
    return lines.join("\n");
  }

  window.CloudBench = { startBench, progress, summary, getCsv };
})();
"cloud-bench loaded";
