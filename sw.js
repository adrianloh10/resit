importScripts("version.js");
const CACHE = "resit-" + self.RESIT_VERSION;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./version.js",
  "./app.js",
  "./db.js",
  "./ocr.js",
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
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  /* Same-origin: cache-first from THIS release's precache. Updates arrive
     atomically when a new SW version installs (its precache is complete
     before activation), so the app can never run mixed old/new files. */
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    })());
    return;
  }

  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }))
    );
  }
});
