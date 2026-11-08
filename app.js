// just.MD v2 - "Quiet Locked Page". The rendered page is the editor (Quick Edit); markdown structure
// stays put and every keystroke lands on the exact source characters. Ctrl+E opens the whole raw file
// at the same place. Plain script, no build step; libraries are vendored in ./vendor (pinned).
//
// Sections: state - Quick surface (render, selection, edits, refusals) - history - Raw / Split and
// place-keeping - modes - strip (status, save check, tools) - overlays - palette - theme - I/O - wiring.

"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  html: document.documentElement,
  strip: $("strip"), mark: $("mark"), name: $("name"), status: $("status"), note: $("note"), btnSave: $("btn-save"), btnSaveAs: $("btn-saveas"),
  pill: $("pill"), copyAll: $("btn-copy-all"),
  more: $("btn-more"), tip: $("tip"), btnOpen: $("btn-open"),
  scroller: $("scroller"), sheet: $("sheet"), page: $("page"), raw: $("raw"), rawhl: $("rawhl"), mirror: $("mirror"),
  ovHover: $("ov-hover"), ovCaret: $("ov-caret"), ovWash: $("ov-wash"), ovDeny: $("ov-deny"),
  ovBand: $("ov-band"), ovLine: $("ov-line"), ovChip: $("ov-chip"),
  refuse: $("refuse"), refuseText: $("refuse-text"), refuseRaw: $("refuse-raw"),
  palette: $("palette"), paletteInput: $("palette-input"), paletteList: $("palette-list"),
  stamp: $("stamp"), themeMeta: $("theme-color"), btnTheme: $("btn-theme"), themeSw: $("theme-sw"),
};

const EASE = "cubic-bezier(.2,.8,.2,1)";
const LARGE = 300 * 1024;          // above this a file opens in Raw
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const reduced = () => reducedQuery.matches;

// Everything we know about the open file.
const doc = {
  handle: null,      // FileSystemFileHandle when we can write back in place
  name: null,
  savedText: "",     // last saved content, LF-normalised
  eol: "\n",         // original line ending, restored on save
  bom: false,        // original file started with a UTF-8 BOM
  loaded: false,
};

const state = {
  src: "",           // the one source string (LF); Quick and Raw both edit it
  model: null,       // Engine model of src (stale while Raw has edits not yet seen by Quick)
  modelStale: true,
  mode: "quick",     // quick | raw | split
  pending: null,     // deferred whitespace: { leaf, d, text }
  composing: null,
  rendering: false,
  lastBlock: "",
  blockCount: 0,
  hintSeen: {},
  saving: false,
  saveError: false,
  notice: "",        // transient status (open errors)
  large: false,
  perf: [],          // ms per Quick keystroke (handler start -> DOM patched, caret placed)
  rawPerf: [],       // ms per Raw input event (source update + syntax mirror sync)
  hlPerf: [],        // ms per Raw syntax pass over the visible chunks (scroll)
  saveErrorReason: "",
};

const MD_TYPES = [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown", ".mdown", ".mkd", ".txt"] } }];
const hasFileApi = "showOpenFilePicker" in window;

// ====================================================================================================
// Quick surface: rendering
// ====================================================================================================

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}

function headingIds() {
  const seen = new Map();
  els.page.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    const slug = slugify(h.textContent);
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    h.id = n ? `${slug}-${n}` : slug;
  });
}

const OWN_STOP = /^(UL|OL|P|PRE|BLOCKQUOTE|TABLE|H[1-6]|DIV|HR)$/;
// A list item's own text gets a box of its own, so cues mark that item and not its nested list.
function wrapOwn(li) {
  if (li.firstElementChild && li.firstElementChild.classList.contains("own")) return;
  const own = document.createElement("span");
  own.className = "own";
  while (li.firstChild && !(li.firstChild.nodeType === 1 && OWN_STOP.test(li.firstChild.tagName))) own.appendChild(li.firstChild);
  if (own.childNodes.length) li.insertBefore(own, li.firstChild);
}

function decorate(w) {
  w.querySelectorAll(".qe-a, img, hr, input").forEach((el) => el.setAttribute("contenteditable", "false"));
  w.querySelectorAll("li").forEach(wrapOwn);
  w.querySelectorAll("a").forEach((a) => {
    if (!a.querySelector(".qe-r")) { a.classList.add("frozen-inline"); a.setAttribute("contenteditable", "false"); }
  });
  if (w.firstChild && !w.querySelector(".qe-r") && !w.querySelector("input[data-box]")) {
    w.setAttribute("contenteditable", "false");
    w.classList.add("frozen");
  }
}

const observer = new MutationObserver(() => {
  // Safety net: the DOM is derived from the source. Any mutation we did not make is undone.
  if (state.rendering || state.composing || state.mode !== "quick" || !state.model) return;
  console.warn("[mdv] stray DOM mutation, re-rendering from source");
  renderAll(selPoint());
});

function renderAll(caret) {
  if (!state.model) return;
  pendingPatch = null; // a full render supersedes any queued block patch
  state.rendering = true;
  const m = state.model;
  els.page.innerHTML = DOMPurify.sanitize(Engine.blocksHtml(m, 0, m.blocks.length - 1));
  for (const w of els.page.children) decorate(w);
  headingIds();
  observer.takeRecords();
  state.rendering = false;
  if (caret) setCaret(caret);
  scheduleOverlays();
}

// Replace just the wrappers of top-level blocks i0..i1 (one wrapper per token, same count).
function patchBlocks(i0, i1) {
  state.rendering = true;
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(Engine.blocksHtml(state.model, i0, i1));
  const fresh = [...tpl.content.children];
  let headings = false;
  for (let k = 0; k < fresh.length; k++) {
    const old = els.page.children[i0 + k];
    decorate(fresh[k]);
    if (!headings && (fresh[k].querySelector("h1,h2,h3,h4,h5,h6"))) headings = true;
    if (old) els.page.replaceChild(fresh[k], old); else els.page.appendChild(fresh[k]);
  }
  if (headings) headingIds();
  observer.takeRecords();
  state.rendering = false;
}

function ensureModel() {
  if (state.modelStale || !state.model) {
    state.model = Engine.buildModel(state.src);
    state.modelStale = false;
    renderAll();
  }
}

// ====================================================================================================
// Quick surface: DOM selection <-> (leaf, display offset)
// ====================================================================================================

function segLen(seg) { return seg.classList.contains("qe-r") ? seg.textContent.length : +seg.dataset.dl; }
// Characters of a run that lie before the boundary point (node, off); works inside highlight.js spans.
function textOffsetWithin(seg, node, off) {
  const r = document.createRange();
  r.setStart(seg, 0);
  r.setEnd(node, off);
  return r.toString().length;
}

function domToPoint(node, off) {
  if (!node || !els.page.contains(node)) return null;
  const el = node.nodeType === 3 ? node.parentElement : node;
  const seg = el.closest(".qe-r, .qe-a");
  if (seg && els.page.contains(seg)) {
    const leaf = +seg.dataset.l;
    if (seg.classList.contains("qe-a")) return { leaf, d: +seg.dataset.d + (off > 0 ? +seg.dataset.dl : 0) };
    return { leaf, d: +seg.dataset.d + textOffsetWithin(seg, node, off) };
  }
  if (node.nodeType === 1) {
    const before = node.childNodes[off - 1];
    const after = node.childNodes[off];
    const b = before && (before.nodeType === 1 ? (before.matches(".qe-r,.qe-a") ? before : [...before.querySelectorAll(".qe-r,.qe-a")].pop()) : null);
    if (b) return { leaf: +b.dataset.l, d: +b.dataset.d + segLen(b) };
    const a = after && (after.nodeType === 1 ? (after.matches(".qe-r,.qe-a") ? after : after.querySelector(".qe-r,.qe-a")) : null);
    if (a) return { leaf: +a.dataset.l, d: +a.dataset.d };
  }
  return null;
}

function selPoints() {
  flushPatch();
  const sel = document.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const a = domToPoint(r.startContainer, r.startOffset);
  const b = r.collapsed ? a : domToPoint(r.endContainer, r.endOffset);
  return { a, b, collapsed: r.collapsed };
}
function selPoint() { const p = selPoints(); return p && p.a; }

// The DOM of one leaf lives inside its own top-level block wrapper; searching there keeps big files fast.
function leafScope(leafId) {
  const bi = state.model && !state.modelStale ? Engine.blockOfLeaf(state.model, leafId) : -1;
  return (bi >= 0 && els.page.children[bi]) || els.page;
}
function leafSegs(leafId) { return leafScope(leafId).querySelectorAll(`[data-l="${leafId}"]`); }

function pointToDom(pt) {
  const segs = [...leafSegs(pt.leaf)];
  for (const seg of segs) {
    if (!seg.classList.contains("qe-r")) continue;
    const d0 = +seg.dataset.d;
    const len = seg.textContent.length;
    if (d0 <= pt.d && pt.d <= d0 + len) {
      let k = pt.d - d0;
      const w = document.createTreeWalker(seg, NodeFilter.SHOW_TEXT);
      let last = null;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (k <= n.data.length) return { node: n, offset: k };
        k -= n.data.length;
        last = n;
      }
      if (last) return { node: last, offset: last.data.length };
    }
  }
  for (const seg of segs) {
    const d0 = +seg.dataset.d;
    const idx = [...seg.parentNode.childNodes].indexOf(seg);
    if (d0 === pt.d) return { node: seg.parentNode, offset: idx };
    if (d0 + segLen(seg) === pt.d) return { node: seg.parentNode, offset: idx + 1 };
  }
  return null;
}

