"""Quick Edit suite against the real app: real keystrokes in headless Chromium, byte-level diff of the saved text.

Covers the v2 behaviour
(shared Quick/Raw undo, Tab between pieces, fast-patch self-check).

Usage:
  python tests/test_quick_edit.py                  good build, then every deliberately broken variant
  python tests/test_quick_edit.py --only good      one variant (good|offset|noverify|noguard|noshift)

Fixtures are loaded as CRLF + UTF-8 BOM. Broken variants are made by rewriting engine.js / app.js on the
way to the browser (Playwright request interception), so the shipped code carries no break switches.
Each rewrite must match exactly once, or the run stops. Exit code 0 only if the good build passes every
check AND every broken variant fails at least one check (a suite that cannot go red proves nothing).
"""
import argparse
import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
BOM = "﻿"


def disk_text(path):
    lf = path.read_text(encoding="utf-8").lstrip(BOM).replace("\r\n", "\n")
    return BOM + lf.replace("\n", "\r\n")


FIXTURES = {
    "sample.md": disk_text(FIX / "sample.md"),
    "long.md": disk_text(FIX / "long.md"),
    "edge.md": disk_text(FIX / "edge.md"),
}

# variant -> list of (file, exact old text, new text)
VARIANTS = {
    "good": [],
    # every display offset maps one character too far
    "offset": [("engine.js", "return p.s + (d - p.d);", "return p.s + (d - p.d) + 1;")],
    # the re-parse check accepts everything
    "noverify": [("engine.js", "return sameSkel(gotSkel, expectSkel) && leafOk;", "return true;")],
    # deletes at a piece edge and Enter go straight to the source
    "noguard": [
        ("app.js", 'if (!range) return refuse("boundary");',
         'if (!range) { const s0 = Engine.dToS(leaf, a.d); const at = dir < 0 ? s0 - 1 : s0; '
         'replaceSource(state.src.slice(0, at) + state.src.slice(at + 1), -1); return; }'),
        ("app.js", '      return refuse("enter");',
         '      if (pts.a) { const s0 = Engine.dToS(leaf, pts.a.d); '
         'replaceSource(state.src.slice(0, s0) + "\\n\\n" + state.src.slice(s0), -1); return; }\n'
         '      return refuse("enter");'),
    ],
    # the block patch forgets to move the source offsets of everything after the edited window
    "noshift": [("engine.js", "for (const p of m.leaves[L].parts) { p.s += delta; p.e += delta; }", "{}")],
}

HELPERS = r"""
() => {
  const root = document.getElementById('page');
  function find(scope, needle, nth) {
    const hosts = scope ? [...root.querySelectorAll(scope)] : [root];
    let count = 0;
    for (const host of hosts) {
      const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        let from = 0, idx;
        while ((idx = n.data.indexOf(needle, from)) >= 0) {
          if (count === nth) return { node: n, idx };
          count++; from = idx + 1;
        }
      }
    }
    return null;
  }
  window.T = {
    select(scope, needle, nth = 0, start = 0, len = null) {
      const f = find(scope, needle, nth);
      if (!f) return false;
      root.focus();
      const r = document.createRange();
      r.setStart(f.node, f.idx + start);
      r.setEnd(f.node, f.idx + start + (len == null ? needle.length - start : len));
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return true;
    },
    caret(scope, needle, off = 0, nth = 0) { return this.select(scope, needle, nth, off, 0); },
    selectAcross(scope, a, aOff, b, bOff) {
      const fa = find(scope, a, 0), fb = find(scope, b, 0);
      if (!fa || !fb) return false;
      root.focus();
      const r = document.createRange();
      r.setStart(fa.node, fa.idx + aOff); r.setEnd(fb.node, fb.idx + bOff);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return true;
    },
    beforeinput(type, text) {
      const dt = new DataTransfer(); dt.setData('text/plain', text || '');
      const ev = new InputEvent('beforeinput', { inputType: type, dataTransfer: dt, cancelable: true, bubbles: true });
      root.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
  };
  return true;
}
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def install_variant(ctx, variant):
    """Serve engine.js / app.js with the variant's rewrites applied; fail loud if a rewrite misses."""
    by_file = {}
    for fname, old, new in VARIANTS[variant]:
        by_file.setdefault(fname, []).append((old, new))
    for fname, edits in by_file.items():
        text = (ROOT / fname).read_text(encoding="utf-8")
        for old, new in edits:
            n = text.count(old)
            if n != 1:
                raise SystemExit(f"variant {variant}: expected 1 match of {old!r} in {fname}, found {n}")
            text = text.replace(old, new)
        body = text

        def handler(route, request, body=body):
            route.fulfill(status=200, content_type="application/javascript", body=body)

        ctx.route(f"**/{fname}", handler)


