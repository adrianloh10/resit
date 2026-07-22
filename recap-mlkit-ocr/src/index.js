// Canonical Capacitor plugin entry point, for consumers that use a bundler.
//
// NOTE: the Recap app itself is a NO-BUILD, plain-<script> PWA and does NOT
// import this file. It registers the plugin directly against the native
// bridge with `window.Capacitor.registerPlugin("RecapMlkitOcr")` (see
// resit/ocr.js). This module exists only so the package is a standard,
// bundler-friendly Capacitor plugin.
import { registerPlugin } from '@capacitor/core';

const RecapMlkitOcr = registerPlugin('RecapMlkitOcr');

export { RecapMlkitOcr };
