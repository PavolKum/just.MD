"""Record the just.MD promo: the app showing its own README, stepping through the four
themes and changing one word with Quick Edit, inside tools/promo/stage.html.

  python tools/promo/make_promo.py     writes tools/promo/out/just-md-demo.mp4 and docs/demo.gif

Needs Playwright + Chromium (like the tests) and ffmpeg on PATH. Records in real time (~17 s).
"""
import functools
import http.server
import shutil
import subprocess
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / "promo" / "out"
MP4 = OUT / "just-md-demo.mp4"
GIF = ROOT / "docs" / "demo.gif"
WINDOW = (71, 92)   # the app iframe's top-left corner on the 1600x900 stage
SCALE = 1.35        # the stage shows the 1080x700 app window at this zoom, cut off by the bottom edge


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def readme_text():
    # badge and screenshot lines would show as broken images inside the app (it only sees the one file)
    lines = (ROOT / "README.md").read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")
    keep = [l for l in lines if not l.startswith("[![") and not l.startswith("![")]
    text = "\n".join(keep)
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    return text


def word_center(frame, selector, word):
    """Page coordinates of the centre of the first occurrence of word inside selector (in the iframe)."""
    r = frame.evaluate("""([sel, word]) => {
        const el = document.querySelector(sel);
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
            const i = n.data.indexOf(word);
            if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length);
                          const b = r.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }
        }
        return null; }""", [selector, word])
    if not r:
        raise SystemExit(f"[ERROR] '{word}' not found in {selector}")
    return WINDOW[0] + r[0] * SCALE, WINDOW[1] + r[1] * SCALE


def record():
    OUT.mkdir(parents=True, exist_ok=True)
    raw = OUT / "raw"
    if raw.exists():
        shutil.rmtree(raw)   # only this script's own scratch recordings
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/tools/promo/stage.html"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1600, "height": 900}, color_scheme="dark",
                                      record_video_dir=str(raw), record_video_size={"width": 1600, "height": 900})
            t_ctx = time.monotonic()
            page = ctx.new_page()
            page.goto(url)
            page.wait_for_function("document.getElementById('app').contentWindow.mdv")
            app = page.frame_locator("#app")
            frame = page.frames[1]
            frame.evaluate("mdv.setTheme('dark')")
            frame.evaluate("([n, t]) => mdv.loadText(n, t, null)", ["README.md", readme_text()])
            frame.evaluate("document.fonts.ready")
            page.wait_for_timeout(1200)
            t_start = time.monotonic() - t_ctx - 0.3

            wait = page.wait_for_timeout
            wait(1800)
            # step through the themes with the real shortcut (animated View Transition)
            page.evaluate("document.getElementById('app').contentWindow.focus()")
            for _ in range(4):
                page.keyboard.press("Control+Shift+L")
                wait(2300)
            # Quick Edit: change one word on the rendered page, then undo
            x, y = word_center(frame, "#page p", "small")
            page.mouse.move(x - 120, y + 60); wait(200)
            page.mouse.move(x, y, steps=12); wait(250)
            page.mouse.dblclick(x, y); wait(450)
            picked = frame.evaluate("getSelection().toString()")
            if picked.strip() != "small":
                raise SystemExit(f"[ERROR] double-click selected {picked!r}, not 'small'")
            page.keyboard.type("tiny" + (" " if picked.endswith(" ") else ""), delay=120); wait(1600)
            page.keyboard.press("Control+z"); wait(1300)
            t_end = time.monotonic() - t_ctx
            video = page.video
            ctx.close()
            src = Path(video.path())
            browser.close()
    finally:
        server.shutdown()
    return src, t_start, t_end


def encode(src, t_start, t_end):
    dur = t_end - t_start
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t_start:.2f}", "-i", str(src), "-t", f"{dur:.2f}",
                    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "slow",
                    "-movflags", "+faststart", str(MP4)], check=True)
    palette = OUT / "palette.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(MP4), "-vf",
                    "fps=12,scale=880:-1:flags=lanczos,palettegen=max_colors=160:stats_mode=diff", str(palette)], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(MP4), "-i", str(palette), "-lavfi",
                    "fps=12,scale=880:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
                    str(GIF)], check=True)
    print(f"[OK] {MP4.relative_to(ROOT)} ({dur:.1f} s, {MP4.stat().st_size / 1e6:.1f} MB)")
    print(f"[OK] {GIF.relative_to(ROOT)} ({GIF.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    encode(*record())