def first_diff(a, b):
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    return f"at {i}: got {a[max(0, i - 20):i + 25]!r} want {b[max(0, i - 20):i + 25]!r}"


def diff_window(a, b):
    """Return (start, end_in_a, end_in_b) of the single changed window between two strings."""
    p = 0
    while p < min(len(a), len(b)) and a[p] == b[p]:
        p += 1
    q = 0
    while q < min(len(a), len(b)) - p and a[len(a) - 1 - q] == b[len(b) - 1 - q]:
        q += 1
    return p, len(a) - q, len(b) - q


class Suite:
    def __init__(self, page, variant):
        self.page = page
        self.variant = variant
        self.results = []

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail))
        if self.variant == "good" or not ok:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail and not ok else ""))

    def load(self, fixture):
        self.page.evaluate("([n, t]) => mdv.loadText(n, t, null)", [fixture, FIXTURES[fixture]])
        self.page.evaluate(HELPERS)

    def out(self):
        return self.page.evaluate("mdv.textForDisk()")

    def wait_mode(self, mode):
        try:
            self.page.wait_for_function(f"mdv.qe.mode === '{mode}'", timeout=2000)
            self.page.wait_for_timeout(50)
            return True
        except Exception:
            return False

    # 1. a word edit changes exactly those characters
    def word(self, fixture, label, scope, needle, typed, ctx_old, ctx_new, nth=0, start=0, length=None):
        self.load(fixture)
        before = FIXTURES[fixture]
        assert before.count(ctx_old) == 1, f"context not unique: {ctx_old!r}"
        found = self.page.evaluate("([s, n, i, a, l]) => T.select(s, n, i, a, l)", [scope, needle, nth, start, length])
        if not found:
            return self.check(f"1 {fixture}: {label}", False, f"needle {needle!r} not found in {scope}")
        self.page.keyboard.type(typed)
        want = before.replace(ctx_old, ctx_new)
        got = self.out()
        self.check(f"1 {fixture}: {label}", got == want, first_diff(got, want) if got != want else "")

    # 2. typed syntax is escaped: same structure, the text shows the characters, change stays local
    def syntax(self, fixture, label, scope, needle, off, typed, shown, ctx):
        self.load(fixture)
        before_struct = self.page.evaluate("mdv.qe.structure()")
        before = FIXTURES[fixture]
        self.page.evaluate("([s, n, o]) => T.caret(s, n, o)", [scope, needle, off])
        self.page.keyboard.type(typed)
        got = self.out()
        after_struct = self.page.evaluate("mdv.qe.structure()")
        texts = self.page.evaluate("mdv.qe.leafTexts()")
        reparsed = self.page.evaluate("(t) => mdv.qe.buildModel(t).skel.filter(x => !/^[LKC]:/.test(x))", self.page.evaluate("mdv.qe.src"))
        p, ea, eb = diff_window(before, got)
        lo = before.index(ctx)
        local = lo <= p and ea <= lo + len(ctx)
        ok = got != before and before_struct == after_struct == reparsed and any(shown in t for t in texts) and local
        detail = "" if ok else (f"struct same={before_struct == reparsed} shown={any(shown in t for t in texts)} "
                                f"local={local} new={got[p:eb]!r}")
        self.check(f"2 {fixture}: {label} -> source {got[p:eb]!r}", ok, detail)

    # 3. blocked actions leave the source byte-identical
    def blocked(self, fixture, label, setup, keys):
        self.load(fixture)
        before = FIXTURES[fixture]
        if not self.page.evaluate(setup):
            return self.check(f"3 {fixture}: {label}", False, "setup failed")
        for k in keys:
            self.page.keyboard.press(k)
        got = self.out()
        self.check(f"3 {fixture}: {label} (reason: {self.page.evaluate('mdv.qe.lastBlock') or '-'})", got == before,
                   first_diff(got, before) if got != before else "")


NARROW_JS = r"""(() => {
  const c = document.getElementById('refuse');
  const note = document.getElementById('note');
  if (!c.classList.contains('on')) return { where: note.classList.contains('msg') ? 'strip' : 'none' };
  const r = c.getBoundingClientRect();
  let covers = false;
  const w = document.createTreeWalker(document.getElementById('page'), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n && !covers; n = w.nextNode()) {
    if (!n.data.trim()) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    for (const t of rg.getClientRects()) if (t.right > r.left && t.left < r.right && t.bottom > r.top && t.top < r.bottom) { covers = true; break; }
  }
  const where = ['side', 'above', 'below'].find((k) => c.classList.contains(k)) || '?';
  const notch = getComputedStyle(c, '::before').content !== 'none';
  return { where, covers, notch };
})()"""


