"""LAN static server for OCR-ENGINE-PLAN.md Phase 3b (on-device bench).

Plain `python -m http.server` sends no CORS headers, and the debug APK's
WebView page (origin https://localhost, per Capacitor) fetches this server
cross-origin (a different scheme+host) to pull bench/score.js and the
test-receipts photos/truth JSON — so every response needs
Access-Control-Allow-Origin or the phone-side fetch() calls fail silently.

Run from the resit/ folder so relative paths line up with score.js's
"/bench/score.js" and "/test-receipts/my/..." fetches:

    python bench/serve-lan.py [port]   (default 8906)

Then on the phone (same Wi-Fi), point the bench console script's LAN base
at the printed http://<ip>:<port>/ URL.
"""
import http.server
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8906


class CorsHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Only https://localhost (the debug APK's WebView origin, per the
        # docstring above) actually needs to read these responses. A bare
        # "*" let ANY origin's JS fetch() and read this server's files while
        # it's running (it binds 0.0.0.0, i.e. LAN-wide, not just loopback)
        # -- receipt test photos + truth data, not otherwise public (Phase
        # 13 review, 2026-08-05).
        self.send_header("Access-Control-Allow-Origin", "https://localhost")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


if __name__ == "__main__":
    ips = lan_ips()
    print(f"Serving resit/ on port {PORT} with CORS enabled (Ctrl+C to stop).")
    if ips:
        for ip in ips:
            print(f"  Phone LAN base: http://{ip}:{PORT}/")
    else:
        print("  Could not auto-detect a LAN IP — run `ipconfig`, use the IPv4")
        print("  address under your Wi-Fi adapter.")
    print(f"  adb reverse base: http://localhost:{PORT}/ (after `adb reverse tcp:{PORT} tcp:{PORT}`)")
    # Bind explicitly to the IPv4 wildcard. The default (bind=None) listens on
    # the IPv6 wildcard "::" — on Windows that doesn't reliably accept plain
    # IPv4 loopback connections, which is exactly what `adb reverse` relays
    # through (net::ERR_EMPTY_RESPONSE on the phone side otherwise).
    http.server.test(HandlerClass=CorsHandler, port=PORT, bind="0.0.0.0")