function setCaret(pt) {
  if (!pt) return;
  const pos = pointToDom(pt);
  if (!pos) return;
  const sel = document.getSelection();
  const r = document.createRange();
  r.setStart(pos.node, pos.offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

function caretSource() {
  if (!state.model || state.modelStale) return -1;
  const p = selPoint();
  if (!p) return -1;
  return Engine.dToS(state.model.leaves[p.leaf], p.d);
}

function selectionInPage() {
  const sel = document.getSelection();
  return sel.rangeCount > 0 && els.page.contains(sel.getRangeAt(0).startContainer);
}

function caretRect() {
  const sel = document.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  let r = range.getBoundingClientRect();
  if (!r.width && !r.height) {
    const n = range.startContainer;
    const el = n.nodeType === 3 ? n.parentElement : (n.childNodes[range.startOffset] || n);
    r = (el.nodeType === 1 ? el : el.parentElement).getBoundingClientRect();
  }
  return r;
}

// ====================================================================================================
// Quick surface: edit transactions
// ====================================================================================================

// The model and source change at once; the DOM patch and caret follow in a task of their own right
// after the input event. Inside a trusted beforeinput, Chromium makes "replace the caret's block, then
// set the selection" cost ~4 ms on a 100 KB page; one task later it costs ~2 ms. Anything that reads
// the DOM or the selection calls flushPatch() first, so the page is never read while out of step.
let pendingPatch = null;
const patchChannel = new MessageChannel();
patchChannel.port1.onmessage = () => flushPatch();

function flushPatch() {
  const q = pendingPatch;
  if (!q) return;
  pendingPatch = null;
  const t = performance.now();
  // if something moved the selection since the keystroke (a script, a fast click), keep that selection
  const sel = document.getSelection();
  const moved = sel.anchorNode !== q.selNode || sel.anchorOffset !== q.selOffset;
  patchBlocks(q.i0, q.i1);
  if (!moved || !sel.anchorNode || !sel.anchorNode.isConnected) setCaret(q.caret);
  edited();
  if (q.t0) logPerf(q.work + performance.now() - t);
}

function commitEdit(plan, leafId, kind) {
  history.record(state.src, caretSource(), kind, "q" + leafId);
  state.model = Engine.commit(state.model, plan);
  state.src = state.model.src;
  const caret = { leaf: leafId, d: plan.d };
  if (plan.full) {
    renderAll();
    setCaret(caret);
    edited();
    return;
  }
  const sel = document.getSelection();
  pendingPatch = { i0: plan.i0, i1: plan.i1, caret, t0: 0, work: 0, selNode: sel.anchorNode, selOffset: sel.anchorOffset };
  patchChannel.port2.postMessage(0);
}

function logPerf(ms) {
  state.perf.push(ms);
  if (state.perf.length > 2000) state.perf.splice(0, 1000);
}

// Replace the whole source (undo, redo, deliberately broken test variants): full rebuild.
function replaceSource(src, caret) {
  state.src = src;
  state.pending = null;
  if (state.mode === "quick") {
    state.model = Engine.buildModel(src);
    state.modelStale = false;
    renderAll();
    const pt = caret >= 0 ? Engine.pointForSource(state.model, caret) : null;
    if (pt) setCaret(pt);
  } else {
    els.raw.value = src;
    state.modelStale = true;
    syncRawHL();
    if (caret >= 0) els.raw.setSelectionRange(caret, caret);
    if (state.mode === "split") schedulePreview();
  }
  edited();
}

const HINTS = {
  enter: "New lines and blocks live in Raw.",
  boundary: "Edits stay inside one piece of text.",
  structure: "That would change the formatting.",
  frozen: "This part is markdown syntax.",
  format: "Formatting stays put in Quick edit.",
  drop: "Drag and drop is off on the page.",
  relative: "Relative links can't be followed - the app only sees this one file",
};
const SHORT_HINT = "Not in Quick edit.";

// A refused edit: the caret's whole block pulses gold, and a chip beside it (in the margin, covering no
// text) says why, with "Open in Raw". Full words the first two times per reason, a short form after.
function refuse(reason) {
  state.lastBlock = reason;
  state.blockCount++;
  state.hintSeen[reason] = (state.hintSeen[reason] || 0) + 1;
  const b = refusalBlock();
  if (!b) return;
  flashBlock(b);
  showRefusalChip(b, state.hintSeen[reason] > 2 ? SHORT_HINT : HINTS[reason] || HINTS.structure);
}

function insertAt(points, text, kind) {
  const { a, b } = points;
  if (!a || !b) return refuse("frozen");
  if (a.leaf !== b.leaf) return refuse("boundary");
  const leaf = state.model.leaves[a.leaf];
  let dA = Math.min(a.d, b.d), dB = Math.max(a.d, b.d);
  dA = Engine.snapToParts(leaf, dA, -1);
  dB = Engine.snapToParts(leaf, dB, 1);
  if (state.pending && state.pending.leaf === a.leaf && dA === dB) {
    text = state.pending.text + text;
    dA = dB = state.pending.d;
  }
  const hadPending = !!state.pending;
  state.pending = null;
  const plan = Engine.editLeaf(state.model, a.leaf, dA, dB, text);
  if (plan) return commitEdit(plan, a.leaf, kind);
  // Deferred whitespace: "bold" + " " would end the bold run, "bold" + " x" does not.
  if (/^\s+$/.test(text) && leaf.kind === "inline" && Engine.editLeaf(state.model, a.leaf, dA, dB, text + "x")) {
    if (hadPending) renderBlockOf(a.leaf);
    holdPending(a.leaf, dA, text);
    return;
  }
  if (hadPending) renderBlockOf(a.leaf);
  setCaret(a);
  refuse("structure");
}

function renderBlockOf(leafId) {
  const bi = Engine.blockOfLeaf(state.model, leafId);
  if (bi >= 0) patchBlocks(bi, bi); else renderAll();
}

function holdPending(leafId, d, text) {
  state.pending = { leaf: leafId, d, text };
  const pos = pointToDom({ leaf: leafId, d });
  if (!pos) { state.pending = null; return refuse("structure"); }
  state.rendering = true;
  let node = pos.node, at = pos.offset;
  if (node.nodeType === 3) {
    node.insertData(at, text);
    node.parentElement.classList.add("qe-pending");
  } else {
    // caret sits next to an atom (e.g. after "\|"): give the held space its own text node
    const span = document.createElement("span");
    span.className = "qe-pending";
    span.textContent = text;
    node.insertBefore(span, node.childNodes[at] || null);
    node = span.firstChild;
    at = 0;
  }
  observer.takeRecords();
  state.rendering = false;
  const r = document.createRange();
  r.setStart(node, at + text.length);
  r.collapse(true);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function dropPending() {
  if (!state.pending) return;
  const p = state.pending;
  state.pending = null;
  renderBlockOf(p.leaf);
  setCaret({ leaf: p.leaf, d: p.d });
}

function deleteAt(points, dir, word, targetRanges) {
  const { a, b, collapsed } = points;
  if (state.pending) { dropPending(); return; } // Backspace eats the held space
  if (!a || !b) return refuse("frozen");
  if (!collapsed) return insertAt(points, "", "delete");
  const leaf = state.model.leaves[a.leaf];
  let range;
  if (word && targetRanges && targetRanges[0]) {
    const tr = targetRanges[0];
    const s = domToPoint(tr.startContainer, tr.startOffset);
    const e = domToPoint(tr.endContainer, tr.endOffset);
    let dA = s && s.leaf === a.leaf ? s.d : 0;
    let dB = e && e.leaf === a.leaf ? e.d : Engine.leafLen(leaf);
    if (dir < 0) dB = a.d; else dA = a.d;
    range = dA < dB ? [dA, dB] : null;
  } else {
    range = dir < 0 ? Engine.unitBefore(leaf, a.d) : Engine.unitAfter(leaf, a.d);
  }
  if (!range) return refuse("boundary");
  const plan = Engine.editLeaf(state.model, a.leaf, range[0], range[1], "");
  if (plan) { plan.d = range[0]; return commitEdit(plan, a.leaf, "delete"); }
  setCaret(a);
  refuse("structure");
}

els.page.addEventListener("beforeinput", (e) => {
  if (state.mode !== "quick" || !state.model) { e.preventDefault(); return; }
  if (e.inputType === "insertCompositionText") return; // not cancelable; reconciled at compositionend
  e.preventDefault();
  flushPatch();
  const t0 = performance.now();
  handleInput(e);
  const work = performance.now() - t0;
  if (pendingPatch) { pendingPatch.t0 = t0; pendingPatch.work = work; } else logPerf(work);
});

function handleInput(e) {
  const t = e.inputType;
  if (t === "historyUndo") return undo();
  if (t === "historyRedo") return redo();
  // a held space is not in the model yet; the caret behind it means "the pending point"
  const held = state.pending && { leaf: state.pending.leaf, d: state.pending.d };
  const pts = held ? { a: held, b: held, collapsed: true } : selPoints();
  if (!pts) return refuse("frozen");
  const leaf = pts.a && state.model.leaves[pts.a.leaf];
  switch (t) {
    case "insertText":
    case "insertReplacementText": {
      let text = e.data;
      if (text == null && e.dataTransfer) text = e.dataTransfer.getData("text/plain");
      if (t === "insertReplacementText" && e.getTargetRanges()[0]) {
        const tr = e.getTargetRanges()[0];
        return insertAt({ a: domToPoint(tr.startContainer, tr.startOffset), b: domToPoint(tr.endContainer, tr.endOffset) }, text || "", "replace");
      }
      return insertAt(pts, text || "", "type");
    }
    case "insertFromPaste": {
      let text = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
      text = text.replace(/\r\n?/g, "\n");
      if (!leaf || leaf.kind !== "code") text = text.replace(/\s*\n\s*/g, " ");
      return insertAt(pts, text, "paste");
    }
    case "insertParagraph":
    case "insertLineBreak":
      if (leaf && leaf.kind === "code") return insertAt(pts, "\n", "type");
      return refuse("enter");
    case "deleteContentBackward": return deleteAt(pts, -1, false);
    case "deleteContentForward": return deleteAt(pts, 1, false);
    case "deleteWordBackward": case "deleteSoftLineBackward": case "deleteHardLineBackward":
      return deleteAt(pts, -1, true, e.getTargetRanges());
    case "deleteWordForward": case "deleteSoftLineForward": case "deleteHardLineForward":
      return deleteAt(pts, 1, true, e.getTargetRanges());
    case "deleteByCut": return pts.collapsed ? undefined : insertAt(pts, "", "delete");
    case "insertFromDrop": case "deleteByDrag": return refuse("drop");
    default:
      if (t.startsWith("format")) return refuse("format");
      return refuse("structure");
  }
}

els.page.addEventListener("dragstart", (e) => { if (state.mode === "quick") e.preventDefault(); });

// IME: let the browser draw the composition, then diff the page text and replay it as one edit.
function caretRootOffset() {
  const sel = document.getSelection();
  if (!sel.rangeCount) return -1;
  const r = document.createRange();
  r.setStart(els.page, 0);
  const s = sel.getRangeAt(0);
  r.setEnd(s.startContainer, s.startOffset);
  return r.toString().length;
}
els.page.addEventListener("compositionstart", () => {
  if (state.mode !== "quick") return;
  flushPatch();
  dropPending();
  state.composing = { pts: selPoints(), before: els.page.textContent, rootOffset: caretRootOffset() };
});
els.page.addEventListener("compositionend", () => {
  const c = state.composing;
  if (!c) return;
  // the composed text lands after this event; read it on the next task
  setTimeout(() => {
    state.composing = null;
    const after = els.page.textContent;
    const before = c.before;
    let p = 0;
    while (p < after.length && p < before.length && after[p] === before[p]) p++;
    let q = 0;
    while (q < after.length - p && q < before.length - p && after[after.length - 1 - q] === before[before.length - 1 - q]) q++;
    const inserted = after.slice(p, after.length - q);
    const removed = before.length - q - p;
    const pts = c.pts;
    observer.takeRecords();
    if (!pts || !pts.a || !pts.b || pts.a.leaf !== pts.b.leaf || c.rootOffset < 0) { renderAll(pts && pts.a); return refuse("frozen"); }
    const shift = p - c.rootOffset;
    const dA = Math.min(pts.a.d, pts.b.d) + Math.min(0, shift);
    const plan = Engine.editLeaf(state.model, pts.a.leaf, dA, dA + removed, inserted);
    if (plan) { renderAll(); commitEdit(plan, pts.a.leaf, "ime"); }
    else { renderAll(pts.a); refuse("structure"); }
  }, 0);
});

// Task boxes: a click (or Ctrl+Enter) flips exactly the one character between the brackets.
function toggleBox(index) {
  const plan = Engine.toggleBox(state.model, index);
  if (!plan) return refuse("structure");
  history.record(state.src, -1, "box", "box");
  state.model = Engine.commit(state.model, plan);
  state.src = state.model.src;
  if (plan.full) renderAll(); else patchBlocks(plan.i0, plan.i1);
  const box = els.page.querySelector(`input[data-box="${index}"]`);
  if (box && !reduced()) {
    box.animate([{ transform: "scale(.82)" }, { transform: "scale(1)" }], { duration: 160, easing: EASE });
  }
  edited();
}

els.page.addEventListener("click", (e) => {
  if (state.mode !== "quick") return;
  const box = e.target.closest && e.target.closest("input[data-box]");
  if (box) { e.preventDefault(); toggleBox(+box.dataset.box); return; }
  const a = e.target.closest && e.target.closest("a[href]");
  if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); followLink(a); }
});
els.page.addEventListener("mousedown", () => { flushPatch(); dropPending(); });

function followLink(a) {
  const href = a.getAttribute("href") || "";
  if (href.startsWith("#")) {
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    if (target) target.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
  } else if (/^(https?:|mailto:)/i.test(href)) {
    window.open(href, "_blank", "noopener");
  } else {
    showNoteMessage(HINTS.relative);
  }
}

// ---------- Quick keyboard ----------

els.page.addEventListener("keydown", (e) => {
  if (state.mode !== "quick" || !state.model) return;
  flushPatch();
  if (/^(Arrow|Home|End|Page|Escape)/.test(e.key) && state.pending) dropPending();
  const key = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey && key === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (e.ctrlKey && !e.altKey && key === "y") { e.preventDefault(); return redo(); }
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    const p = selPoint();
    const li = p && leafSegs(p.leaf)[0]?.closest("li");
    const box = li && li.querySelector(":scope > .own > input[data-box], :scope > input[data-box], :scope > p > input[data-box]");
    if (box) toggleBox(+box.dataset.box); else refuse("structure");
    return;
  }
  if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const p = selPoint();
    const leaves = Engine.editableLeaves(state.model);
    let i = p ? leaves.findIndex((l) => l.id === p.leaf) : -1;
    i = e.shiftKey ? (i < 0 ? leaves.length - 1 : i - 1) : i + 1;
    const target = leaves[(i + leaves.length) % leaves.length];
    if (target) {
      setCaret({ leaf: target.id, d: Engine.leafLen(target) });
      const pos = pointToDom({ leaf: target.id, d: 0 });
      if (pos) (pos.node.nodeType === 3 ? pos.node.parentElement : pos.node).scrollIntoView({ block: "nearest" });
    }
  }
});

