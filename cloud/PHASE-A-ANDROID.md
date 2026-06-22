# Phase A — getting Resit onto Google Play (Android first)

This wraps the existing Resit web app into a real Android app with **Capacitor**,
built in the cloud (no Mac, no Node on your PC). iOS is Phase B, later.

## What Claude has already built (in the repo)
- `package.json`, `capacitor.config.json` — the Capacitor setup (app id `com.adrianloh.resit`).
- `codemagic.yaml` — the cloud build: copies the web files into `www/`, generates the
  native Android project, and produces an installable **debug APK**.
- Native **camera** capture (with the web file-picker still used on the website).
- A **Google Gemini** disclosure on the cloud-read consent screen (store requirement).
- Worker now allows the native app's origin (`https://localhost`, `capacitor://localhost`).

> Note: the native Android project (`android/`) and `node_modules/` are **not** in the
> repo on purpose — the cloud build generates them fresh each time.

## Your steps (the account / money parts only you can do)

### 1. Start recruiting 12 testers NOW (the slow part)
Google requires **12 people** to install and open the app for **14 continuous days**
before a new personal account can publish. Line up 12 friends/family today.

### 2. Create a Google Play Console account
- Go to play.google.com/console → pay the **one-time US$25** → verify your identity
  (name, address, ID). This is tied to you, so you must do it.

### 3. Build the app in the cloud (Codemagic — free)
- Sign up at codemagic.io with your GitHub.
- Add application → pick **`adrianloh10/resit`** → it detects `codemagic.yaml`.
- Run the **"Resit Android (debug)"** workflow.
- When it finishes, download the **APK** artifact and install it on your Android phone
  (you'll allow "install from unknown source"). This confirms the wrap works end to end.

> The first cloud build sometimes needs a small version tweak — send me the build log if
> it goes red and I'll fix it; we'll iterate like we did with Cloudflare.

### 4. (For the public Play release — after the debug APK works)
- In Codemagic, set up **Android code signing** (it creates/holds your upload key).
  ⚠️ **Back up that keystore safely** — lose it and you can never update the app again.
- Tell me, and I'll switch the workflow from `assembleDebug` to **`bundleRelease`** (a `.aab`).
- In Play Console: create the app, run the **14-day / 12-tester closed test**, fill the
  Data Safety form (I'll give you the text), then promote to production.

## Deferred to later (on purpose)
- **In-app purchase for Pro** (RevenueCat + a Play subscription product) — wire up once the
  account exists; until then the unlock-code path still works for pilot testers.
- **Bundling the OCR engine offline** — only needed for the Apple App Store (Phase B).
- **iOS / Apple** — Phase B (needs the Apple Developer account + the cloud-Mac build).

## How updates work after launch
- Changes to the **web part** (most of your tweaks) can later ship over-the-air without a
  store review (via a live-update plugin we can add).
- Changes to the **native shell** (new plugins, SDK bumps) need a new cloud build + store update.
