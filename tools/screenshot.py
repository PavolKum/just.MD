"""Render the README screenshot: docs/screenshot.md in the app, dark theme, Quick Edit.

  python tools/screenshot.py     writes docs/screenshot.png (needs Playwright + Chromium, like the tests)
"""
import functools
import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "screenshot.md"
OUT = ROOT / "docs" / "screenshot.png"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1280, "height": 760}, color_scheme="dark", device_scale_factor=1)
            page = ctx.new_page()
            page.goto(url)
            page.wait_for_function("window.mdv")
            page.evaluate("mdv.setTheme('dark')")
            text = DOC.read_text(encoding="utf-8").replace("\r\n", "\n")
            page.evaluate("([name, text]) => window.mdv.loadText(name, text, null)", ["release-notes.md", text])
            page.evaluate("document.fonts.ready")
            page.wait_for_timeout(600)   # let the arrival fade finish
            page.screenshot(path=str(OUT))
            browser.close()
    finally:
        server.shutdown()
    print(f"[OK] wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