VOID_JS = ("(() => { const sc = document.getElementById('scroller'); return { scroll: sc.scrollTop,"
           " rawTop: document.getElementById('raw').getBoundingClientRect().top - sc.getBoundingClientRect().top,"
           " pad: parseFloat(getComputedStyle(document.getElementById('sheet')).paddingTop) }; })()")
QY_JS = "(() => getSelection().getRangeAt(0).getBoundingClientRect().top - document.getElementById('scroller').getBoundingClientRect().top)()"
RY_JS = ("(() => { const r = document.getElementById('raw'); return r.getBoundingClientRect().top + mdv.qe.rawY(r.selectionStart)"
         " - document.getElementById('scroller').getBoundingClientRect().top; })()")


ALIGN_JS = r"""(() => {
  const raw = document.getElementById('raw'), pre = document.getElementById('rawhl');
  const v = raw.value;
  const textOk = pre.textContent === v;
  // a few offsets spread through the file, each at a line start: the pre and the textarea-metric mirror
  // must agree up to one constant (glyph box vs line box), so no line may drift
  const offs = [];
  for (let i = 0, k = 0; i < v.length && offs.length < 12; i = v.indexOf('\n', i) + 1, k++) {
    if (k % 7 === 0) offs.push(i);
    if (v.indexOf('\n', i) < 0) break;
  }
  const d = offs.map((o) => mdv.qe.hlY(o) - mdv.qe.rawY(o));
  const drift = Math.max(...d) - Math.min(...d);
  return { textOk, drift, dims: pre.querySelectorAll('.m').length };
})()"""


CHIP_JS = r"""(() => {
      const c = document.getElementById('refuse');
      if (!c.classList.contains('on')) return null;
      const r = c.getBoundingClientRect();
      const sel = getSelection().getRangeAt(0).getBoundingClientRect();
      const col = document.getElementById('sheet').getBoundingClientRect();
      const kind = ['side', 'above', 'below'].find((k) => c.classList.contains(k)) || '';
      return { text: c.textContent.replace(/\s+/g, ' ').trim(), left: r.left, colRight: col.right, kind,
               overCaret: !(r.bottom <= sel.top || r.top >= sel.bottom || r.right <= sel.left || r.left >= sel.right) };
    })()"""