// ====================================================================================================
// History: one app undo stack of whole-source snapshots, shared by Quick and Raw
// ====================================================================================================

const history = {
  undo: [],
  redo: [],
  last: { at: 0, key: "", kind: "" },
  record(src, caret, kind, key) {
    const now = performance.now();
    const L = this.last;
    const coalesce = kind === "type" && L.kind === "type" && L.key === key && now - L.at < 1000;
    if (!coalesce) { this.undo.push({ src, caret }); if (this.undo.length > 400) this.undo.shift(); }
    this.redo = [];
    this.last = { at: now, key, kind };
  },
  reset() { this.undo = []; this.redo = []; this.last = { at: 0, key: "", kind: "" }; },
};

function currentCaret() { return state.mode === "quick" ? caretSource() : els.raw.selectionStart; }

function undo() {
  flushPatch();
  dropPending();
  const entry = history.undo.pop();
  if (!entry) return;
  history.redo.push({ src: state.src, caret: currentCaret() });
  history.last = { at: 0, key: "", kind: "" };
  replaceSource(entry.src, entry.caret);
}
function redo() {
  flushPatch();
  const entry = history.redo.pop();
  if (!entry) return;
  history.undo.push({ src: state.src, caret: currentCaret() });
  history.last = { at: 0, key: "", kind: "" };
  replaceSource(entry.src, entry.caret);
}

// ====================================================================================================
// Raw and Split
// ====================================================================================================

let rawBefore = null;
els.raw.addEventListener("beforeinput", (e) => {
  if (e.inputType === "historyUndo") { e.preventDefault(); undo(); return; }
  if (e.inputType === "historyRedo") { e.preventDefault(); redo(); return; }
  if (!rawBefore) rawBefore = { src: state.src, caret: els.raw.selectionStart };
});
els.raw.addEventListener("input", () => {
  const t0 = performance.now();
  const prev = rawBefore || { src: state.src, caret: els.raw.selectionStart };
  rawBefore = null;
  history.record(prev.src, prev.caret, "type", "raw");
  state.src = els.raw.value;
  state.modelStale = true;
  if (state.mode === "split") schedulePreview();
  syncRawHL();
  edited();
  state.rawPerf.push(performance.now() - t0);
  if (state.rawPerf.length > 2000) state.rawPerf.splice(0, 1000);
});

// ---------- Raw syntax dimming: markdown punctuation in the secondary tone, words in cream ----------
// A pointer-events:none <pre> sits behind the textarea (whose own text is transparent; caret and
// selection stay native). The pre is split into chunks of whole lines - lines wrap independently, so
// stacked chunks lay out exactly like one text. Chunks start as plain text and get dimmed only when
// they come near the viewport; an edit rebuilds just the chunks it touched.

const HL_LINES = 64;
const hl = { text: null, chunks: [] };   // chunk: { start, end, el, fenceIn, fenceOut, done }

