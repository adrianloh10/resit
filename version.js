/* Single source of truth for the app + cache version. Loaded by index.html
   (window) and imported by sw.js (importScripts), so the running app and the
   service-worker cache name can never drift apart. Bump this ONE line per
   release — sw.js derives its CACHE from it and app.js shows it in Settings. */
self.RESIT_VERSION = "1.11.0";
