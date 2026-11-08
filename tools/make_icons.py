"""Render icons/icon.svg to the PNG sizes the web app manifest needs.

Usage: python tools/make_icons.py
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SVG = (ROOT / "icons" / "icon.svg").read_text(encoding="utf-8")

with sync_playwright() as p:
    browser = p.chromium.launch()
    for size in (192, 512):
        page = browser.new_page(viewport={"width": size, "height": size})
        html = (
            "<html><head><style>svg{width:100%;height:100%;display:block}</style></head>"
            "<body style='margin:0;background:transparent'>"
            f"<div style='width:{size}px;height:{size}px'>{SVG}</div></body></html>"
        )
        page.set_content(html)
        out = ROOT / "icons" / f"icon-{size}.png"
        page.locator("svg").screenshot(path=str(out), omit_background=True)
        print(f"wrote {out} ({out.stat().st_size} bytes)")
    browser.close()