def run_suite(page, variant):
    s = Suite(page, variant)
    P = "#page > .b > p"
    page.evaluate("mdv.qe.selfCheck = true")

    # ---- 1. word edits (sample.md) ----
    s.word("sample.md", "paragraph word", P, "paragraph", "sentence", "A paragraph with", "A sentence with")
    s.word("sample.md", "heading word", "#page h1", "render", "rendering", "# Markdown render test", "# Markdown rendering test")
    s.word("sample.md", "bold run", "#page strong", "bold", "heavy", "**bold**", "**heavy**")
    s.word("sample.md", "italic run", "#page em", "italic", "slanted", "*italic*", "*slanted*")
    s.word("sample.md", "link text", "#page a[href^='https']", "link", "site", "[link](https://example.com)", "[site](https://example.com)")
    s.word("sample.md", "inline code", "#page p code", "inline", "mono", "`inline code`", "`mono code`")
    s.word("sample.md", "table cell", "#page td", "Widget", "Gizmo", "| Widget A |", "| Gizmo A |")
    s.word("sample.md", "table number", "#page td", "92", "95", "| 92% |", "| 95% |")
    s.word("sample.md", "code block body", "#page pre", "hello", "greet", "def hello(name):", "def greet(name):")
    s.word("sample.md", "nested list item", "#page li li", "Nested", "Deep", "  - Nested bullet", "  - Deep bullet")
    s.word("sample.md", "task item text", "#page li", "not done", "pending", "- [ ] Task not done", "- [ ] Task pending")
    s.word("sample.md", "blockquote", "#page blockquote", "blockquote", "quoted", "> A blockquote line.", "> A quoted line.")
    s.word("sample.md", "space extends bold (deferred whitespace)", "#page strong", "bold", " heavy", "**bold**", "**bold heavy**", start=4, length=0)
    s.word("sample.md", "last heading (end of file)", "#page h4", "Heading", "Title", "#### Heading 4", "#### Title 4")
    # ---- 1. long.md ----
    s.word("long.md", "paragraph word", P, "small", "tiny", "A small markdown", "A tiny markdown")
    s.word("long.md", "heading", "#page h2", "Use", "Usage", "## Use\r\n", "## Usage\r\n")
    s.word("long.md", "table cell", "#page td", "Open", "Load", "| Open |", "| Load |")
    s.word("long.md", "inline code in cell", "#page td code", "Ctrl+O", "Ctrl+P", "or `Ctrl+O` |", "or `Ctrl+P` |")
    s.word("long.md", "ordered list item", "#page ol li", "hosted", "served", "1. Open the hosted page", "1. Open the served page")
    s.word("long.md", "bold in list", "#page li strong", "MD Viewer", "MDV", "> **MD Viewer** >", "> **MDV** >")
    s.word("long.md", "list continuation line", "#page ol li", "offers", "allows", "if Edge offers it.", "if Edge allows it.")
    s.word("long.md", "bullet wrapped line", "#page ul li", "normal", "plain", "in a normal tab:", "in a plain tab:")
    # ---- 1. edge cases ----
    s.word("edge.md", "text beside an entity", P, "Jerry", "Spike", "Tom &amp; Jerry", "Tom &amp; Spike")
    s.word("edge.md", "blockquote 2nd line", "#page blockquote", "two", "2", "> quote line two", "> quote line 2")
    s.word("edge.md", "cell with escaped pipe", "#page td", "y", "w", "| x \\| y |", "| x \\| w |")
    s.word("edge.md", "reference link text", "#page a", "Ref", "Reference", "[Ref text][r1]", "[Reference text][r1]")
    s.word("edge.md", "code inside list item", "#page li pre", "a", "b", "   let a = 1;", "   let b = 1;")
    s.word("edge.md", "list lazy line", "#page li", "continued", "wrapped", "  continued line", "  wrapped line")

    # ---- 2. typed syntax is escaped ----
    s.syntax("sample.md", "*emphasis* typed around a word", P, "with", 0, "*new* ", "*new* with", "A paragraph with **bold**")
    s.syntax("sample.md", "pipe in a table cell", "#page td", "Widget A", 8, " | B", "Widget A | B", "| Widget A |")
    s.syntax("sample.md", "'# ' at paragraph start", P, "A paragraph", 0, "# ", "# A paragraph", "A paragraph with")
    s.syntax("sample.md", "'- ' at blockquote start", "#page blockquote", "A blockquote", 0, "- ", "- A blockquote", "> A blockquote")
    s.syntax("sample.md", "'1. ' at paragraph start", P, "A paragraph", 0, "1. ", "1. A paragraph", "A paragraph with")
    s.syntax("sample.md", "[x](y) typed as text", P, "and a", 0, "[x](y) ", "[x](y) and", "`inline code` and a")
    s.syntax("sample.md", "<b> typed as text", P, "and a", 0, "<b>", "<b>and", "`inline code` and a")
    s.syntax("long.md", "pipe in long.md cell", "#page td", "Open", 4, "|Close", "Open|Close", "| Open |")
    s.syntax("long.md", "trailing ' #' on a heading", "#page h2", "Use", 3, " #1", "Use #1", "## Use")
    s.syntax("edge.md", "'[r1]' typed beside a reference (needs the document's defs)", P, "see", 0, "[r1] ", "[r1] see", "<kbd>Ctrl</kbd> see")
    s.blocked("sample.md", "backtick inside inline code", "T.caret('#page p code', 'inline', 3)", ["`"])

    # ---- 3. structure guards ----
    # a refusal shows its hint (words only the first two times per reason, so this runs first) and the outline flash
    s.load("sample.md")
    page.evaluate("T.caret('#page > .b > p', 'paragraph', 4)")
    page.keyboard.press("Enter")
    chip = page.evaluate(CHIP_JS)
    pulse = page.evaluate("""(() => { const o = document.getElementById('ov-deny'); const p = document.querySelector('#page > .b > p').getBoundingClientRect();
        const r = o.getBoundingClientRect(); return o.getAnimations().length > 0 && r.top <= p.top && r.bottom >= p.bottom && r.width >= p.width; })()""")
    s.check("3 refused Enter: chip beside the block, in the margin, not over the caret, with 'Open in Raw'",
            bool(chip) and "New lines and blocks live in Raw." in chip["text"] and "Open in Raw" in chip["text"]
            # the column now stretches with the window, so with no right margin free the chip sits above/below the block
            and (chip["left"] >= chip["colRight"] or chip["kind"] in ("above", "below")) and not chip["overCaret"], str(chip))
    s.check("3 refused Enter: the whole block pulses (outline covers the paragraph)", pulse)
    page.keyboard.press("Escape")
    s.check("3 Esc dismisses the chip", page.evaluate("!document.getElementById('refuse').classList.contains('on')"))
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    chip3 = page.evaluate(CHIP_JS)
    s.check("3 third refusal of the same kind: short form, still with 'Open in Raw'",
            bool(chip3) and chip3["text"].startswith("Not in Quick edit.") and "Open in Raw" in chip3["text"], str(chip3))
    if chip3:
        page.click("#refuse-raw", timeout=2000)
    s.wait_mode("raw")
    s.check("3 'Open in Raw' opens Raw at the caret", page.evaluate("mdv.qe.mode") == "raw"
            and page.evaluate("mdv.qe.rawCaret()") == FIXTURES["sample.md"].lstrip(BOM).replace("\r\n", "\n").index("paragraph") + 4)
    page.keyboard.press("Control+e")
    s.wait_mode("quick")

    s.blocked("sample.md", "Enter in a paragraph", "T.caret('#page > .b > p', 'paragraph', 4)", ["Enter"])
    s.blocked("sample.md", "Shift+Enter in a heading", "T.caret('#page h1', 'render', 2)", ["Shift+Enter"])
    s.blocked("sample.md", "Enter in a table cell", "T.caret('#page td', 'Widget', 2)", ["Enter"])
    s.blocked("sample.md", "Backspace at start of bold", "T.caret('#page strong', 'bold', 0)", ["Backspace"])
    s.blocked("sample.md", "Delete at end of link text", "T.caret('#page a', 'link', 4)", ["Delete"])
    s.blocked("sample.md", "Backspace at start of list item", "T.caret('#page li', 'Bullet one', 0)", ["Backspace"])
    s.blocked("sample.md", "Backspace at start of a table cell", "T.caret('#page td', 'Gadget', 0)", ["Backspace"])
    s.blocked("sample.md", "Backspace on selection text->bold", "T.selectAcross('#page > .b > p', 'with ', 2, 'bold', 2)", ["Backspace"])
    s.blocked("sample.md", "typing over selection text->bold", "T.selectAcross('#page > .b > p', 'with ', 2, 'bold', 2)", ["x"])
    s.blocked("sample.md", "Ctrl+B (format)", "T.select('#page > .b > p', 'paragraph')", ["Control+b"])
    s.blocked("sample.md", "Backspace empties bold", "T.select('#page strong', 'bold')", ["Backspace"])
    s.blocked("sample.md", "Ctrl+Backspace at start of italic", "T.caret('#page em', 'italic', 0)", ["Control+Backspace"])
    s.blocked("long.md", "Enter in long.md paragraph", "T.caret('#page > .b > p', 'viewer', 3)", ["Enter"])
    s.blocked("long.md", "Backspace at start of bold", "T.caret('#page li strong', 'MD Viewer', 0)", ["Backspace"])
    s.blocked("edge.md", "typing into an autolink", "T.caret('#page a', 'x.org', 1)", ["z"])
    s.blocked("edge.md", "typing into a [shortcut] reference", "T.caret('#page a', 'short', 2)", ["z"])
    # Enter inside a code block is allowed and inserts exactly one newline
    s.load("sample.md")
    placed = page.evaluate("T.caret('#page pre', '):', 2)")  # hljs splits "(name):" across spans
    page.keyboard.press("Enter")
    got = s.out()
    want = FIXTURES["sample.md"].replace("def hello(name):\r\n", "def hello(name):\r\n\r\n")
    s.check("3 sample.md: Enter in code block inserts one newline", placed and got == want,
            "caret not placed" if not placed else (first_diff(got, want) if got != want else ""))
    s.load("sample.md")
    page.evaluate("T.caret('#page > .b > p', 'with ', 5)")
    page.keyboard.press("Control+Backspace")
    got = s.out()
    want = FIXTURES["sample.md"].replace("A paragraph with **bold**", "A paragraph **bold**")
    s.check("3 sample.md: Ctrl+Backspace deletes one word inside the run", got == want, first_diff(got, want) if got != want else "")
    s.load("edge.md")
    page.evaluate("T.caret('#page > .b > p', ' Jerry', 0)")
    page.keyboard.press("Backspace")
    got = s.out()
    want = FIXTURES["edge.md"].replace("Tom &amp; Jerry", "Tom  Jerry")
    s.check("3 edge.md: Backspace after '&' deletes the whole &amp;", got == want, first_diff(got, want) if got != want else "")

    # ---- 3b. narrow window: the refusal chip never covers text (or falls back to the strip) ----
    page.set_viewport_size({"width": 900, "height": 900})
    for fixture, scope, needle, label in (("sample.md", "#page > .b > p", "paragraph", "paragraph under the title"),
                                           ("long.md", "#page > .b > p", "Saving keeps", "paragraph under a table"),
                                           ("long.md", "#page ol li", "Edge asks", "list item")):
        s.load(fixture)
        page.evaluate("([sc, n]) => T.caret(sc, n, 3)", [scope, needle])
        page.keyboard.press("Enter")
        res = page.evaluate(NARROW_JS)
        s.check(f"3b 900 px, {label}: refusal shown {res['where']}, never over text (a chip carries a notch)",
                res["where"] == "strip" or (res["where"] in ("side", "above", "below") and res.get("notch") and not res.get("covers")), str(res))
        page.keyboard.press("Escape")
    page.set_viewport_size({"width": 1200, "height": 900})

    # ---- 4. task checkbox ----
    s.load("sample.md")
    page.click("#page input[data-box='0']")
    got1 = s.out()
    page.click("#page input[data-box='1']")
    got2 = s.out()
    before = FIXTURES["sample.md"]
    want1 = before.replace("- [ ] Task not done", "- [x] Task not done")
    want2 = want1.replace("- [x] Task done", "- [ ] Task done")
    p, ea, eb = diff_window(before, got1)
    s.check("4 sample.md: click box 0 flips '[ ]' -> '[x]' (1 byte)", got1 == want1 and ea - p == 1 and eb - p == 1, first_diff(got1, want1))
    s.check("4 sample.md: click box 1 flips '[x]' -> '[ ]'", got2 == want2, first_diff(got2, want2))
    page.click("#page input[data-box='0']")
    page.click("#page input[data-box='1']")
    s.check("4 sample.md: toggling both back restores the file byte-for-byte", s.out() == before)
    checked = page.evaluate("[...document.querySelectorAll('#page input[data-box]')].map(b => b.checked)")
    s.check("4 sample.md: rendered boxes match the source", checked == [False, True], str(checked))
    s.load("sample.md")
    page.evaluate("T.caret('#page li', 'Task not done', 2)")
    page.keyboard.press("Control+Enter")
    s.check("4 sample.md: Ctrl+Enter in a task item toggles it", s.out() == want1, first_diff(s.out(), want1))

    # ---- 5. undo / redo ----
    s.load("sample.md")
    page.evaluate("T.select('#page > .b > p', 'paragraph')")
    page.keyboard.type("sentence")
    page.evaluate("T.select('#page td', 'Widget')")
    page.keyboard.type("Gizmo")
    page.click("#page input[data-box='0']")
    edited = s.out()
    want_edits = before.replace("A paragraph with", "A sentence with").replace("| Widget A |", "| Gizmo A |").replace("- [ ] Task not done", "- [x] Task not done")
    s.check("5 sample.md: three edits in three blocks give exactly those bytes", edited == want_edits, first_diff(edited, want_edits))
    page.evaluate("document.getElementById('page').focus()")
    for _ in range(3):
        page.keyboard.press("Control+z")
    s.check("5 sample.md: 3x Ctrl+Z restores the original bytes", s.out() == before, first_diff(s.out(), before))
    for _ in range(3):
        page.keyboard.press("Control+y")
    s.check("5 sample.md: 3x Ctrl+Y re-applies all edits", s.out() == edited, first_diff(s.out(), edited))
    # one undo stack across Quick and Raw
    s.load("sample.md")
    page.evaluate("T.select('#page > .b > p', 'paragraph')")
    page.keyboard.type("sentence")
    page.keyboard.press("Control+e")
    s.wait_mode("raw")
    page.keyboard.press("End")
    page.keyboard.type(" Raw")
    mixed = s.out()
    page.keyboard.press("Control+z")
    page.keyboard.press("Control+z")
    s.check("5 sample.md: Ctrl+Z in Raw undoes the Raw edit, then the Quick edit",
            mixed != before and s.out() == before, first_diff(s.out(), before))
    page.keyboard.press("Control+e")
    s.wait_mode("quick")

    # ---- 6. Quick Edit <-> Raw keep the place ----
    s.load("sample.md")
    src = page.evaluate("mdv.qe.src")
    page.evaluate("T.caret('#page td', 'Widget A', 3)")
    page.keyboard.press("Control+e")
    s.wait_mode("raw")
    s.check("6 Ctrl+E opens Raw with the caret on the same source offset",
            page.evaluate("mdv.qe.mode") == "raw" and page.evaluate("mdv.qe.rawCaret()") == src.index("Widget A") + 3,
            f"{page.evaluate('mdv.qe.rawCaret()')} vs {src.index('Widget A') + 3}")
    s.check("6 Raw marks the arrival block with the band", page.evaluate("document.getElementById('ov-band').getAnimations().length > 0"))
    al = page.evaluate(ALIGN_JS)
    s.check("6 Raw syntax mirror: same text as the textarea, no line drift, punctuation dimmed",
            al["textOk"] and al["drift"] <= 1 and al["dims"] > 20, str(al))
    page.keyboard.type(" wide wide wide wide wide wide wide wide wide wide wide wide wide wide")
    page.keyboard.press("Enter")
    page.keyboard.type("## new")
    page.keyboard.press("Backspace")
    al = page.evaluate(ALIGN_JS)
    s.check("6 Raw syntax mirror stays aligned after edits (wrap, new line, delete)", al["textOk"] and al["drift"] <= 1, str(al))
    page.evaluate("document.getElementById('scroller').scrollTop = 400")
    page.wait_for_timeout(100)
    al = page.evaluate(ALIGN_JS)
    s.check("6 Raw syntax mirror stays aligned after a scroll", al["textOk"] and al["drift"] <= 1, str(al))
    for _ in range(3):
        page.keyboard.press("Control+z")
    s.check("6 Raw undo restores the file and the mirror follows",
            s.out() == before and page.evaluate("document.getElementById('rawhl').textContent === document.getElementById('raw').value"))
    page.evaluate(f"(() => {{ const r = document.getElementById('raw'); r.setSelectionRange({src.index('Widget A') + 3}, {src.index('Widget A') + 3}); }})()")
    target = src.index("Gadget B") + 2
    page.evaluate(f"(() => {{ const r = document.getElementById('raw'); r.setSelectionRange({target}, {target}); }})()")
    page.keyboard.press("Control+e")
    s.wait_mode("quick")
    s.check("6 Ctrl+E back to Quick Edit lands on the same source offset",
            page.evaluate("mdv.qe.mode") == "quick" and page.evaluate("mdv.qe.caretSource()") == target,
            f"{page.evaluate('mdv.qe.caretSource()')} vs {target}")
    s.check("6 the round trip changed nothing", s.out() == before)

    # ---- 6b. the caret line stays at the same viewport y across both switches ----
    def pin_round_trip(fixture_text, scope, needle, nth, label, scroll_to_mid, near_top):
        page.evaluate("([n, t]) => mdv.loadText(n, t, null)", ["pin.md", fixture_text])
        page.evaluate(HELPERS)
        if not page.evaluate("([s, n, i]) => T.caret(s, n, 2, i)", [scope, needle, nth]):
            return s.check(f"6b {label}: caret placed", False)
        if scroll_to_mid:
            page.evaluate("getSelection().getRangeAt(0).startContainer.parentElement.scrollIntoView({ block: 'center' })")
        page.wait_for_timeout(300)   # let the 180 ms open rise settle: the reader sees the settled page
        qy = page.evaluate(QY_JS)
        page.keyboard.press("Control+e")
        slid = False
        if near_top:
            try:
                slid = bool(page.wait_for_function(
                    "document.getAnimations().some((a) => a.animationName === 'vt-shift') || null", timeout=1500).json_value())
            except Exception:
                slid = False
        s.wait_mode("raw")
        page.wait_for_timeout(250)
        ry = page.evaluate(RY_JS)
        shift = page.evaluate("mdv.qe.lastPinShift")
        if near_top:
            void = page.evaluate(VOID_JS)
            s.check(f"6b {label}: Raw near the top has no blank band above line 1 (line 1 at the normal top padding)",
                    void["scroll"] == 0 and abs(void["rawTop"] - void["pad"]) <= 1, str(void))
            s.check(f"6b {label}: the incoming layer starts with the caret line at its old y ({qy:.1f} vs {ry:.1f} + slide {shift:.1f})"
                    " and slides to rest", slid and shift > 0 and abs(ry + shift - qy) <= 2)
        else:
            s.check(f"6b {label}: Quick -> Raw keeps the caret line at the same y by scrolling ({qy:.1f} -> {ry:.1f})",
                    abs(qy - ry) <= 2 and shift == 0, f"shift {shift}")
        page.keyboard.press("ArrowDown")
        ry2 = page.evaluate(RY_JS)
        page.keyboard.press("Control+e")
        s.wait_mode("quick")
        page.wait_for_timeout(250)
        qy2 = page.evaluate(QY_JS)
        s.check(f"6b {label}: Raw -> Quick keeps the caret line at the same y ({ry2:.1f} -> {qy2:.1f})", abs(qy2 - ry2) <= 2)

    pin_round_trip(FIXTURES["sample.md"], "#page td", "Widget A", 0, "sample.md near the top", False, True)
    pin_round_trip(FIXTURES["long.md"].lstrip(BOM) * 3, "#page ol li", "Edge asks", 1, "long.md x3, a list 3 screens down", True, False)

    # ---- 7. paste, drop, IME ----
    s.load("sample.md")
    page.evaluate("T.select('#page > .b > p', 'paragraph')")
    page.evaluate("navigator.clipboard.writeText('**rich**\\nsecond line')")
    page.keyboard.press("Control+v")
    got = s.out()
    p, ea, eb = diff_window(before, got)
    struct_same = page.evaluate("mdv.qe.structure()") == page.evaluate("mdv.qe.buildModel(mdv.qe.src).skel.filter(x => !/^[LKC]:/.test(x))")
    texts = page.evaluate("mdv.qe.leafTexts()")
    s.check(f"7 paste (real Ctrl+V) lands as plain text, newline -> space: {got[p:eb]!r}",
            struct_same and any("**rich** second line with" in t for t in texts), str(texts[:2]))
    s.load("sample.md")
    page.evaluate("T.caret('#page > .b > p', 'paragraph', 2)")
    prevented = page.evaluate("T.beforeinput('insertFromDrop', 'dropped')")
    s.check("7 drop of text into the page is blocked (synthetic beforeinput)", prevented and s.out() == before)
    s.load("sample.md")
    page.evaluate("T.caret('#page > .b > p', 'paragraph', 9)")
    cdp = page.context.new_cdp_session(page)
    try:
        cdp.send("Input.imeSetComposition", {"text": "k", "selectionStart": 1, "selectionEnd": 1})
        cdp.send("Input.imeSetComposition", {"text": "か", "selectionStart": 1, "selectionEnd": 1})
        cdp.send("Input.insertText", {"text": "か"})
        page.wait_for_timeout(80)
        want = before.replace("A paragraph with", "A paragraphか with")
        s.check("7 IME composition (CDP imeSetComposition) commits one edit", s.out() == want, first_diff(s.out(), want))
    except Exception as exc:  # CDP method missing on this build
        s.check("7 IME composition (CDP) - not testable here", False, str(exc))

    # ---- 8. keyboard: Tab between pieces, Esc leaves the text ----
    s.load("sample.md")
    page.evaluate("T.caret('#page h1', 'render', 2)")
    page.keyboard.press("Tab")
    page.keyboard.type("Q")
    want = before.replace("A paragraph with **bold**", "A paragraph with Q**bold**")
    s.check("8 Tab moves to the next piece (end of the paragraph's first run)", s.out() == want, first_diff(s.out(), want))
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    page.keyboard.type("zz")
    s.check("8 Esc drops the caret: typing afterwards changes nothing", s.out() == want, first_diff(s.out(), want))

    # ---- 9. engine integrity ----
    s.check("9 sanitised render: no script ran", page.evaluate("window.__xss === undefined"))
    stats = page.evaluate("mdv.qe.stats")
    s.check(f"9 every block patch matched a full rebuild ({stats['selfChecks']} compared, {stats['fast']} fast plans)",
            stats["selfChecks"] > 50 and stats["selfCheckFail"] == 0, str(stats))
    return s.results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    args = ap.parse_args()
    variants = [args.only] if args.only else list(VARIANTS)

    server = serve()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    summary = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for variant in variants:
            ctx = browser.new_context(viewport={"width": 1200, "height": 900}, permissions=["clipboard-read", "clipboard-write"],
                                      service_workers="block")  # a worker would serve cached, unbroken files
            install_variant(ctx, variant)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and not (m.location.get("url") or "").endswith("/x") else None)
            page.goto(base)
            page.wait_for_load_state("networkidle")
            print(f"\n=== variant: {variant} ===")
            results = run_suite(page, variant)
            fails = [r for r in results if not r[1]]
            summary[variant] = (len(results), len(fails), errors)
            if errors:
                print("  page errors:", errors[:5])
            ctx.close()
        browser.close()
    server.shutdown()

    print("\n=== summary ===")
    ok = True
    for variant, (n, f, errs) in summary.items():
        expect = "all pass" if variant == "good" else "must fail >= 1"
        good = (f == 0 and not errs) if variant == "good" else f >= 1
        ok &= good
        print(f"  {variant:9s} {n - f}/{n} passed, {f} failed   [{expect}: {'OK' if good else 'NOT OK'}]")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
