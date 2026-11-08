"""Smoke test for just.MD v2: serve the folder, drive it in Chromium, check render, edit, save, chrome.

Usage: python tests/smoke.py [--shots DIR]
Exits non-zero if any check failed. Screenshots go to DIR (default: tests/_shots, gitignored).
"""
import argparse
import functools
import http.server
import re
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = (ROOT / "tests" / "fixtures" / "sample.md").read_text(encoding="utf-8").replace("\r\n", "\n")
LONG = (ROOT / "tests" / "fixtures" / "long.md").read_text(encoding="utf-8").replace("\r\n", "\n")
BOM = "\ufeff"

failures = []


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# Fake FileSystemFileHandle: records what save() writes. fail=True makes the write throw.
FAKE_HANDLE_JS = """
(fail) => {
  window.__written = null;
  return {
    name: 'fixture.md',
    kind: 'file',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => {
      if (fail) throw new Error('disk is read-only');
      let buf = '';
      return { write: async (t) => { buf += t; }, close: async () => { window.__written = buf; } };
    },
  };
}
"""


def text_of(page, sel):
    return page.evaluate(f"document.querySelector({sel!r}).textContent")


def save_with(page, fail=False):
    handle = page.evaluate_handle(FAKE_HANDLE_JS, fail)
    page.evaluate("h => { window.mdv.doc.handle = h; }", handle)
    page.keyboard.press("Control+s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=str(ROOT / "tests" / "_shots"))
    args = ap.parse_args()
    shots = Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)

    server = serve()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme="dark",
                                  permissions=["clipboard-read", "clipboard-write"])
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        # The fixture's <img src="x"> (sanitiser probe) 404s by design; anything else counts.
        page.on("console", lambda m: errors.append(m.text)
                if m.type == "error" and not m.location.get("url", "").endswith("/x") else None)
        page.goto(url)
        page.wait_for_load_state("networkidle")

        # ---- launch ----
        check("empty state shown on launch", page.locator("#empty").is_visible())
        check("empty state: drop frame, Open button, Ctrl+K line",
              page.locator(".drop-title").inner_text() == "Drop a markdown file here"
              and page.locator("#btn-open").is_visible() and "Ctrl" in page.locator(".empty-line").inner_text())
        check("no mode pill or file tools until a file is open", page.locator("#pill").is_hidden() and page.locator("#tools").is_hidden())
        check("install hint shown in a browser tab", page.locator(".install").is_visible())
        manifest = page.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
        check("manifest has the .md file handler", ".md" in manifest["file_handlers"][0]["accept"]["text/markdown"])
        check("manifest asks for Window Controls Overlay with a standalone fallback",
              manifest.get("display_override") == ["window-controls-overlay", "standalone"])
        css = (ROOT / "style.css").read_text(encoding="utf-8")
        check("strip uses titlebar-area env() and a drag region with buttons excluded",
              "env(titlebar-area-width" in css and "app-region: drag" in css and "app-region: no-drag" in css)
        check("service worker active", page.evaluate("navigator.serviceWorker.ready.then(r => !!r.active)"))
        sw = (ROOT / "sw.js").read_text(encoding="utf-8")
        shell = re.findall(r'^\s+"([^"]+)",$', sw, re.M)
        missing = [f for f in shell if f != "./" and not (ROOT / f).exists()]
        loaded = re.findall(r'(?:src|href)="([^"]+\.(?:js|css))"', (ROOT / "index.html").read_text(encoding="utf-8"))
        check("service worker caches every shell file, and they all exist",
              not missing and all(f in shell for f in loaded), f"missing={missing} uncached={[f for f in loaded if f not in shell]}")

        # ---- load a CRLF + BOM file ----
        crlf_bom = BOM + FIXTURE.replace("\n", "\r\n")
        page.evaluate("([name, text, h]) => window.mdv.loadText(name, text, h)", ["fixture.md", crlf_bom, None])
        pv = page.locator("#page")
        check("opens in Quick Edit", page.evaluate("mdv.mode()") == "quick" and pv.is_visible() and page.locator("#raw").is_hidden())
        check("heading rendered", pv.locator("h1").inner_text() == "Markdown render test")
        check("inline code rendered", pv.locator("p code").first.inner_text() == "inline code")
        check("fenced code highlighted", pv.locator("pre code.language-python .hljs-keyword").count() >= 1)
        check("plain code block kept", pv.locator("pre code").count() == 2)
        check("table rendered", pv.locator("table tbody tr").count() == 2)
        check("blockquote rendered", pv.locator("blockquote").count() == 1)
        check("divider rendered", pv.locator("hr").count() == 1)
        check("task checkboxes rendered", pv.locator("input[type=checkbox]").count() == 2)
        check("heading ids for anchors", pv.locator("h2#table").count() == 1)
        check("script/onerror sanitised", page.evaluate("window.__xss === undefined") and pv.locator("script").count() == 0
              and page.evaluate("!document.querySelector('#page img').hasAttribute('onerror')"))
        check("Quick surface is editable with spellcheck off",
              page.evaluate("document.getElementById('page').isContentEditable && document.getElementById('page').spellcheck === false"))
        check("raw HTML block is frozen", page.evaluate("document.querySelector('#page .b.frozen img') !== null"))
        check("not dirty after load: status 'Saved', no dot", text_of(page, "#status") == "Saved" and page.locator(".mark .dot").is_hidden())
        check("Quick Edit line in the strip", page.locator("#note").is_visible() and text_of(page, "#note") == "Click any text to edit. Formatting stays put.")
        check("no Save button while the file is clean", page.locator("#btn-save").is_hidden())
        check("strip shows the file name and the mode pill", text_of(page, "#name") == "fixture.md" and page.locator("#pill").is_visible())
        check("disk text round-trips CRLF+BOM", page.evaluate("window.mdv.textForDisk()") == crlf_bom)
        page.screenshot(path=str(shots / "1-quick-dark.png"))

        # ---- edit in Quick, save through a fake handle ----
        page.evaluate("""() => { const n = document.querySelector('#page h1 .qe-r').firstChild;
            document.getElementById('page').focus(); getSelection().collapse(n, n.data.length); }""")
        page.keyboard.type(" v2")
        check("Quick edit changed exactly the heading", page.evaluate("mdv.textForDisk()") == crlf_bom.replace("render test\r\n", "render test v2\r\n", 1))
        check("dirty: pink dot and 'Edited'", page.locator(".mark .dot").is_visible() and text_of(page, "#status") == "Edited")
        check("title marks unsaved", page.title().startswith("* "))
        check("Quick Edit line dismissed after the first edit", page.wait_for_selector("#note", state="hidden", timeout=2000) is None)
        check("dirty: a Save button in the strip, with its shortcut", page.locator("#btn-save").is_visible()
              and page.evaluate("document.getElementById('btn-save').dataset.tip") == "Save (Ctrl+S)")
        handle = page.evaluate_handle(FAKE_HANDLE_JS, False)
        page.evaluate("h => { window.mdv.doc.handle = h; }", handle)
        page.click("#btn-save")
        page.wait_for_function("window.__written !== null", timeout=3000)
        check("the Save button saves", "# Markdown render test v2\r\n" in page.evaluate("window.__written"))
        page.wait_for_function("document.getElementById('status').textContent === 'Saved'", timeout=3000)
        check("the Save button leaves with the save (120 ms exit)", page.wait_for_selector("#btn-save", state="hidden", timeout=1500) is None)
        save_with(page)
        page.wait_for_function("window.__written !== null", timeout=3000)
        written = page.evaluate("window.__written")
        check("save wrote the Quick edit with CRLF", "# Markdown render test v2\r\n" in written, repr(written[:40]))
        check("save kept BOM", written.startswith(BOM))
        page.wait_for_function("document.getElementById('status').textContent === 'Saved'", timeout=3000)
        check("dirty cleared after save, status back to 'Saved'", not page.evaluate("document.documentElement.classList.contains('dirty')"))

        # ---- Raw: edit and save ----
        page.evaluate("mdv.setMode('edit')")
        check("Raw ('edit') shows the source and hides the page", page.locator("#raw").is_visible() and pv.is_hidden())
        check("Raw has its own strip line", text_of(page, "#note") == "Raw markdown - Ctrl+E back to the page")
        page.locator("#raw").press("Control+End")
        page.keyboard.type("\nAdded line.")
        check("Raw edit marks dirty", text_of(page, "#status") == "Edited")
        save_with(page)
        page.wait_for_function("window.__written !== null", timeout=3000)
        written = page.evaluate("window.__written")
        check("save from Raw wrote the edit with CRLF and BOM", written.endswith("\r\nAdded line.") and written.startswith(BOM), repr(written[-40:]))
        check("untouched bytes stay identical", written == crlf_bom.replace("render test\r\n", "render test v2\r\n", 1) + "\r\nAdded line.")

        # ---- a slow save: Saving..., Save disabled and dimmed ----
        page.keyboard.type(" Slow.")
        slow = page.evaluate_handle("""() => ({ name: 'fixture.md', kind: 'file', queryPermission: async () => 'granted',
            requestPermission: async () => 'granted',
            createWritable: async () => ({ write: async () => {}, close: () => new Promise((r) => { window.__finishSave = r; }) }) })""")
        page.evaluate("h => { window.mdv.doc.handle = h; }", slow)
        page.keyboard.press("Control+s")
        page.wait_for_function("document.getElementById('status').textContent === 'Saving...'", timeout=3000)
        check("during a save: 'Saving...', Save disabled and dimmed",
              page.evaluate("document.getElementById('btn-save').getAttribute('aria-disabled')") == "true"
              and float(page.evaluate("getComputedStyle(document.getElementById('btn-save')).opacity")) < 0.6)
        widths = page.evaluate("""() => { const s = document.getElementById('status'); const out = [];
            for (const w of ['Edited', 'Saving...', 'Saved', 'Failed']) { s.textContent = w; out.push(s.offsetWidth); } s.textContent = 'Saving...'; return out; }""")
        check("status keeps one width for Edited / Saving... / Saved / Failed (Save never jumps)", len(set(widths)) == 1, str(widths))
        page.keyboard.type(" During.")
        page.evaluate("window.__finishSave()")
        page.wait_for_timeout(300)
        check("text changed during a save: the status ends at 'Edited' and the dot stays",
              text_of(page, "#status") == "Edited" and page.locator(".mark .dot").is_visible())
        save_with(page)
        page.wait_for_function("document.getElementById('status').textContent === 'Saved'", timeout=3000)

        # ---- save failure ----
        page.keyboard.type(" More.")
        save_x = page.evaluate("document.getElementById('btn-save').getBoundingClientRect().left")
        save_with(page, fail=True)
        page.wait_for_function("document.getElementById('status').textContent === 'Failed'", timeout=3000)
        check("failed save: 'Failed' in the status slot",
              page.evaluate("document.documentElement.classList.contains('save-error')") and text_of(page, "#status") == "Failed")
        check("failed save: the Save chip becomes Retry, the reason in its tooltip",
              text_of(page, "#btn-save") == "Retry"
              and "read-only" in page.evaluate("document.getElementById('btn-save').dataset.tip"),
              page.evaluate("document.getElementById('btn-save').dataset.tip"))
        check("failed save: a Save as chip appears", page.locator("#btn-saveas").is_visible())
        check("failed save: its own mark (ring with !), not the Edited dot",
              page.locator(".mark .fail").is_visible() and page.locator(".mark .dot").is_hidden())
        hits = page.evaluate("""() => {
            const hitH = (el) => { const r = el.getBoundingClientRect(); let h = 0;
              for (let y = r.top - 6; y <= r.bottom + 6; y += 0.5) { const t = document.elementFromPoint(r.left + r.width / 2, y); if (t === el || el.contains(t)) h += 0.5; } return h; };
            return { pill: hitH(document.querySelector('#pill button[data-mode=raw]')), save: hitH(document.getElementById('btn-save')),
                     saveas: hitH(document.getElementById('btn-saveas')), copy: hitH(document.getElementById('btn-copy-all')),
                     more: hitH(document.getElementById('btn-more')) }; }""")
        check("strip controls have 30-32 px hit areas (pill, Retry, Save as, copy, ...)", all(30 <= v <= 33 for v in hits.values()), str(hits))
        check("failed save: the reason as a line in the strip, and Retry describes itself with it (keyboard)",
              text_of(page, "#note") == "Not saved - the file is read-only or locked"
              and page.evaluate("document.getElementById('btn-save').getAttribute('aria-describedby')") == "note")
        check("failed save: nothing in the strip moves (Retry sits where Save was)",
              abs(page.evaluate("document.getElementById('btn-save').getBoundingClientRect().left") - save_x) < 0.5)
        save_with(page)
        page.wait_for_function("document.getElementById('status').textContent === 'Saved'", timeout=3000)
        check("retry after a failed save clears the error", not page.evaluate("document.documentElement.classList.contains('save-error')"))

        # ---- split, palette ----
        page.evaluate("mdv.setMode('split')")
        check("split shows both panes", page.locator("#raw").is_visible() and pv.is_visible())
        page.screenshot(path=str(shots / "2-split-dark.png"))
        page.evaluate("mdv.setMode('view')")
        check("'view' maps to Quick Edit", page.evaluate("mdv.mode()") == "quick" and page.locator("#raw").is_hidden())
        page.keyboard.press("Control+k")
        page.wait_for_selector("#palette[open]", timeout=2000)
        labels = page.evaluate("[...document.querySelectorAll('#palette li .label')].map(x => x.textContent)")
        check("palette opens on Ctrl+K with Open, Save as, Raw, Split, Theme and Copy all",
              all(any(w in l for l in labels) for w in ["Open file", "Save as", "Raw", "Split", "Theme: Light", "Copy all"]),
              str(labels))
        page.keyboard.type("theme")
        page.keyboard.press("Enter")
        page.wait_for_function("document.documentElement.dataset.theme === 'light'", timeout=3000)
        check("palette runs a command (theme -> light) and closes", not page.evaluate("document.getElementById('palette').open"))
        check("light theme colours applied", page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(250, 248, 244)"
              and page.evaluate("getComputedStyle(document.documentElement).colorScheme") == "light")
        page.wait_for_timeout(400)
        page.screenshot(path=str(shots / "3-quick-light.png"))
        page.evaluate("mdv.setTheme('dark')")
        check("dark theme colours applied", page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(19, 23, 29)")
        # ---- theme menu (Signature / Light / Blackwall / Synthwave) ----
        page.click("#btn-theme")
        page.wait_for_function("document.getElementById('theme-menu').matches(':popover-open')", timeout=2000)
        check("theme menu lists the four themes, current one ticked",
              page.evaluate("[...document.querySelectorAll('#theme-menu button')].map(b => b.textContent + ':' + b.getAttribute('aria-checked')).join(',')")
              == "Signature:true,Light:false,Blackwall:false,Synthwave:false")
        page.click("#theme-menu [data-pick=synthwave]")
        page.wait_for_function("document.documentElement.dataset.theme === 'synthwave' && !document.documentElement.classList.contains('vt-theme')", timeout=3000)
        check("picking Synthwave applies it and closes the menu",
              page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(38, 35, 53)"
              and not page.evaluate("document.getElementById('theme-menu').matches(':popover-open')")
              and page.evaluate("document.getElementById('theme-color').content") == "#1E1A29")
        page.evaluate("mdv.setTheme('blackwall')")
        check("Blackwall colours applied", page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(27, 22, 23)")
        # markdown roles per theme: headings, bold, italic, code and body each get their own colour
        for theme in ("dark", "light", "blackwall", "synthwave"):
            page.evaluate(f"mdv.setTheme('{theme}')")
            roles = page.evaluate("""() => {
              const md = document.querySelector('.md'), v = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
              const probe = html => { const d = document.createElement('div'); d.innerHTML = html; md.appendChild(d);
                const c = getComputedStyle(d.firstElementChild.firstElementChild || d.firstElementChild).color; d.remove(); return c; };
              return [getComputedStyle(md).color, probe('<h2>h</h2>'), probe('<p><strong>b</strong></p>'),
                      probe('<p><em>i</em></p>'), probe('<p><code>c</code></p>'), v('--md-text')];
            }""")
            check(f"{theme}: markdown roles each have their own colour (body, heading, bold, italic, code)",
                  len(set(roles[:5])) == 5 and roles[5] != "", str(roles))
        page.evaluate("mdv.setTheme('blackwall')")
        page.keyboard.press("Control+Shift+L")
        page.wait_for_function("!document.documentElement.classList.contains('vt-theme')", timeout=3000)
        check("Ctrl+Shift+L steps to the next theme (Blackwall -> Synthwave)", page.evaluate("document.documentElement.dataset.theme") == "synthwave")
        page.evaluate("mdv.setTheme('light')")

        # ---- Copy all ----
        page.evaluate("mdv.setMode('quick')")
        page.click("#btn-copy-all")
        page.wait_for_timeout(100)
        clip = page.evaluate("navigator.clipboard.readText()")
        check("Copy all puts the whole markdown on the clipboard", clip.replace("\r\n", "\n") == page.evaluate("mdv.qe.src"))
        check("Copy all confirms in place (icon becomes a check)", page.evaluate("document.getElementById('btn-copy-all').classList.contains('done')"))
        # ---- large file opens in Raw ----
        big = LONG * (310 * 1024 // len(LONG) + 1)
        page.evaluate("([n, t]) => mdv.loadText(n, t, null)", ["big.md", big])
        check("a file over ~300 KB opens in Raw with 'Large file - Raw'",
              page.evaluate("mdv.mode()") == "raw" and text_of(page, "#status") == "Large file - Raw")
        check("large file still round-trips", page.evaluate("mdv.textForDisk()") == big)

        # ---- reduced motion: no View Transition, the switch is instant ----
        page.emulate_media(reduced_motion="reduce")
        page.evaluate("([n, t]) => mdv.loadText(n, t, null)", ["fixture.md", crlf_bom])
        page.evaluate("document.getElementById('page').focus()")
        page.keyboard.press("Control+e")
        check("reduced motion: Ctrl+E switches to Raw at once (no View Transition)", page.evaluate("mdv.mode()") == "raw"
              and not page.evaluate("document.documentElement.classList.contains('vt-mode')"))
        page.emulate_media(reduced_motion="no-preference")

        # ---- theme persistence ----
        page.reload()
        page.wait_for_load_state("networkidle")
        check("theme remembered after reload", page.evaluate("document.documentElement.dataset.theme") == "light")

        browser.close()

    server.shutdown()
    check("no console/page errors", not errors, "; ".join(errors[:3]))
    print(f"\nscreenshots: {shots}")
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
