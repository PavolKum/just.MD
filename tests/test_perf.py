"""Performance gate for Quick Edit: <= 4 ms median per keystroke on a ~100 KB file.

Usage: python tests/test_perf.py [--budget 4.0]

The file is long.md repeated to ~100 KB. Real keystrokes (Playwright keyboard) go into paragraphs, table
cells and list items near the top, middle and end of the document. The time measured is the app's own
handler, from beforeinput to "DOM patched and caret placed" (window.mdv.qe.perf). The run also checks the
bytes: every keystroke must land exactly where a plain string insert would put it.
"""
import argparse
import functools
import http.server
import statistics
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
LONG = (ROOT / "tests" / "fixtures" / "long.md").read_text(encoding="utf-8").lstrip("﻿").replace("\r\n", "\n")
REPS = round(100 * 1024 / len(LONG))
DOC = LONG * REPS

# (css scope, needle, which repeat, typed text)
SPOTS = [
    ("#page > .b > p", "A small markdown", 1, " quick"),
    ("#page td", "Unsaved changes", REPS // 2, " now"),
    ("#page ol li", "Open the hosted page", REPS // 2, " soon"),
    ("#page > .b > p", "After the first visit", REPS - 2, " always"),
    ("#page ul li", "a proxy that blocks", REPS - 1, " also"),
]

FIND_JS = r"""
([scope, needle, nth]) => {
  const root = document.getElementById('page');
  let count = 0;
  for (const host of root.querySelectorAll(scope)) {
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const idx = n.data.indexOf(needle);
      if (idx >= 0) {
        if (count === nth) {
          root.focus();
          const r = document.createRange();
          r.setStart(n, idx + needle.length); r.collapse(true);
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
          n.parentElement.scrollIntoView({ block: 'center' });
          return true;
        }
        count++;
      }
    }
  }
  return false;
}
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def nth_index(text, needle, nth):
    at = -1
    for _ in range(nth + 1):
        at = text.index(needle, at + 1)
    return at


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=4.0)
    args = ap.parse_args()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    ok = True
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        page.wait_for_load_state("networkidle")
        page.evaluate("([n, t]) => mdv.loadText(n, t, null)", ["big.md", DOC])
        print(f"document: {len(DOC) / 1024:.1f} KB ({REPS} x long.md), mode {page.evaluate('mdv.mode()')}")
        full = page.evaluate("(t) => { mdv.qe.buildModel(t); const a = performance.now(); for (let i = 0; i < 5; i++) mdv.qe.buildModel(t); return (performance.now() - a) / 5; }", DOC)
        print(f"full re-lex for reference: {full:.2f} ms")

        expect = DOC
        page.evaluate("mdv.qe.perf.length = 0")
        stats0 = page.evaluate("({...mdv.qe.stats})")
        for scope, needle, nth, typed in SPOTS:
            if not page.evaluate(FIND_JS, [scope, needle, nth]):
                print(f"[FAIL] could not place the caret after {needle!r} #{nth} in {scope}")
                ok = False
                continue
            page.wait_for_timeout(50)
            page.keyboard.type(typed, delay=15)
            at = nth_index(expect, needle, nth) + len(needle)
            expect = expect[:at] + typed + expect[at:]
        got = page.evaluate("mdv.qe.src")
        perf = page.evaluate("mdv.qe.perf.slice()")
        stats1 = page.evaluate("({...mdv.qe.stats})")

        # ---- Raw at the same size: typing and scrolling with the syntax mirror ----
        page.evaluate("mdv.setMode('raw')")
        page.evaluate("""() => { const r = document.getElementById('raw'); r.focus();
            const p = r.value.indexOf('Unsaved changes', Math.floor(r.value.length / 2)); r.setSelectionRange(p, p); }""")
        page.wait_for_timeout(100)
        page.evaluate("mdv.qe.rawPerf.length = 0")
        raw_typed = " raw words"
        page.keyboard.type(raw_typed, delay=15)
        raw_perf = page.evaluate("mdv.qe.rawPerf.slice()")
        page.evaluate("mdv.qe.hlPerf.length = 0")
        for _ in range(30):
            page.evaluate("document.getElementById('scroller').scrollTop += 700")
            page.wait_for_timeout(20)
        hl_perf = page.evaluate("mdv.qe.hlPerf.slice()")
        aligned = page.evaluate("document.getElementById('rawhl').textContent === document.getElementById('raw').value")
        browser.close()
    server.shutdown()

    keys = sum(len(s[3]) for s in SPOTS)
    med = statistics.median(perf) if perf else float("inf")
    p90 = sorted(perf)[int(len(perf) * 0.9)] if perf else float("inf")
    fallbacks = stats1["fallback"] - stats0["fallback"]
    print(f"keystrokes: {len(perf)} measured ({keys} typed); median {med:.2f} ms, p90 {p90:.2f} ms, max {max(perf):.2f} ms")
    print(f"block patches: {stats1['fast'] - stats0['fast']} fast plans, {fallbacks} full re-lex fallbacks")
    raw_med = statistics.median(raw_perf) if raw_perf else float("inf")
    hl_med = statistics.median(hl_perf) if hl_perf else float("inf")
    print(f"Raw typing: {len(raw_perf)} input events, median {raw_med:.2f} ms, max {max(raw_perf or [0]):.2f} ms")
    print(f"Raw scrolling: {len(hl_perf)} syntax passes, median {hl_med:.2f} ms, max {max(hl_perf or [0]):.2f} ms")
    checks = [
        ("every keystroke measured", len(perf) == keys, f"{len(perf)} vs {keys}"),
        ("bytes land exactly where typed", got == expect, ""),
        ("no full re-lex fallbacks while typing", fallbacks == 0, str(fallbacks)),
        (f"median <= {args.budget} ms per keystroke", med <= args.budget, f"{med:.2f} ms"),
        (f"Raw typing median <= {args.budget} ms per input", raw_med <= args.budget and len(raw_perf) == len(raw_typed), f"{raw_med:.2f} ms, {len(raw_perf)} events"),
        (f"Raw scrolling median <= {args.budget} ms per syntax pass", hl_med <= args.budget and len(hl_perf) >= 10, f"{hl_med:.2f} ms, {len(hl_perf)} passes"),
        ("Raw syntax mirror equals the textarea after typing and scrolling", aligned, ""),
        ("no page errors", not errors, "; ".join(errors[:3])),
    ]
    for name, good, detail in checks:
        print(f"[{'PASS' if good else 'FAIL'}] {name}" + (f"  ({detail})" if detail and not good else ""))
        ok &= good
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
