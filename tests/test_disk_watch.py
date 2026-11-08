"""Disk-watch test for just.MD: simulated agent writes against a fake file handle.
Serves this checkout on a free port (so a worktree tests its own code, not the installed app's)."""
import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{server.server_address[1]}/"

FAKE = """
() => {
  window.__disk = { text: '# Log\\n\\nentry 1\\n', mtime: 1000 };
  window.__written = null;
  window.__h = {
    name: 'log.md', kind: 'file',
    getFile: async () => {
      const d = window.__disk, f = new File([d.text], 'log.md', { lastModified: d.mtime });
      if (window.__slow) { const ab = f.arrayBuffer.bind(f); f.arrayBuffer = async () => { await new Promise(r => setTimeout(r, window.__slow)); return ab(); }; }
      return f;
    },
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    createWritable: async () => { let b = ''; return { write: async (t) => { b += t; },
      close: async () => { window.__written = b; window.__disk = { text: b, mtime: window.__disk.mtime + 1 }; } }; },
  };
  return true;
}
"""
fails = []
def check(name, ok):
    print(("[PASS] " if ok else "[FAIL] ") + name)
    if not ok: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_default_timeout(5000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "?t=watch")
    page.wait_for_function("window.mdv")
    page.evaluate(FAKE)
    page.evaluate("mdv.openFromHandle(window.__h)")
    page.wait_for_function("mdv.qe.src.includes('entry 1')")

    s0 = page.locator('#stamp').inner_text()
    check(f'stamp shown after open ({s0})', page.locator('#stamp').is_visible() and len(s0) > 4)
    # 1. agent appends, viewer clean -> manual check reloads
    page.evaluate("window.__disk = { text: window.__disk.text + '\\nentry 2\\n', mtime: new Date(new Date().getFullYear(), 10, 6, 9, 5).getTime() }")
    page.evaluate("mdv.checkDisk()")
    page.wait_for_timeout(300)
    check("clean viewer reloads agent append", "entry 2" in page.evaluate("mdv.qe.src"))
    s1 = page.locator('#stamp').inner_text()
    check(f'stamp updates on reload ({s1})', s1 == '6 Nov 09:05')
    check("still not dirty after reload", page.evaluate("mdv.qe.src === mdv.doc.savedText"))

    # 2. agent appends again, no manual call -> 5 s poll picks it up
    page.evaluate("window.__disk = { text: window.__disk.text + '\\nentry 3\\n', mtime: 3000 }")
    page.wait_for_timeout(6000)
    check("5 s poll reloads without a click", "entry 3" in page.evaluate("mdv.qe.src"))

    # 3. user edits (unsaved), agent appends -> no reload, user's edit kept
    page.evaluate("mdv.setMode('raw')")
    page.locator("#raw").click()
    page.keyboard.press("Control+End")
    page.keyboard.type("my note")
    page.evaluate("window.__disk = { text: window.__disk.text + '\\nentry 4\\n', mtime: 4000 }")
    page.evaluate("mdv.checkDisk()")
    page.wait_for_timeout(300)
    src = page.evaluate("mdv.qe.src")
    check("dirty viewer keeps the user's edit", "my note" in src and "entry 4" not in src)
    check("dirty viewer notes the disk change", "Changed on disk" in page.locator("#note").inner_text())

    # 4. save -> confirm dialog; Cancel writes nothing, agent's entry 4 survives
    page.once("dialog", lambda d: d.dismiss())
    page.evaluate("mdv.save()")
    page.wait_for_timeout(300)
    check("Cancel on the overwrite prompt writes nothing", page.evaluate("window.__written") is None)
    check("agent's entry 4 still on disk", "entry 4" in page.evaluate("window.__disk.text"))

    # 5. save -> OK overwrites
    page.once("dialog", lambda d: d.accept())
    page.evaluate("mdv.save()")
    page.wait_for_timeout(300)
    check("OK on the prompt writes the user's version", "my note" in (page.evaluate("window.__written") or ""))

    # 6. after that save, the next poll does not falsely reload or warn
    page.evaluate("window.__written = null")
    page.evaluate("mdv.checkDisk()")
    page.wait_for_timeout(300)
    check("no false 'changed' after own save", "my note" in page.evaluate("mdv.qe.src") and page.evaluate("mdv.qe.src === mdv.doc.savedText"))

    # 7. scroll position kept on reload (quick mode, long doc)
    page.evaluate("mdv.setMode('quick')")
    long = "\\n".join(f"line {i}\\n" for i in range(400))
    page.evaluate(f"window.__disk = {{ text: '{long}', mtime: 9000 }}")
    page.evaluate("mdv.checkDisk()")
    page.wait_for_timeout(300)
    page.evaluate("document.getElementById('scroller').scrollTop = 1500")
    page.evaluate(f"window.__disk = {{ text: '{long}' + '\\nmore\\n', mtime: 9100 }}")
    page.evaluate("mdv.checkDisk()")
    page.wait_for_timeout(300)
    top = page.evaluate("document.getElementById('scroller').scrollTop")
    check(f"scroll kept on reload (scrollTop {top})", abs(top - 1500) < 5)

    # 8. Raw: the caret stays on its character when an agent appends below it
    page.evaluate("mdv.setMode('raw')")
    page.evaluate("const r = document.getElementById('raw'); r.focus(); r.setSelectionRange(7, 7)")
    page.evaluate("window.__disk = { text: window.__disk.text + '\\nappended\\n', mtime: 9200 }")
    page.evaluate("mdv.checkDisk()")
    page.wait_for_timeout(300)
    sel = page.evaluate("document.getElementById('raw').selectionStart")
    check(f"Raw caret kept on reload (selectionStart {sel}, want 7)", sel == 7)
    # an insertion above the caret shifts it with the text
    page.evaluate("window.__disk = { text: 'NEW\\n' + window.__disk.text, mtime: 9300 }")
    page.evaluate("mdv.checkDisk()")
    page.wait_for_timeout(300)
    sel = page.evaluate("document.getElementById('raw').selectionStart")
    check(f"Raw caret follows an insertion above it (selectionStart {sel}, want 11)", sel == 11)

    # 9. Quick: the caret stays in its word when an agent appends
    page.evaluate("mdv.setMode('quick')")
    page.evaluate("""() => { const pg = document.getElementById('page'); const w = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf('line 12'); if (i >= 0) { pg.focus(); getSelection().collapse(n, i + 2); return; } } }""")
    page.evaluate("window.__disk = { text: window.__disk.text + '\\ntail\\n', mtime: 9400 }")
    page.evaluate("mdv.checkDisk()")
    page.wait_for_timeout(300)
    at = page.evaluate("(() => { const s = getSelection(); return s.anchorNode && s.anchorNode.isConnected ? (s.anchorNode.data || '').slice(s.anchorOffset - 2, s.anchorOffset + 5) : null; })()")
    check(f"Quick caret kept on reload (text at caret {at!r}, want 'line 12')", at == "line 12")

    # 10. a keystroke that lands while the reload is reading the file is not overwritten
    page.evaluate("mdv.setMode('raw')")
    page.evaluate("window.__slow = 400; window.__disk = { text: window.__disk.text + '\\nslow agent\\n', mtime: 9500 }")
    page.evaluate("() => { mdv.checkDisk(); }")   # start the check without waiting for it to finish
    page.wait_for_timeout(100)
    page.locator("#raw").click()
    page.keyboard.press("Control+End")
    page.keyboard.type("Z")
    page.wait_for_timeout(600)
    page.evaluate("window.__slow = 0")
    check("keystroke during a slow reload survives", page.evaluate("mdv.qe.src.endsWith('Z')"))

    # 11. Reload from disk with unsaved edits: OK on 'Discard?' discards them even if the file did not change
    page.once("dialog", lambda d: d.accept())
    page.evaluate("mdv.checkDisk({ force: true })")
    page.wait_for_timeout(300)
    check("forced reload after Discard drops the unsaved edit", not page.evaluate("mdv.qe.src.endsWith('Z')")
          and page.evaluate("mdv.qe.src === mdv.doc.savedText"))

    check("no page errors", not errors)
    b.close()
server.shutdown()

print("all passed" if not fails else f"{len(fails)} failed")
sys.exit(1 if fails else 0)
