importScripts("version.js");
const CACHE = "resit-" + self.RESIT_VERSION;
/* Version-INDEPENDENT cache for the heavy tesseract.js core-wasm + eng.train-
   eddata blobs under vendor/ (~28MB, invariant #1). Its name does NOT derive
   from RESIT_VERSION, and activate() (below) never deletes it, so these
   blobs are fetched once ever and survive every future release — bump the
   "-v1" suffix only if the vendored binaries themselves change (new
   tesseract.js version, different traineddata). */
const VENDOR_CACHE = "resit-vendor-heavy-v1";
/* tesseract.js resolves corePath/langPath against VENDOR_BASE (see ocr.js),
   so every heavy asset it fetches lands under vendor/ as either a
   "tesseract-core*.wasm.js" variant or "eng.traineddata.gz" — matches
   everything in vendor/ except the two small entry points below, which stay
   in the versioned SHELL like any other app file. */
function isHeavyVendorAsset(url) {
  return /\/vendor\/(tesseract-core|eng\.traineddata)/.test(url.pathname);
}
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./version.js",
  "./app.js",
  "./db.js",
  "./ocr.js",
  /* Self-hosted OCR engine entry points (small) — versioned like any other
     app file. The heavy vendor/ assets go through VENDOR_CACHE instead (see
     above), never through this precache. */
  "./vendor/tesseract.min.js",
  "./vendor/worker.min.js",
  "./eula.html",
  "./privacy.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", e => {
  /* cache: "reload" bypasses the HTTP cache so the precached set is truly
     the newest release — and addAll is all-or-nothing, so the app shell is
     always a consistent single version (no mixed old/new files). */
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  /* Keep VENDOR_CACHE alongside the current release's CACHE — deleting it
     here would force a ~28MB re-download on every single release, exactly
     what invariant #1 exists to prevent. */
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  /* Same-origin: cache-first, split across two caches. Everything except the
     heavy vendor/ assets comes from THIS release's precache (CACHE) — updates
     arrive atomically when a new SW version installs (its precache is
     complete before activation), so the app can never run mixed old/new
     files. The heavy vendor/ assets come from VENDOR_CACHE instead, so they
     are fetched lazily on first use and never re-fetched on a version bump. */
  if (url.origin === location.origin) {
    e.respondWith(cacheFirst(e.request, isHeavyVendorAsset(url) ? VENDOR_CACHE : CACHE));
    return;
  }
});
