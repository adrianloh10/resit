// Canonical Capacitor plugin entry point, for consumers that use a bundler.
//
// NOTE: the Recap app itself is a NO-BUILD, plain-<script> PWA and does NOT
// import this file (registerPlugin() below is a @capacitor/core JS-bundle
// wrapper this app never loads). It instead reads the native bridge's own
// auto-populated `window.Capacitor.Plugins.RecapMlkitOcr` directly (see
// getMlkitPlugin() in resit/ocr.js — confirmed live during the Phase 3b
// device bench that registerPlugin() is not a function in this app).
// This module exists only so the package is a standard, bundler-friendly
// Capacitor plugin for consumers that DO use one.
import { registerPlugin } from '@capacitor/core';

const RecapMlkitOcr = registerPlugin('RecapMlkitOcr');

export { RecapMlkitOcr };
