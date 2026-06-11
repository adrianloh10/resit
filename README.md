# Resit — receipt expense tracker

Snap a photo of a receipt, the app reads it on-device (OCR via Tesseract.js) and logs the expense. All data stays on the phone in IndexedDB — no server, no account, no upload.

## Features
- Snap with camera, upload a photo, or enter manually
- Auto-extracts total, merchant, date/time, line items
- Auto-suggests category (knows Malaysian merchants: 99 Speedmart, Petronas, Tesco/Lotus's, mamak, TNG, etc.)
- Monthly ledger with budget bar, insights tab with category breakdown and top places
- Tap any expense to edit or delete
- CSV export and monthly budget in settings (insights tab → Settings)
- Installable PWA, works offline after first load (OCR engine downloads once, then is cached)

## Run locally
Any static file server, e.g.:

```
python -m http.server 8902 --directory resit
```

## Publish (needed for phone install)
PWAs require HTTPS. Host the `resit/` folder anywhere static, e.g. GitHub Pages, Netlify, Cloudflare Pages, or Railway (static).

## Install on phone
1. Open the published URL in Chrome (Android) or Safari (iPhone)
2. Android: menu ⋮ → "Add to Home screen" / "Install app"
3. iPhone: Share → "Add to Home Screen"

## Updating the app
After changing any file, bump the cache version in `sw.js` (`resit-v1` → `resit-v2`) so installed phones pick up the new version.