function hlEsc(t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function hlM(t) { return t ? `<span class="m">${hlEsc(t)}</span>` : ""; }

const HL_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// next fence state after one line: null outside code, else the opening fence string
function fenceStep(line, fence) {
  const f = HL_FENCE.exec(line);
  if (fence) return f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim() ? null : fence;
  return f ? f[1] : null;
}

const HL_INLINE = /(`+)([^`]*?)\1|(!?\[)([^\]\n]*)(\]\([^)\n]*\))|(!?\[)([^\]\n]*)(\]\[[^\]\n]*\])|(<(?:https?:|mailto:)[^>\s]*>|<\/?[A-Za-z][^>\n]*>)|(\\)([\\`*_{}\[\]()#+\-.!|<>~])|(\*\*|~~|\*|(?<![A-Za-z0-9])__?|__?(?![A-Za-z0-9]))/g;

function hlInline(t) {
  let out = "", last = 0;
  for (const m of t.matchAll(HL_INLINE)) {
    out += hlEsc(t.slice(last, m.index));
    if (m[1]) out += hlM(m[1]) + hlEsc(m[2]) + hlM(m[1]);            // `code`
    else if (m[3]) out += hlM(m[3]) + hlInline(m[4]) + hlM(m[5]);     // [text](url)
    else if (m[6]) out += hlM(m[6]) + hlInline(m[7]) + hlM(m[8]);     // [text][ref]
    else if (m[10]) out += hlM(m[10]) + hlEsc(m[11]);                 // \* : only the backslash dims
    else out += hlM(m[0]);                                              // ** ~~ * _ and tags / autolinks
    last = m.index + m[0].length;
  }
  return out + hlEsc(t.slice(last));
}

function hlCells(t) {
  // table line: pipes (not escaped ones) dim, cells get inline treatment
  const parts = t.split(/(?<!\\)\|/);
  return parts.map(hlInline).join(hlM("|"));
}

function hlLine(line, st) {
  if (st.fence) {
    const next = fenceStep(line, st.fence);
    if (!next) { st.fence = null; return hlM(line); }
    return hlEsc(line);
  }
  const opened = fenceStep(line, null);
  if (opened) { st.fence = opened; return hlM(line); }
  let m;
  if ((m = /^( {0,3})(#{1,6})(\s.*|)$/.exec(line))) return hlEsc(m[1]) + hlM(m[2]) + `<span class="h">${hlInline(m[3])}</span>`;
  if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) return hlM(line);                               // hr
  if ((m = /^( {0,3}\[)([^\]]+)(\]:.*)$/.exec(line))) return hlM(m[1]) + hlEsc(m[2]) + hlM(m[3]); // [ref]: url
  if (line.includes("|") && /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?\|?\s*$/.test(line)) return hlM(line); // |---| rule
  let pre = "", rest = line;
  if ((m = /^(\s*(?:>\s?)+)/.exec(rest))) { pre += hlM(m[1]); rest = rest.slice(m[1].length); }
  if ((m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(rest))) {
    pre += hlEsc(m[1]) + hlM(m[2]) + hlEsc(m[3]);
    rest = rest.slice(m[0].length);
    const t = /^\[[ xX]\]/.exec(rest);
    if (t) { pre += hlM(t[0]); rest = rest.slice(3); }
  }
  if (/^\s*\|/.test(rest)) return pre + hlCells(rest);
  return pre + hlInline(rest);
}

function hlMake(src, from, to, fenceIn) {
  const out = [];
  let pos = from;
  let fence = fenceIn;
  while (pos < to || (pos === to && !out.length && from === to)) {
    let end = pos;
    for (let k = 0; k < HL_LINES && end < to; k++) {
      const nl = src.indexOf("\n", end);
      end = nl < 0 || nl >= to ? to : nl + 1;
    }
    const text = src.slice(pos, end);
    const startFence = fence;
    for (const line of text.split("\n")) fence = fenceStep(line, fence);
    const el = document.createElement("div");
    el.className = "c";
    el.textContent = text;
    out.push({ start: pos, end, el, fenceIn: startFence, fenceOut: fence, done: false });
    if (end === pos) break;
    pos = end;
  }
  return out;
}

function hlChunk(c) {
  const st = { fence: c.fenceIn };
  c.el.innerHTML = c.el.textContent.split("\n").map((line) => hlLine(line, st)).join("\n");
  c.done = true;
}

function hlOn() { return state.mode === "raw"; }

function hlFull(src) {
  els.rawhl.textContent = "";
  hl.chunks = hlMake(src, 0, src.length, null);
  for (const c of hl.chunks) els.rawhl.appendChild(c.el);
  hl.text = src;
}

function hlIndexAt(pos) {
  let lo = 0, hi = hl.chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (hl.chunks[mid].start <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function syncRawHL() {
  if (!hlOn()) return;
  els.rawhl.style.top = els.raw.offsetTop + "px";
  const src = els.raw.value;
  if (hl.text === null || !hl.chunks.length) { hlFull(src); hlVisible(); return; }
  const old = hl.text;
  if (old === src) return;
  const n = Math.min(old.length, src.length);
  let p = 0;
  while (p < n && old.charCodeAt(p) === src.charCodeAt(p)) p++;
  let q = 0;
  while (q < n - p && old.charCodeAt(old.length - 1 - q) === src.charCodeAt(src.length - 1 - q)) q++;
  const oldEnd = old.length - q;
  const delta = src.length - old.length;
  let i0 = hlIndexAt(p);
  if (i0 > 0 && p === hl.chunks[i0].start) i0--;
  const i1 = Math.min(hl.chunks.length - 1, hlIndexAt(Math.max(p, oldEnd)) + 1);
  const from = hl.chunks[i0].start;
  const to = hl.chunks[i1].end + delta;
  const fresh = hlMake(src, from, to, hl.chunks[i0].fenceIn);
  const anchor = hl.chunks[i1].el.nextSibling;
  for (let i = i0; i <= i1; i++) hl.chunks[i].el.remove();
  for (const c of fresh) els.rawhl.insertBefore(c.el, anchor);
  for (const c of fresh) hlChunk(c);                       // the edited lines are on screen: dim them now
  for (let i = i1 + 1; i < hl.chunks.length; i++) { hl.chunks[i].start += delta; hl.chunks[i].end += delta; }
  hl.chunks.splice(i0, i1 - i0 + 1, ...fresh);
  // an opened or closed code fence changes how the following chunks read
  let fence = fresh[fresh.length - 1].fenceOut;
  for (let i = i0 + fresh.length; i < hl.chunks.length; i++) {
    const c = hl.chunks[i];
    if (c.fenceIn === fence) break;
    c.fenceIn = fence;
    let f = fence;
    for (const line of c.el.textContent.split("\n")) f = fenceStep(line, f);
    c.fenceOut = f;
    if (c.done) hlChunk(c);
    fence = f;
  }
  hl.text = src;
}

// dim the chunks within a screen of the viewport (run on scroll and after a jump)
function hlVisible() {
  if (!hlOn() || !hl.chunks.length) return;
  const t0 = performance.now();
  const view = els.scroller.getBoundingClientRect();
  const margin = view.height;
  let i = 0;
  // binary search for the first chunk whose bottom is past the top margin
  let lo = 0, hi = hl.chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hl.chunks[mid].el.getBoundingClientRect().bottom < view.top - margin) lo = mid + 1; else hi = mid;
  }
  for (i = lo; i < hl.chunks.length; i++) {
    const c = hl.chunks[i];
    const r = c.el.getBoundingClientRect();
    if (r.top > view.bottom + margin) break;
    if (!c.done) hlChunk(c);
  }
  state.hlPerf.push(performance.now() - t0);
  if (state.hlPerf.length > 2000) state.hlPerf.splice(0, 1000);
}

let hlQueued = false;
els.scroller.addEventListener("scroll", () => {
  if (!hlOn() || hlQueued) return;
  hlQueued = true;
  requestAnimationFrame(() => { hlQueued = false; hlVisible(); });
}, { passive: true });
els.raw.addEventListener("blur", scheduleOverlays);
els.raw.addEventListener("focus", scheduleOverlays);
els.raw.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey && key === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (e.ctrlKey && !e.altKey && key === "y") { e.preventDefault(); return redo(); }
  if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  }
});

let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    if (state.mode !== "split") return;
    state.model = Engine.buildModel(state.src);
    state.modelStale = false;
    renderAll();
  });
}

// Raw geometry: a hidden mirror with the textarea's exact type measures where source offsets sit.
function rawOffsetsY(offsets) {
  const src = els.raw.value;
  const m = els.mirror;
  m.style.top = els.raw.offsetTop + "px";
  m.textContent = "";
  const sorted = [...new Set(offsets.map((o) => Math.max(0, Math.min(src.length, o))))].sort((a, b) => a - b);
  const marks = new Map();
  let at = 0;
  for (const o of sorted) {
    m.appendChild(document.createTextNode(src.slice(at, o)));
    const s = document.createElement("span");
    m.appendChild(s);
    marks.set(o, s);
    at = o;
  }
  m.appendChild(document.createTextNode(src.slice(at) + "\n"));
  const out = new Map();
  for (const [o, s] of marks) out.set(o, s.offsetTop);
  m.textContent = "";
  return (o) => out.get(Math.max(0, Math.min(src.length, o)));
}

function rawLineHeight() { return parseFloat(getComputedStyle(els.raw).lineHeight) || 22; }

// ====================================================================================================
// Modes: Quick Edit <-> Raw keep the same source offset at the same screen height
// ====================================================================================================

const MODE_ALIAS = { view: "quick", quick: "quick", edit: "raw", raw: "raw", split: "split" };

function viewTop() { return els.scroller.getBoundingClientRect().top; }

// Where the reader is: a source offset and its height on screen.
function captureAnchor() {
  const top = viewTop();
  const vh = els.scroller.clientHeight;
  if (state.mode === "quick" && state.model && !state.modelStale) {
    if (selectionInPage()) {
      const pos = caretSource();
      const r = caretRect();
      if (pos >= 0 && r && r.bottom > top && r.top < top + vh) return { pos, y: r.top - top };
      if (pos >= 0) return { pos, y: vh / 3 };
    }
    // no caret: the first block whose box is on screen
    for (let i = 0; i < els.page.children.length; i++) {
      const w = els.page.children[i];
      const el = w.firstElementChild;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 8) {
        const b = state.model.blocks[i];
        return { pos: b ? b.s : 0, y: r.top - top, noCaret: !selectionInPage() };
      }
    }
    return { pos: 0, y: 40 };
  }
  const pos = els.raw.selectionStart || 0;
  if (state.mode === "raw") {
    const y = rawOffsetsY([pos])(pos);
    const rawTop = els.raw.getBoundingClientRect().top;
    const screenY = rawTop + y - top;
    return { pos, y: screenY > 0 && screenY < vh - 20 ? screenY : vh / 3 };
  }
  return { pos, y: vh / 3 };
}

function setMode(mode, opts = {}) {
  const to = MODE_ALIAS[mode];
  if (!to) throw new Error(`unknown mode ${mode}`);
  if (!doc.loaded) { state.mode = to; els.html.dataset.mode = to; refreshChrome(); return; }
  if (to === state.mode) return;
  flushPatch();
  els.sheet.getAnimations().forEach((a) => a.finish());   // a still-running open rise would skew the pin
  const anchor = captureAnchor();
  dropPending();
  hideHint();
  if (opts.animate && !reduced() && document.startViewTransition) {
    els.html.classList.add("vt-mode", `vt-to-${to}`);
    const oldEl = morphSource(anchor);
    if (oldEl) oldEl.style.viewTransitionName = "arrival";
    let newEl = null;
    const vt = document.startViewTransition(() => {
      if (oldEl) oldEl.style.viewTransitionName = "";
      els.ovBand.classList.remove("hold");
      switchMode(to, anchor);
      newEl = morphTarget(to, anchor, !!oldEl);
      if (newEl) newEl.style.viewTransitionName = "arrival";
      if (state.pinShift) {
        els.html.style.setProperty("--vt-shift", state.pinShift + "px");
        els.html.classList.add("vt-shift");
      }
      state.lastPinShift = state.pinShift;
    });
    vt.finished.finally(() => {
      if (newEl) newEl.style.viewTransitionName = "";
      els.html.classList.remove("vt-mode", `vt-to-${to}`, "vt-shift");
      els.html.style.removeProperty("--vt-shift");
    });
  } else {
    switchMode(to, anchor);
  }
}

// The element that stands for the reader's block: its rendered element in Quick, the band in Raw.
function blockElementAt(pos) {
  if (!state.model || state.modelStale || !state.model.blocks.length) return null;
  let bi = Engine.blockAt(state.model, pos);
  while (bi < state.model.blocks.length - 1 && state.model.blocks[bi].tok.type === "space") bi++;
  const w = els.page.children[bi];
  return w && !w.classList.contains("frozen") ? w.firstElementChild : null;
}

function morphSource(anchor) {
  if (state.mode === "quick") return anchor.noCaret ? null : blockElementAt(anchor.pos);
  if (state.mode !== "raw") return null;
  // Raw: hold the band over the caret's paragraph (blank-line bounded) so it can morph into the block
  const src = state.src;
  let bs = src.lastIndexOf("\n\n", Math.max(0, anchor.pos - 1));
  bs = bs < 0 ? 0 : bs + 2;
  let be = src.indexOf("\n\n", anchor.pos);
  if (be < 0) be = src.length;
  while (be > bs && src[be - 1] === "\n") be--;
  const y = rawOffsetsY([bs, be]);
  const b = els.ovBand;
  b.style.top = els.raw.offsetTop + y(bs) - 3 + "px";
  b.style.height = y(be) - y(bs) + rawLineHeight() + 6 + "px";
  b.classList.add("hold");
  return b;
}

function morphTarget(to, anchor, hadSource) {
  if (!hadSource) return null;
  if (to === "raw") return els.ovBand.getAnimations().length ? els.ovBand : null;
  if (to === "quick") return blockElementAt(anchor.pos);
  return null;
}

// Scroll so the point now at viewport y `nowY` (relative to the scroller) sits at `wantY`. Where the
// scroll cannot reach that (near the top or end of the file) the view rests at its natural, clamped
// scroll and the leftover offset is returned: the animated switch slides the incoming layer from that
// offset to 0, so the eye follows the line and nothing is left behind.
function pinTo(nowY, wantY) {
  const before = els.scroller.scrollTop;
  els.scroller.scrollTop = Math.max(0, before + nowY - wantY);
  const lineY = nowY - (els.scroller.scrollTop - before);
  return Math.abs(wantY - lineY) < 0.5 ? 0 : wantY - lineY;
}

function switchMode(to, anchor) {
  const from = state.mode;
  state.pinShift = 0;
  if (from === "quick") els.raw.value = state.src;
  state.mode = to;
  els.html.dataset.mode = to;
  els.page.contentEditable = to === "quick" ? "true" : "false";
  const top = viewTop();

  if (to === "quick") {
    ensureModel();
    const pt = Engine.pointForSource(state.model, anchor.pos);
    els.page.focus({ preventScroll: true });
    if (pt) setCaret(pt);
    const r = caretRect();
    if (r) state.pinShift = pinTo(r.top - top, anchor.y);
  } else if (to === "raw") {
    syncRawHL();
    els.raw.focus({ preventScroll: true });
    els.raw.setSelectionRange(anchor.pos, anchor.pos);
    placeRaw(anchor, from === "quick" && !anchor.noCaret);
    hlVisible();
  } else {
    // split: Raw beside a read-only page, kept in step on input
    state.model = Engine.buildModel(state.src);
    state.modelStale = false;
    renderAll();
    els.raw.focus({ preventScroll: true });
    els.raw.setSelectionRange(anchor.pos, anchor.pos);
    els.raw.scrollTop = Math.max(0, rawOffsetsY([anchor.pos])(anchor.pos) - anchor.y);
  }
  refreshChrome();
  scheduleOverlays();
}

// Raw at the same place: the anchor's source line at the anchor's screen height, its block banded.
function placeRaw(anchor, band) {
  const src = state.src;
  let bs = anchor.pos, be = anchor.pos;
  if (band && state.model && !state.modelStale && state.model.blocks.length) {
    let bi = Engine.blockAt(state.model, anchor.pos);
    while (bi < state.model.blocks.length - 1 && state.model.blocks[bi].tok.type === "space") bi++;
    const b = state.model.blocks[bi];
    bs = b.s;
    be = b.e;
    while (be > bs && src[be - 1] === "\n") be--;
  }
  const y = rawOffsetsY([anchor.pos, bs, be]);
  const lh = rawLineHeight();
  const rawTop = els.raw.getBoundingClientRect().top;
  state.pinShift = pinTo(rawTop + y(anchor.pos) - viewTop(), anchor.y);
  if (!band) return;
  const b = els.ovBand;
  b.style.top = els.raw.offsetTop + y(bs) - 3 + "px";
  b.style.height = y(be) - y(bs) + lh + 6 + "px";
  // the band holds full strength for 1.2 s, then hands over to the current-line tint
  if (reduced()) {
    b.animate([{ opacity: 1 }, { opacity: 1, offset: 0.999 }, { opacity: 0 }], { duration: 1200 });
    els.ovLine.animate([{ opacity: 0 }, { opacity: 0, offset: 0.999 }, { opacity: 1 }], { duration: 1200 });
  } else {
    b.animate([{ opacity: 1 }, { opacity: 1, offset: 1200 / 1800, easing: EASE }, { opacity: 0 }], { duration: 1800 });
    els.ovLine.animate([{ opacity: 0 }, { opacity: 0, offset: 1200 / 1800, easing: EASE }, { opacity: 1 }], { duration: 1800 });
  }
}

// Raw geometry of the caret's source line, measured from a cached line start so caret moves stay cheap
// (only the text between the cached line and the caret's line goes through the mirror).
const rawLineCache = { start: -1, y: 0, prefix: "", width: 0 };

function mirrorTops(src, base, offsets) {
  const m = els.mirror;
  m.style.top = els.raw.offsetTop + "px";
  m.textContent = "";
  const marks = [];
  let at = base;
  for (const o of [...new Set(offsets)].sort((a, b) => a - b)) {
    m.appendChild(document.createTextNode(src.slice(at, o)));
    const span = document.createElement("span");
    m.appendChild(span);
    marks.push([o, span]);
    at = o;
  }
  const out = new Map(marks.map(([o, span]) => [o, span.offsetTop]));
  m.textContent = "";
  return out;
}

function rawLineBox(pos) {
  const src = els.raw.value;
  const ls = src.lastIndexOf("\n", pos - 1) + 1;
  let le = src.indexOf("\n", pos);
  if (le < 0) le = src.length;
  const c = rawLineCache;
  const width = els.raw.clientWidth;
  const ok = c.start >= 0 && c.width === width && c.start <= src.length && src.startsWith(c.prefix);
  let top, bottom;
  if (ok && ls >= c.start) {
    const t = mirrorTops(src, c.start, [ls, le]);
    top = c.y + t.get(ls);
    bottom = c.y + t.get(le);
  } else if (ok) {
    const t = mirrorTops(src, ls, [c.start, le]);
    top = c.y - t.get(c.start);
    bottom = top + t.get(le);
  } else {
    const t = mirrorTops(src, 0, [ls, le]);
    top = t.get(ls);
    bottom = t.get(le);
  }
  rawLineCache.start = ls;
  rawLineCache.y = top;
  rawLineCache.prefix = src.slice(0, ls);
  rawLineCache.width = width;
  return { top, bottom };
}

function placeLineTint() {
  const t = els.ovLine;
  if (state.mode !== "raw" || document.activeElement !== els.raw) { t.classList.remove("on"); return; }
  const box = rawLineBox(els.raw.selectionStart);
  t.style.top = els.raw.offsetTop + box.top - 3 + "px";
  t.style.height = box.bottom - box.top + rawLineHeight() + 6 + "px";
  t.classList.add("on");
}

// ====================================================================================================
// Strip: name, status words, save check, mode pill, tools
// ====================================================================================================

function isDirty() { return doc.loaded && state.src !== doc.savedText; }

const shown = { status: null, title: null, name: null, mode: null, tools: null };

function statusWord() {
  if (!doc.loaded) return "";
  if (state.saveError) return "Failed";
  if (state.saving) return "Saving...";
  if (state.notice) return state.notice;
  if (isDirty()) return "Edited";
  if (state.large && state.mode === "raw") return "Large file - Raw";
  return "Saved";
}

// file's last-modified time for the strip: "6 Nov 20:21" (year added when it is not this year)
function fmtStamp(ms) {
  const d = new Date(ms), now = new Date();
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

function refreshChrome() {
  const dirty = isDirty();
  els.html.classList.toggle("dirty", dirty);
  els.html.classList.toggle("save-error", state.saveError);
  els.html.classList.toggle("saving", state.saving);
  els.btnSave.setAttribute("aria-disabled", String(state.saving));
  const label = state.saveError ? "Retry" : "Save";
  if (els.btnSave.textContent !== label) els.btnSave.textContent = label;
  els.btnSave.dataset.tip = state.saveError ? `Retry (Ctrl+S) - ${state.saveErrorReason}` : "Save (Ctrl+S)";
  if (state.saveError) els.btnSave.setAttribute("aria-describedby", "note"); else els.btnSave.removeAttribute("aria-describedby");
  els.html.dataset.empty = String(!doc.loaded);
  const name = doc.loaded ? doc.name || "untitled.md" : "just.MD";
  if (shown.name !== name) { els.name.textContent = name; shown.name = name; }
  const word = statusWord();
  if (shown.status !== word) {
    els.status.textContent = word;
    els.status.getAnimations().forEach((a) => a.cancel());
    if (shown.status && word && !reduced()) els.status.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: EASE });
    shown.status = word;
  }
  const stamp = doc.loaded && doc.mtime ? fmtStamp(doc.mtime) : "";
  if (shown.stamp !== stamp) {
    els.stamp.textContent = stamp;
    els.stamp.title = stamp ? `Last changed on disk: ${new Date(doc.mtime).toLocaleString()}` : "";
    shown.stamp = stamp;
  }
  const title = doc.loaded ? `${dirty ? "* " : ""}${name} - just.MD` : "just.MD";
  if (shown.title !== title) { document.title = title; shown.title = title; }
  if (shown.mode !== state.mode) {
    shown.mode = state.mode;
    const on = state.mode === "quick" ? "quick" : "raw";
    els.pill.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === on)));
    placeThumb();
  }
  if (shown.tools !== doc.loaded) { shown.tools = doc.loaded; refreshTools(); }
  refreshNote(shown.noteReady);
  shown.noteReady = doc.loaded;
}

function placeThumb() {
  const on = els.pill.querySelector('button[aria-pressed="true"]');
  if (!on || !on.offsetWidth) return;
  els.pill.style.setProperty("--x", on.offsetLeft + "px");
  els.pill.style.setProperty("--w", on.offsetWidth + "px");
  if (!els.pill.classList.contains("placed")) {
    els.pill.classList.add("placed");
    requestAnimationFrame(() => requestAnimationFrame(() => els.pill.classList.add("ready")));
  }
}

// The Quick Edit line lives in the strip until the first edit.
function edited() {
  if (localStorage.getItem("mdv-firstrun") !== "done") localStorage.setItem("mdv-firstrun", "done");
  state.notice = "";
  refreshChrome();
  scheduleOverlays();
}

function playSaved() {
  const dot = els.mark.querySelector(".dot");
  const check = els.mark.querySelector(".check");
  const path = check.querySelector("path");
  els.html.classList.add("saving-out");
  if (reduced()) {
    check.animate([{ opacity: 1 }, { opacity: 1, offset: 0.999 }, { opacity: 0 }], { duration: 1200 });
    els.html.classList.remove("saving-out");
    refreshChrome();
    return;
  }
  refreshChrome();
  // the dot hands over to the check: it shrinks while the check draws from the same spot
  const shrink = dot.animate([{ transform: "scale(1)" }, { transform: "scale(0)" }], { duration: 160, easing: EASE, fill: "forwards" });
  els.btnSave.animate([{ opacity: 0 }], { duration: 120, easing: EASE, fill: "forwards" });
  check.animate([{ opacity: 0 }, { opacity: 1, offset: 0.04 }, { opacity: 1, offset: 0.9, easing: EASE }, { opacity: 0 }], { duration: 1200 });
  path.animate([{ strokeDashoffset: 1, easing: EASE }, { strokeDashoffset: 0, offset: 0.22 }, { strokeDashoffset: 0 }], { duration: 1200 });
  shrink.finished.then(() => {
    els.html.classList.remove("saving-out");
    shrink.cancel();
    els.btnSave.getAnimations().forEach((a) => a.cancel());
    refreshChrome();
  });
}

// ---------- tools: copy all ----------

function refreshTools() {
  els.copyAll.setAttribute("aria-disabled", String(!doc.loaded));
}

function confirmTool(btn) {
  btn.classList.add("done");
  const path = btn.querySelector(".ok path");
  const frames = reduced()
    ? [{ strokeDashoffset: 0 }, { strokeDashoffset: 0 }]
    : [{ strokeDashoffset: 1 }, { strokeDashoffset: 0, offset: 0.2, easing: EASE }, { strokeDashoffset: 0 }];
  path.animate(frames, { duration: 1000 }).finished.then(() => btn.classList.remove("done"));
}

async function copyAll() {
  if (!doc.loaded) return;
  try {
    await navigator.clipboard.writeText(state.src);
    confirmTool(els.copyAll);
  } catch (err) {
    showTip(els.copyAll, "Copy failed - the clipboard was not available");
  }
}

// Tooltip bubble for strip buttons: appears after a short hover (CSS transition delay), or on focus.
function showTip(btn, text) {
  const r = btn.getBoundingClientRect();
  els.tip.textContent = text || btn.dataset.tip || "";
  els.tip.classList.add("on");
  const w = els.tip.offsetWidth;
  els.tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  els.tip.style.top = r.bottom + 6 + "px";
}
function hideTip() { els.tip.classList.remove("on"); }
els.strip.querySelectorAll("[data-tip]").forEach((btn) => {
  btn.addEventListener("mouseenter", () => showTip(btn));
  btn.addEventListener("mouseleave", hideTip);
  btn.addEventListener("focus", () => { if (btn.matches(":focus-visible")) showTip(btn); });
  btn.addEventListener("blur", hideTip);
});

// ====================================================================================================
// Overlays: hover hairline, caret hairline + wash, refused-edit outline, frozen chip, hint
// ====================================================================================================

const BLOCK_SEL = "p, h1, h2, h3, h4, h5, h6, pre, .own, td, th";

function sheetBox() { return els.sheet.getBoundingClientRect(); }

function placeRail(ov, el) {
  const s = sheetBox();
  const r = el.getBoundingClientRect();
  if (el.matches("td, th")) {
    ov.classList.add("cell");
    ov.style.left = r.left - s.left + "px";
    ov.style.width = r.width + "px";
    ov.style.top = r.bottom - s.top - 2 + "px";
    ov.style.height = "2px";
  } else {
    ov.classList.remove("cell");
    ov.style.left = "";
    ov.style.width = "";
    const inset = el.matches("pre") ? 0 : 3;
    ov.style.top = r.top - s.top + inset + "px";
    ov.style.height = Math.max(4, r.height - 2 * inset) + "px";
  }
}

function blockFor(node) {
  if (!node) return null;
  const el = node.nodeType === 3 ? node.parentElement : node;
  if (!el || !els.page.contains(el)) return null;
  const b = el.closest(BLOCK_SEL);
  if (!b || b.closest(".frozen")) return null;
  // a paragraph inside a list item belongs to that item's own text box when there is one
  return b;
}

let hoverEl = null;
els.page.addEventListener("mouseover", (e) => {
  if (state.mode !== "quick") return;
  const frozen = e.target.closest(".frozen > *, .frozen-inline, img, hr");
  if (frozen && els.page.contains(frozen)) showChip(frozen); else hideChip();
  const b = frozen ? null : blockFor(e.target);
  if (b && !linkTipShown) {
    const a = e.target.closest("a[href]");
    if (a && !a.classList.contains("frozen-inline")) { linkTipShown = true; showLinkTip(a); }
  }
  if (b === hoverEl) return;
  hoverEl = b;
  if (!b) { els.ovHover.classList.remove("on"); return; }
  placeRail(els.ovHover, b);
  els.ovHover.classList.add("on");
});
els.page.addEventListener("mouseleave", () => {
  hoverEl = null;
  els.ovHover.classList.remove("on");
  hideChip();
});

let linkTipShown = false;
function showLinkTip(a) {
  showTip(a, "Ctrl+click to open");
  a.addEventListener("mouseleave", hideTip, { once: true });
}

function showChip(el) {
  const s = sheetBox();
  const r = el.getBoundingClientRect();
  const chip = els.ovChip;
  chip.style.left = Math.max(0, r.right - s.left - chip.offsetWidth) + "px";
  chip.style.top = r.top - s.top - chip.offsetHeight - 6 + "px";
  chip.classList.add("on");
}
function hideChip() { els.ovChip.classList.remove("on"); }

let overlaysQueued = false;
function scheduleOverlays() {
  if (overlaysQueued) return;
  overlaysQueued = true;
  requestAnimationFrame(() => { overlaysQueued = false; placeCaretOverlays(); });
}
document.addEventListener("selectionchange", scheduleOverlays);
new ResizeObserver(scheduleOverlays).observe(els.page);

let activeBlock = null;
function placeCaretOverlays() {
  flushPatch();
  placeLineTint();
  const sel = document.getSelection();
  const node = state.mode === "quick" && sel.rangeCount && document.activeElement === els.page ? sel.getRangeAt(0).startContainer : null;
  const b = blockFor(node);
  if (activeBlock && activeBlock !== b) activeBlock.classList.remove("qe-active");
  activeBlock = b;
  if (!b) {
    els.ovCaret.classList.remove("on");
    els.ovWash.classList.remove("on");
    return;
  }
  b.classList.add("qe-active");
  placeRail(els.ovCaret, b);
  els.ovCaret.classList.add("on");
  const box = blockBox(b);
  const w = els.ovWash;
  w.classList.toggle("cell", box.cell);
  w.style.left = box.left + "px";
  w.style.top = box.top + "px";
  w.style.height = box.height + "px";
  w.style.width = box.width + "px";
  w.classList.add("on");
}

function unionRect(rects) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const x of rects) {
    if (!x.width && !x.height) continue;
    l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom);
  }
  return l === Infinity ? null : { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
}

// The caret block's box in sheet coordinates: the same rounded rect the caret wash uses.
function blockBox(b) {
  const s = sheetBox();
  const r = b.getBoundingClientRect();
  if (b.matches("td, th")) return { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height, cell: true, right: r.right - s.left };
  const right = Math.max(s.width, r.right - s.left) + 12;
  return { left: -12, top: r.top - s.top - 4, width: right + 12, height: r.height + 8, cell: false, right };
}

function refusalBlock() {
  const sel = document.getSelection();
  if (!sel.rangeCount) return null;
  const n = sel.getRangeAt(0).startContainer;
  const b = blockFor(n);
  if (b) return b;
  const el = n.nodeType === 3 ? n.parentElement : n;
  if (!el || !els.page.contains(el) || el === els.page) return null;
  return el.closest(".frozen > *, .frozen-inline, p, li, td, th, h1, h2, h3, h4, h5, h6, pre");
}

function flashBlock(b) {
  const box = blockBox(b);
  const o = els.ovDeny;
  o.classList.toggle("cell", box.cell);
  o.style.left = box.left + "px";
  o.style.top = box.top + "px";
  o.style.width = box.width + "px";
  o.style.height = box.height + "px";
  o.getAnimations().forEach((a) => a.cancel());
  if (reduced()) o.animate([{ opacity: 1 }, { opacity: 1, offset: 0.999 }, { opacity: 0 }], { duration: 600 });
  else o.animate([
    { opacity: 0, outlineOffset: "3px", easing: EASE },
    { opacity: 1, outlineOffset: "0px", offset: 0.18, easing: EASE },
    { opacity: 0.25, outlineOffset: "0px", offset: 0.48, easing: EASE },
    { opacity: 1, outlineOffset: "0px", offset: 0.68, easing: EASE },
    { opacity: 0, outlineOffset: "1px" },
  ], { duration: 360 });
}

let chipAnim = null;

// Would a viewport rect cover any text? Checks the line boxes of the caret block and two blocks each side.
function coversText(rect, b) {
  const w = b.closest(".b");
  if (!w) return false;
  const near = [w];
  for (let x = w, k = 0; k < 2 && x.previousElementSibling; k++) { x = x.previousElementSibling; near.push(x); }
  for (let x = w, k = 0; k < 2 && x.nextElementSibling; k++) { x = x.nextElementSibling; near.push(x); }
  const pad = 3;
  for (const el of near) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.data.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const c of r.getClientRects()) {
        if (c.right > rect.left - pad && c.left < rect.right + pad && c.bottom > rect.top - pad && c.top < rect.bottom + pad) return true;
      }
    }
  }
  return false;
}

function showRefusalChip(b, text) {
  const c = els.refuse;
  els.refuseText.textContent = text;
  if (chipAnim) chipAnim.cancel();
  c.classList.remove("side", "above", "below");
  c.classList.add("on");
  const s = sheetBox();
  const box = blockBox(b);
  const w = c.offsetWidth, h = c.offsetHeight;
  const vTop = viewTop() + 4;
  const vBottom = els.scroller.getBoundingClientRect().bottom - 4;
  const room = document.documentElement.clientWidth - (s.left + box.right) - 20;
  const spots = [];
  if (room >= w + 14) spots.push(["side", box.right + 16, box.top + 2]);                  // the empty right margin
  spots.push(["above", Math.max(0, box.right - w), box.top - h - 12]);                     // gap above the top-right corner
  spots.push(["below", Math.max(0, box.right - w), box.top + box.height + 12]);            // under the block
  let pick = null;
  for (const [kind, left, top] of spots) {
    const r = { left: s.left + left, top: s.top + top, right: s.left + left + w, bottom: s.top + top + h };
    if (r.top < vTop || r.bottom > vBottom) continue;
    if (coversText(r, b)) continue;
    pick = [kind, left, top];
    break;
  }
  if (!pick) {                                     // nowhere free beside the block: say it in the strip
    c.classList.remove("on");
    showNoteMessage(text);
    return;
  }
  c.classList.add(pick[0]);
  c.style.left = pick[1] + "px";
  c.style.top = pick[2] + "px";
  const total = 140 + 2500 + 160;
  const from = pick[0] === "side" ? "translateX(-4px)" : pick[0] === "above" ? "translateY(4px)" : "translateY(-4px)";
  const anim = reduced()
    ? c.animate([{ opacity: 1 }, { opacity: 1, offset: 0.999 }, { opacity: 0 }], { duration: 2640, fill: "forwards" })
    : c.animate([
      { opacity: 0, transform: from, easing: EASE },
      { opacity: 1, transform: "none", offset: 140 / total },
      { opacity: 1, transform: "none", offset: (140 + 2500) / total, easing: EASE },
      { opacity: 0, transform: "none" },
    ], { duration: total, fill: "forwards" });
  chipAnim = anim;
  anim.finished.then(() => { if (chipAnim === anim) hideChipNow(); }).catch(() => {});
}
function hideChipNow() {
  if (chipAnim) chipAnim.cancel();
  chipAnim = null;
  els.refuse.classList.remove("on");
}
els.refuseRaw.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret where it is
els.refuseRaw.addEventListener("click", () => { hideChipNow(); setMode("raw", { animate: true }); });

// ---------- the strip's note slot: a mode line, or for a moment the reason an edit was refused ----------

const NOTES = {
  quick: "Click any text to edit. Formatting stays put.",
  raw: "Raw markdown - Ctrl+E back to the page",
  split: "Raw beside the page - Ctrl+E back to the page",
};

function noteText() {
  if (!doc.loaded) return "";
  if (state.saveError) return `Not saved - ${state.saveErrorReason}`;
  if (state.mode === "quick") return localStorage.getItem("mdv-firstrun") === "done" ? "" : NOTES.quick;
  return NOTES[state.mode] || "";
}

function setNoteContent(text) {
  const n = els.note;
  n.textContent = "";
  for (const part of text.split(/(Ctrl\+E)/)) {
    if (part === "Ctrl+E") { const k = document.createElement("kbd"); k.textContent = "Ctrl+E"; n.appendChild(k); }
    else if (part) n.appendChild(document.createTextNode(part));
  }
}

let noteAnim = null;      // the running refusal message, if any
let noteShown = null;     // the mode line currently in the slot

function refreshNote(animate) {
  if (noteAnim) return;   // a message is showing; it puts the mode line back when it ends
  const t = noteText();
  if (noteShown === t) return;
  const had = noteShown;
  noteShown = t;
  const n = els.note;
  if (!t) {
    if (animate && had && !reduced() && !n.hidden) {
      n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE }).finished
        .then(() => { if (noteShown === "" && !noteAnim) n.hidden = true; }).catch(() => {});
    } else n.hidden = true;
    return;
  }
  setNoteContent(t);
  n.hidden = false;
  if (animate && !reduced()) n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: EASE });
}

function showNoteMessage(text) {
  const n = els.note;
  if (noteAnim) noteAnim.cancel();
  n.getAnimations().forEach((a) => a.cancel());
  setNoteContent(text);
  n.hidden = false;
  n.classList.add("msg");
  const total = 140 + 2500 + 160;
  const anim = reduced()
    ? n.animate([{ opacity: 1 }, { opacity: 1, offset: 0.999 }, { opacity: 0 }], { duration: 2640, fill: "forwards" })
    : n.animate([
      { opacity: 0, transform: "translateY(2px)", easing: EASE },
      { opacity: 1, transform: "none", offset: 140 / total },
      { opacity: 1, transform: "none", offset: (140 + 2500) / total, easing: EASE },
      { opacity: 0, transform: "none" },
    ], { duration: total, fill: "forwards" });
  noteAnim = anim;
  anim.finished.then(() => { if (noteAnim === anim) endNoteMessage(); }).catch(() => {});
}

function endNoteMessage() {
  const anim = noteAnim;
  noteAnim = null;
  if (anim) anim.cancel();
  els.note.classList.remove("msg");
  noteShown = null;
  refreshNote(true);
}

function hideHint() {
  let any = false;
  if (chipAnim) { hideChipNow(); any = true; }
  if (noteAnim) { endNoteMessage(); any = true; }
  return any;
}

// ====================================================================================================
// Palette (Ctrl+K)
// ====================================================================================================

const COMMANDS = [
  { label: "Open file", keys: "Ctrl+O", run: () => openDialog() },
  { label: "Save", keys: "Ctrl+S", when: () => doc.loaded, run: () => save() },
  { label: "Save as", keys: "Ctrl+Shift+S", when: () => doc.loaded, run: () => save({ saveAs: true }) },
  { label: () => (state.mode === "quick" ? "Switch to Raw" : "Switch to Quick edit"), keys: "Ctrl+E", when: () => doc.loaded,
    run: () => setMode(state.mode === "quick" ? "raw" : "quick", { animate: true }) },
  { label: "Split: Raw beside the page", keys: "", when: () => doc.loaded && state.mode !== "split", run: () => setMode("split", { animate: true }) },
  { label: "Copy all markdown", keys: "", when: () => doc.loaded, run: () => copyAll() },
];
// one palette row per theme other than the current one (THEMES is defined with the theme code below)
for (const t of [["dark", "Signature"], ["light", "Light"], ["blackwall", "Blackwall"], ["synthwave", "Synthwave"]]) {
  COMMANDS.push({ label: `Theme: ${t[1]}`, keys: "", when: () => els.html.dataset.theme !== t[0], run: () => setTheme(t[0], { animate: true }) });
}
const KEYS = [
  ["Next / previous piece of text", "Tab / Shift+Tab"],
  ["Toggle a task", "Ctrl+Enter"],
  ["Undo / redo", "Ctrl+Z / Ctrl+Y"],
  ["Open a link", "Ctrl+click"],
  ["Find on the page", "Ctrl+F"],
  ["Leave the text", "Esc"],
];

let paletteRows = [];
let paletteActive = 0;

function labelOf(c) { return typeof c.label === "function" ? c.label() : c.label; }

function renderPalette() {
  const q = els.paletteInput.value.trim().toLowerCase();
  const match = (s) => !q || s.toLowerCase().includes(q);
  const list = els.paletteList;
  list.textContent = "";
  paletteRows = [];
  const keysRow = (k) => {
    const span = document.createElement("span");
    span.className = "keys";
    k.split(" / ").forEach((combo, i) => {
      if (i) span.appendChild(document.createTextNode(" / "));
      const kb = document.createElement("kbd");
      kb.textContent = combo;
      span.appendChild(kb);
    });
    return span;
  };
  for (const c of COMMANDS) {
    const label = labelOf(c);
    if (!match(label)) continue;
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const enabled = !c.when || c.when();
    if (!enabled) { li.classList.add("off"); li.setAttribute("aria-disabled", "true"); if (c.why) li.title = c.why(); }
    const t = document.createElement("span");
    t.className = "label";
    t.textContent = label;
    li.appendChild(t);
    if (c.keys) li.appendChild(keysRow(c.keys));
    li.addEventListener("click", () => runCommand(c));
    li.addEventListener("mousemove", () => setActive(paletteRows.indexOf(li)));
    list.appendChild(li);
    paletteRows.push(li);
    li._cmd = enabled ? c : null;
  }
  const keys = KEYS.filter(([l, k]) => match(l) || match(k));
  if (keys.length) {
    const head = document.createElement("li");
    head.className = "head";
    head.textContent = "Keys";
    list.appendChild(head);
    for (const [l, k] of keys) {
      const li = document.createElement("li");
      li.className = "info";
      const t = document.createElement("span");
      t.className = "label";
      t.textContent = l;
      li.appendChild(t);
      li.appendChild(keysRow(k));
      list.appendChild(li);
    }
  }
  setActive(Math.max(0, paletteRows.findIndex((r) => r._cmd)));
}

function setActive(i) {
  paletteActive = i;
  paletteRows.forEach((r, k) => r.classList.toggle("active", k === i));
  const r = paletteRows[i];
  if (r) r.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  if (els.palette.open) return closePalette();
  hideHint();
  els.paletteInput.value = "";
  renderPalette();
  els.palette.showModal();
  els.paletteInput.focus();
}
function closePalette() { if (els.palette.open) els.palette.close(); }
function runCommand(c) {
  if (!c || (c.when && !c.when())) return;
  closePalette();
  c.run();
}

els.paletteInput.addEventListener("input", renderPalette);
els.paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = paletteRows.length;
    if (!n) return;
    let i = paletteActive;
    for (let step = 0; step < n; step++) {
      i = (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      if (paletteRows[i]._cmd) break;
    }
    setActive(i);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const r = paletteRows[paletteActive];
    if (r && r._cmd) runCommand(r._cmd);
  }
});
els.palette.addEventListener("click", (e) => { if (e.target === els.palette) closePalette(); });
els.palette.addEventListener("close", () => {
  if (doc.loaded && state.mode === "quick") els.page.focus({ preventScroll: true });
});

// ====================================================================================================
// Theme
// ====================================================================================================

// id -> menu name and the title-bar colour (the strip background). "dark" is the Signature theme.
const THEMES = [
  { id: "dark", name: "Signature", bar: "#1B2027" },
  { id: "light", name: "Light", bar: "#F1EDE5" },
  { id: "blackwall", name: "Blackwall", bar: "#231C1D" },
  { id: "synthwave", name: "Synthwave", bar: "#1E1A29" },
];
const themeById = (id) => THEMES.find((t) => t.id === id);

function applyTheme(theme) {
  els.html.dataset.theme = theme;
  els.themeMeta.content = themeById(theme).bar;
  els.themeSw.dataset.t = theme;
  for (const b of els.themeMenu.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.pick === theme));
  localStorage.setItem("mdv-theme", theme);
  requestAnimationFrame(scheduleOverlays);
}
// opts.from: the element the reveal circle grows from (defaults to the theme button)
function setTheme(theme, opts = {}) {
  if (!themeById(theme)) throw new Error(`unknown theme ${theme}`);
  if (theme === els.html.dataset.theme) return;
  if (opts.animate && !reduced() && document.startViewTransition) {
    const r = (opts.from || els.btnTheme).getBoundingClientRect();
    const x = r.width ? r.left + r.width / 2 : innerWidth - 60, y = r.height ? r.top + r.height / 2 : 18;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    els.html.classList.add("vt-theme");
    const vt = document.startViewTransition(() => applyTheme(theme));
    vt.ready.then(() => {
      els.html.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 353, easing: "cubic-bezier(.7, 0, .84, 0)" /* ease-in expo: slow start, accelerates */,pseudoElement: "::view-transition-new(root)" });
    }).catch(() => {});   // skipped (another transition started): the theme is still applied by the update callback
    vt.finished.finally(() => els.html.classList.remove("vt-theme"));
  } else applyTheme(theme);
}
// Ctrl+Shift+L steps through the themes in menu order
function toggleTheme() {
  const i = THEMES.findIndex((t) => t.id === els.html.dataset.theme);
  setTheme(THEMES[(i + 1) % THEMES.length].id, { animate: true });
}
function initialTheme() {
  const stored = localStorage.getItem("mdv-theme");
  if (themeById(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// The theme menu: a popover under the theme button (native light dismiss and Esc)
els.themeMenu = document.createElement("div");
els.themeMenu.id = "theme-menu";
els.themeMenu.className = "theme-menu";
els.themeMenu.popover = "auto";
els.themeMenu.setAttribute("role", "menu");
els.themeMenu.setAttribute("aria-label", "Theme");
for (const t of THEMES) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.pick = t.id;
  b.setAttribute("role", "menuitemradio");
  b.innerHTML = `<span class="sw" data-t="${t.id}"></span><span>${t.name}</span>`
    + `<svg class="tick" viewBox="0 0 16 16"><path d="M3.5 8.4 6.6 11.4 12.6 4.8"/></svg>`;
  b.addEventListener("click", () => { els.themeMenu.hidePopover(); setTheme(t.id, { animate: true, from: els.btnTheme }); });
  els.themeMenu.append(b);
}
document.body.append(els.themeMenu);
els.btnTheme.popoverTargetElement = els.themeMenu;
els.themeMenu.addEventListener("toggle", (e) => {
  const open = e.newState === "open";
  els.btnTheme.setAttribute("aria-expanded", String(open));
  if (open) (els.themeMenu.querySelector('[aria-checked="true"]') || els.themeMenu.querySelector("button")).focus();
});
els.themeMenu.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...els.themeMenu.querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
});

// ====================================================================================================
// Document I/O: open, save in place, save as (BOM and the file's line ending restored on save)
// ====================================================================================================

// opts.keepView: a reload of the same file (checkDisk) - no scroll reset, no selection clear, no arrival fade
function loadText(name, text, handle = null, opts = {}) {
  doc.bom = text.charCodeAt(0) === 0xfeff;
  if (doc.bom) text = text.slice(1);
  doc.eol = text.includes("\r\n") ? "\r\n" : "\n";
  const src = text.replace(/\r\n?/g, "\n");
  doc.handle = handle;
  doc.name = name;
  if (!opts.keepView) { doc.mtime = null; doc.size = null; }   // the opener stamps it (stampDisk)
  doc.savedText = src;
  doc.loaded = true;
  state.src = src;
  state.pending = null;
  state.saveError = false;
  state.saving = false;
  state.notice = "";
  state.large = src.length > LARGE;
  history.reset();
  hideHint();
  els.raw.value = src;
  hl.text = null;
  els.html.dataset.empty = "false";

  const mode = state.large ? "raw" : opts.keepView ? state.mode : "quick";
  state.mode = mode;
  els.html.dataset.mode = mode;
  els.page.contentEditable = mode === "quick" ? "true" : "false";
  if (state.large) {
    syncRawHL();
    requestAnimationFrame(hlVisible);
    state.model = null;
    state.modelStale = true;
    els.page.textContent = "";
  } else {
    state.model = Engine.buildModel(src);
    state.modelStale = false;
    renderAll();
  }
  if (opts.keepView) { if (mode !== "quick" && !state.large) syncRawHL(); refreshChrome(); return; }
  els.scroller.scrollTop = 0;
  document.getSelection().removeAllRanges();
  refreshChrome();
  if (!reduced()) els.sheet.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: EASE });
}

async function readFile(file) {
  // Decode with ignoreBOM so we can see (and later restore) a BOM.
  const buffer = await file.arrayBuffer();
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buffer);
}

async function openFromHandle(handle) {
  if (!confirmDiscard()) return;
  const file = await handle.getFile();
  loadText(file.name, await readFile(file), handle);
  stampDisk(file);
}

// ---- Watch the open file for writes from outside (an agent appending to a log, another editor).
// getFile() is a metadata call (timestamp + size); the content is only read when the stamp moves.
// No unsaved edits: reload in place, keeping mode and scroll. Unsaved edits: warn, and save asks first.
const DISK_POLL_MS = 5000;
function stampDisk(file) { doc.mtime = file.lastModified; doc.size = file.size; state.diskChanged = false; refreshChrome(); }

async function checkDisk({ force = false } = {}) {
  if (!doc.handle || typeof doc.handle.getFile !== "function" || state.saving || state.diskChecking) return;
  state.diskChecking = true;
  try {
    const file = await doc.handle.getFile();
    if (!force && file.lastModified === doc.mtime && file.size === doc.size) return;
    if (isDirty() && !(force && confirmDiscard())) { noteDiskChange(); return; }
    const before = state.src;
    const text = await readFile(file);
    // typed while the file was being read: keep the edit, treat it like any dirty buffer
    if (state.src !== before) { noteDiskChange(); return; }
    const changed = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n") !== doc.savedText;
    // a forced reload (Reload from disk, edits discarded) reloads even when the file itself is unchanged
    if (changed || force) reloadInPlace(text);
    stampDisk(file);
    if (changed) showNoteMessage("Reloaded - changed on disk");
    else if (force) showNoteMessage("Reloaded from disk");
  } catch (err) {
    if (err.name !== "NotFoundError") console.warn("[mdv] disk check failed", err);   // moved/deleted: stay quiet
  } finally {
    state.diskChecking = false;
  }
}

function noteDiskChange() {
  if (!state.diskChanged) showNoteMessage("Changed on disk - your save will ask before overwriting");
  state.diskChanged = true;
}

// Where an offset in the old source lands in the new one: unchanged before the edit, shifted with the
// text after it, and at the start of the change when it sat inside the replaced part.
function mapOffset(a, b, off) {
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && a[p] === b[p]) p++;
  if (off <= p) return off;
  let s = 0;
  while (s < n - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (off >= a.length - s) return off + b.length - a.length;
  return p;
}

// Reload the same file, keeping mode, scroll and the caret (as a source offset, moved with the text).
function reloadInPlace(text) {
  const top = els.scroller.scrollTop;
  const quick = state.mode === "quick";
  const hasCaret = quick ? selectionInPage() : document.activeElement === els.raw;
  const start = hasCaret ? currentCaret() : -1;
  const end = hasCaret && !quick ? els.raw.selectionEnd : start;
  const oldSrc = state.src;
  loadText(doc.name, text, doc.handle, { keepView: true });
  els.scroller.scrollTop = top;
  if (start < 0) return;
  const a = mapOffset(oldSrc, state.src, start), b = mapOffset(oldSrc, state.src, end);
  if (state.mode === "quick") {
    const pt = state.model && Engine.pointForSource(state.model, a);
    if (pt) setCaret(pt);
  } else {
    els.raw.setSelectionRange(a, b);
  }
  els.scroller.scrollTop = top;
}

setInterval(() => { if (!document.hidden) checkDisk(); }, DISK_POLL_MS);
window.addEventListener("focus", () => checkDisk());
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDisk(); });
COMMANDS.push({ label: "Reload from disk", keys: "", when: () => !!doc.handle, run: () => checkDisk({ force: true }) });

function confirmDiscard() {
  if (!isDirty()) return true;
  return window.confirm(`Discard unsaved changes to ${doc.name}?`);
}

function notice(text) { state.notice = text; refreshChrome(); }

async function openDialog() {
  if (!hasFileApi) return legacyOpen();
  try {
    const [handle] = await window.showOpenFilePicker({ types: MD_TYPES });
    await openFromHandle(handle);
  } catch (err) {
    if (err.name !== "AbortError") notice(`Could not open - ${err.message}`);
  }
}

function legacyOpen() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.markdown,.mdown,.mkd,.txt";
  input.onchange = async () => {
    const file = input.files[0];
    if (file && confirmDiscard()) { loadText(file.name, await readFile(file)); stampDisk(file); }
  };
  input.click();
}

function textForDisk(src = state.src) {
  let out = src;
  if (doc.eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (doc.bom) out = "﻿" + out;
  return out;
}

async function ensureWritePermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

function describeSaveError(err) {
  const msg = err && err.message ? err.message : "";
  if (err.name === "NotAllowedError" || err.name === "SecurityError" || /permission/i.test(msg)) return "permission to write was not granted";
  if (err.name === "NotFoundError") return "the file was moved or deleted";
  if (err.name === "QuotaExceededError" || /space|quota/i.test(msg)) return "the disk is full";
  if (err.name === "NoModificationAllowedError" || err.name === "InvalidStateError" || /read-only|locked/i.test(msg)) return "the file is read-only or locked";
  return msg || "the write did not complete";
}

async function save({ saveAs = false } = {}) {
  if (!doc.loaded || state.saving) return;
  const snapshot = state.src;
  try {
    let handle = doc.handle;
    if (!handle || saveAs) {
      if (!("showSaveFilePicker" in window)) { downloadCopy(); return; }
      handle = await window.showSaveFilePicker({ suggestedName: doc.name || "untitled.md", types: MD_TYPES });
    }
    state.saving = true;
    refreshChrome();
    if (!(await ensureWritePermission(handle))) {
      const e = new Error("write permission was not granted");
      e.name = "NotAllowedError";
      throw e;
    }
    // someone else wrote to the file since we last read or saved it: ask before overwriting their change
    if (handle === doc.handle && doc.mtime != null && typeof handle.getFile === "function") {
      const now = await handle.getFile();
      if ((now.lastModified !== doc.mtime || now.size !== doc.size) &&
          !window.confirm(`${doc.name} was changed on disk since you opened it (an agent or another app).\n\nOK = overwrite it with your version (their change is lost)\nCancel = keep theirs; use Save as to keep yours`)) {
        state.saving = false;
        refreshChrome();
        return;
      }
    }
    const writable = await handle.createWritable();
    await writable.write(textForDisk(snapshot));
    await writable.close();
    try { stampDisk(await handle.getFile()); } catch { /* stamp is best-effort; the write itself succeeded */ }
    if (handle !== doc.handle) { doc.handle = handle; doc.name = handle.name; }
    doc.savedText = snapshot;
    state.saving = false;
    state.saveError = false;
    // the dot means "unsaved until the write is confirmed": edits made during the save keep it
    if (isDirty()) refreshChrome(); else playSaved();
  } catch (err) {
    state.saving = false;
    if (err.name !== "AbortError") {
      state.saveError = true;
      state.saveErrorReason = describeSaveError(err);
      console.warn("[mdv] save failed", err);
    }
    refreshChrome();
  }
}

function downloadCopy() {
  const blob = new Blob([textForDisk()], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = doc.name || "untitled.md";
  a.click();
  URL.revokeObjectURL(a.href);
  doc.savedText = state.src;
  playSaved();
}

// ====================================================================================================
// Wiring
// ====================================================================================================

els.btnOpen.addEventListener("click", openDialog);
els.more.addEventListener("click", openPalette);
els.btnSave.addEventListener("click", () => save());
els.btnSaveAs.addEventListener("click", () => save({ saveAs: true }));
els.copyAll.addEventListener("click", copyAll);
els.pill.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode, { animate: true })));

document.addEventListener("keydown", (e) => {
  if (els.palette.open) {
    if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); closePalette(); }
    return; // the dialog handles Esc, arrows and Enter itself
  }
  const key = e.key.toLowerCase();
  if (e.key === "Escape") {
    if (hideHint()) return;
    if (state.mode === "quick" && document.activeElement === els.page) {
      dropPending();
      els.page.blur();
      document.getSelection().removeAllRanges();
    }
    return;
  }
  if (!e.ctrlKey || e.altKey) return;
  if (key === "s") { e.preventDefault(); save({ saveAs: e.shiftKey }); }
  else if (key === "o") { e.preventDefault(); openDialog(); }
  else if (key === "k") { e.preventDefault(); openPalette(); }
  else if (key === "e") { e.preventDefault(); if (doc.loaded) setMode(state.mode === "quick" ? "raw" : "quick", { animate: true }); }
  else if (key === "l" && e.shiftKey) { e.preventDefault(); toggleTheme(); }
});

window.addEventListener("beforeunload", (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
});

// Drag and drop: Chromium can give us a writable handle for the dropped file.
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  els.html.classList.add("dragging");
});
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els.html.classList.remove("dragging"); });
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.html.classList.remove("dragging");
  const item = [...e.dataTransfer.items].find((i) => i.kind === "file");
  if (!item) return;
  try {
    if (item.getAsFileSystemHandle) {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === "file") { await openFromHandle(handle); return; }
    }
    const file = item.getAsFile();
    if (file && confirmDiscard()) { loadText(file.name, await readFile(file)); stampDisk(file); }
  } catch (err) {
    notice(`Could not open the dropped file - ${err.message}`);
  }
});

// Installed-app file handling: Windows "Open with" / double-click delivers the file here.
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (params.files && params.files.length) {
      try { await openFromHandle(params.files[0]); }
      catch (err) { notice(`Could not open - ${err.message}`); }
    }
  });
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("[mdv] service worker failed", err));
}

observer.observe(els.page, { childList: true, characterData: true, subtree: true });
applyTheme(initialTheme());
refreshChrome();
document.fonts.ready.then(placeThumb);
new ResizeObserver(placeThumb).observe(els.pill);

// Test hook (tests/*.py). setMode / setTheme apply synchronously, without View Transitions.
window.mdv = {
  loadText,
  openFromHandle,
  checkDisk,
  save,
  setMode: (mode) => setMode(mode),
  setTheme: (theme) => setTheme(theme),
  mode: () => state.mode,
  doc,
  textForDisk,
  qe: {
    get src() { return state.src; },
    get mode() { return state.mode; },
    get lastBlock() { return state.lastBlock; },
    get blockCount() { return state.blockCount; },
    get undoDepth() { return history.undo.length; },
    get pending() { return state.pending; },
    get perf() { return state.perf; },
    get rawPerf() { return state.rawPerf; },
    get hlPerf() { return state.hlPerf; },
    get lastPinShift() { return state.lastPinShift || 0; },
    hlChunks: () => hl.chunks.length,
    // Raw alignment probes: the textarea-metric mirror's y for a source offset, and the syntax pre's own y
    rawY: (o) => rawOffsetsY([o])(o),
    hlY: (o) => {
      const w = document.createTreeWalker(els.rawhl, NodeFilter.SHOW_TEXT);
      let k = o;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (k < n.data.length) {
          const r = document.createRange();
          r.setStart(n, k); r.setEnd(n, k + 1);
          return r.getBoundingClientRect().top - els.rawhl.getBoundingClientRect().top;
        }
        k -= n.data.length;
      }
      return null;
    },
    get stats() { return Engine.stats; },
    get selfCheck() { return Engine.selfCheck; },
    set selfCheck(v) { Engine.selfCheck = v; },
    buildModel: Engine.buildModel,
    structure: () => state.model.skel.filter((x) => !/^[LKC]:/.test(x)),
    leafTexts: () => state.model.leaves.map((l) => l.partsDisplay),
    frozenLeaves: () => state.model.leaves.filter((l) => !l.parts.length || l.frozen).map((l) => l.display),
    caretSource,
    rawCaret: () => els.raw.selectionStart,
  },
};
