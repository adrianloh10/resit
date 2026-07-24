# recap-mlkit-ocr

Minimal in-house Capacitor plugin for the **Recap** app. One method,
`recognize()`, that runs **Google ML Kit Text Recognition v2** on-device and
returns the recognised lines + bounding boxes. All receipt parsing (merchant /
date / total, digit-sniper cross-validation) stays in `resit/ocr.js` — this
plugin only turns pixels into text + geometry.

Built for **OCR-ENGINE-PLAN.md Phase 3a**.

## Why unbundled

ML Kit is pulled in via **Google Play services** —
`com.google.android.gms:play-services-mlkit-text-recognition` (~+260 KB). The
OCR model is downloaded by Play services on demand (the plugin's
`AndroidManifest.xml` declares the `ocr` dependency so it fetches at install
time). We deliberately do **not** use the bundled `com.google.mlkit:text-recognition`
artifact (~4 MB in the APK).

## How it's wired (no android/ edits — that folder is generated per cloud build)

1. `resit/package.json` lists it as a local dependency:
   `"recap-mlkit-ocr": "file:./recap-mlkit-ocr"`.
2. Codemagic runs `npm install` → `npx cap add android` → `npx cap sync android`.
   Capacitor discovers this package (it has a `capacitor` field), includes the
   `android/` library as a Gradle subproject, and auto-registers the
   `@CapacitorPlugin(name = "RecapMlkitOcr")` class in `capacitor.plugins.json`.
3. At runtime the app reads the native bridge's own auto-populated
   `window.Capacitor.Plugins.RecapMlkitOcr` directly (see `getMlkitPlugin()` in
   `resit/ocr.js`) — no bundler, matching the no-build PWA.
   `window.Capacitor.registerPlugin(...)` (a `@capacitor/core` JS-bundle
   wrapper) is NOT used here — this app never loads that bundle (confirmed
   live during the Phase 3b device bench: it isn't a function on a real
   device even though the plugin registers fine natively).

The plugin is **native-only**: on the web `window.Capacitor` is undefined, so
the whole native path in `ocr.js` is inert and the PWA runs Tesseract exactly
as before (the Phase 3a web-inert gate).

## API

```ts
recognize({ image: string /* base64, optional data-URL prefix */ }):
  Promise<{
    width: number; height: number;
    lines: Array<{
      text: string;
      frame: { left; top; right; bottom };  // source-image pixels
      confidence?: number;                   // omitted if ML Kit reports none
      elements: Array<{ text; frame }>;      // word-level boxes
    }>;
  }>
```

## Flag

Gated behind the `nativeOcr` setting (default **OFF**, dark-shipped). Phase 3b
benches it on a real device; Phase 4 flips the default on with the rest of
Reader v2 Part 1.

## Phase 3b verification notes

- **EXIF orientation.** ML Kit reads the decoded bitmap at rotation 0; the JS
  side's `loadCanvas()` decodes via `<img>`, which applies EXIF orientation in
  the WebView. For an EXIF-rotated photo the two coordinate spaces disagree, so
  the digit-sniper's re-crop lands off. This is *harmless* (the sniper is
  conservative — a wrong crop yields no consensus, never a wrong total; it only
  disables the native rescue on those photos), but on-device confirm whether
  Capacitor Camera already normalises orientation. If not, pass the EXIF
  rotation to `InputImage.fromBitmap(bmp, rotation)` and map boxes into display
  space. (`ocr.js` `scanReceiptNative` carries the same note.)
- **Model download.** First scan may briefly wait if Play services hasn't
  finished fetching the `ocr` model (the manifest `DEPENDENCIES` meta-data asks
  for it at install time). The native path returns null / rejects until then, so
  it falls back to Tesseract cleanly.
