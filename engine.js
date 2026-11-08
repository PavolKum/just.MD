// just.MD - Quick Edit engine (pure model, no editing DOM).
//
// The model in one paragraph: the page is a pure function of the source string. The lexer gives
// top-level tokens; buildModel() walks them against the source and gives every visible text character
// a source offset. Characters are grouped into "leaves" (one run of plain text inside one formatting
// context: a heading's text, the text inside **bold**, a table cell, a code body). An edit is a source
// replacement inside one leaf, accepted only if re-lexing gives the same structure skeleton with just
// that leaf's text changed.
//
// Speed: an edit re-lexes only a window (the edited top-level block plus one neighbour on each side),
// guarded by "the window's raws concatenate to the window's source" and "the neighbours lex exactly as
// before". Anything the window cannot confirm falls back to a full re-lex of the document.

"use strict";

const Engine = (() => {
  const stats = { fast: 0, full: 0, fallback: 0, selfCheckFail: 0, selfChecks: 0 };
  let selfCheck = false; // tests switch this on: every fast patch is compared with a full rebuild

  // ---------- small helpers ----------

  const decoder = document.createElement("textarea");
  function decodeEntity(s) { decoder.innerHTML = s; return decoder.value; }
  function escHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function norm(s) { return s.replace(/\s+/g, " ").trim(); }
  const PUNCT = /[\\`*_{}\[\]()#+\-.!|<>~&:=]/;
  function escapeMd(s) { return s.replace(/[\\`*_{}\[\]()#+\-.!|<>~&:=]/g, "\\$&"); }
  const ENTITY = /^&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i;
  const GAP_FIRST = /^[\s>*+\-\d.)#\[\]xX|:]*$/;  // syntax that may precede a container's first line
  const GAP_CONT = /^[ \t>]*$/;                    // dedent / blockquote prefixes before later lines
  function decodeAll(s) { return s.indexOf("&") < 0 ? s : s.replace(/&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (x) => decodeEntity(x)); }

  function lex(src, links) {
    const lexer = new marked.Lexer({ gfm: true });
    if (links) for (const k in links) lexer.tokens.links[k] = links[k];
    return lexer.lex(src);
  }

  // ---------- model: tokens -> leaves with source offsets + a structure skeleton ----------

  function emptyModel(src, tokens, bases) {
    return {
      src, tokens, leaves: [], skel: [], boxes: [], blocks: [], exact: true,
      leafBase: bases ? bases.leaf : 0, skelBase: bases ? bases.skel : 0, boxBase: bases ? bases.box : 0,
    };
  }

  function buildModel(src) {
    const m = emptyModel(src, lex(src));
    walkTokens(m, m.tokens, 0);
    // the raw-concatenation guard: every top-level token sits exactly where the previous one ended
    m.joined = m.exact && (m.blocks.length ? m.blocks[m.blocks.length - 1].e : 0) === src.length;
    return m;
  }

  function walkTokens(m, tokens, pos) {
    for (const t of tokens) {
      const s = m.src.startsWith(t.raw, pos) ? pos : m.src.indexOf(t.raw, pos);
      const blk = {
        tok: t, s: s < 0 ? pos : s, e: pos,
        leaf0: m.leafBase + m.leaves.length, skel0: m.skelBase + m.skel.length, box0: m.boxBase + m.boxes.length,
      };
      if (s !== pos) m.exact = false;
      if (s < 0) m.skel.push("?" + t.type + ":" + t.raw);
      else {
        walkBlock(m, t, s, s + t.raw.length, { p: s });
        pos = s + t.raw.length;
        blk.e = pos;
      }
      blk.leaf1 = m.leafBase + m.leaves.length;
      blk.skel1 = m.skelBase + m.skel.length;
      blk.box1 = m.boxBase + m.boxes.length;
      m.blocks.push(blk);
    }
    return pos;
  }

  // Map container text C (what marked lexed the inline content from) onto the source, line by line.
  // Returns an array: C index -> absolute source offset, or null if it cannot be placed exactly.
  function alignText(src, C, from, to) {
    if (!C.length) return [];
    const map = new Array(C.length);
    const lines = C.split("\n");
    let j = from;
    let ci = 0;
    for (let li = 0; li < lines.length; li++) {
      if (li > 0) {
        const nl = src.indexOf("\n", j);
        if (nl < 0 || nl >= to || !GAP_CONT.test(src.slice(j, nl))) return null;
        map[ci++] = nl;
        j = nl + 1;
      }
      const line = lines[li];
      if (!line.length) continue;
      const k = src.indexOf(line, j);
      if (k >= 0 && k + line.length <= to && (li === 0 ? GAP_FIRST : GAP_CONT).test(src.slice(j, k))) {
        for (let x = 0; x < line.length; x++) map[ci++] = k + x;
        j = k + line.length;
        continue;
      }
      // Fallback: greedy match that allows a backslash before a character (table cells: "\|" -> "|").
      while (j < to && /[ \t>]/.test(src[j]) && src[j] !== line[0]) j++;
      for (let x = 0; x < line.length; x++) {
        const ch = line[x];
        if (src[j] === ch) map[ci++] = j++;
        else if (src[j] === "\\" && src[j + 1] === ch) { j++; map[ci++] = j++; }
        else return null;
        if (j > to) return null;
      }
    }
    return map;
  }

  function walkBlock(m, t, s, e, cur) {
    const src = m.src;
    switch (t.type) {
      case "space": return;
      case "heading": {
        m.skel.push("h" + t.depth);
        const head = /^ {0,3}#{1,6}(?=[ \t]|\n|$)[ \t]*/.exec(src.slice(cur.p, e));
        if (head) cur.p += head[0].length;
        container(m, t.tokens, t.text, cur, e, true);
        m.skel.push("/h");
        return;
      }
      case "paragraph":
        m.skel.push("p");
        container(m, t.tokens, t.text, cur, e, true);
        m.skel.push("/p");
        return;
      case "text": // block-level text inside list items
        m.skel.push("t");
        container(m, t.tokens || [{ type: "text", raw: t.text, text: t.text }], t.text, cur, e, true);
        m.skel.push("/t");
        return;
      case "list": {
        m.skel.push(`list:${t.ordered}:${t.start}`);
        for (const item of t.items) {
          let is = src.indexOf(item.raw, cur.p);
          let ie;
          if (is < 0 || is + item.raw.length > e) { is = cur.p; ie = e; } else ie = is + item.raw.length;
          m.skel.push(`li:${item.task}:${item.checked}`);
          const icur = { p: is };
          for (const child of item.tokens) walkBlock(m, child, is, ie, icur);
          m.skel.push("/li");
          cur.p = Math.max(icur.p, ie === e ? icur.p : ie);
        }
        m.skel.push("/list");
        return;
      }
      case "checkbox": {
        const mm = /\[([ xX])\]/.exec(src.slice(cur.p, e));
        const liLocal = m.skel.map((x) => x.startsWith("li:")).lastIndexOf(true);
        m.skel.push(`cb:${t.checked}`);
        if (mm) {
          t._box = m.boxBase + m.boxes.length;
          m.boxes.push({
            s: cur.p + mm.index + 1, checked: t.checked,
            cbIdx: m.skelBase + m.skel.length - 1, liIdx: liLocal >= 0 ? m.skelBase + liLocal : -1,
          });
          cur.p += mm.index + 3;
        }
        return;
      }
      case "blockquote":
        m.skel.push("bq");
        for (const child of t.tokens) walkBlock(m, child, s, e, cur);
        m.skel.push("/bq");
        return;
      case "code": {
        m.skel.push(`code:${t.lang || ""}:${t.codeBlockStyle || "fenced"}`);
        const fence = /^\s*(`{3,}|~{3,})[^\n]*\n/.exec(src.slice(cur.p, e));
        if (fence) cur.p += fence[0].length;
        const map = alignText(src, t.text, cur.p, e);
        const leaf = newLeaf(m, "code");
        if (map && t.text.length) addChars(m, leaf, t, t.text, map, 0, t.text.length, true);
        leaf.display = t.text;
        closeLeaf(m, leaf);
        if (map && map.length) cur.p = map[map.length - 1] + 1;
        m.skel.push("/code");
        return;
      }
      case "table": {
        m.skel.push(`table:${t.align.join(",")}:${t.header.length}:${t.rows.length}`);
        const lineStarts = [s];
        for (let i = s; i < e; i++) if (src[i] === "\n") lineStarts.push(i + 1);
        const rowCells = (lineIdx, cells, tag) => {
          m.skel.push("tr");
          const ls = lineStarts[lineIdx];
          let le = src.indexOf("\n", ls);
          if (le < 0 || le > e) le = e;
          const ranges = splitCells(src, ls, le);
          cells.forEach((cell, ci) => {
            m.skel.push(tag);
            const r = ranges[ci] || [le, le];
            container(m, cell.tokens, cell.text, { p: r[0] }, r[1], false);
            m.skel.push("/" + tag);
          });
          m.skel.push("/tr");
        };
        rowCells(0, t.header, "th");
        t.rows.forEach((row, ri) => rowCells(ri + 2, row, "td"));
        m.skel.push("/table");
        return;
      }
      case "html": m.skel.push("html:" + t.raw.trim()); return;
      case "hr": m.skel.push("hr"); return;
      case "def": m.skel.push(`def:${t.tag}:${t.href}:${t.title || ""}`); return;
      default: m.skel.push("?" + t.type + ":" + t.raw);
    }
  }

  // Cell content ranges of one table row line, split on unescaped pipes and trimmed.
  function splitCells(src, ls, le) {
    const bounds = [];
    for (let i = ls; i < le; i++) {
      if (src[i] === "\\") { i++; continue; }
      if (src[i] === "|") bounds.push(i);
    }
    const line = src.slice(ls, le);
    const edges = [];
    if (!/^\s*\|/.test(line)) edges.push(ls - 1);
    edges.push(...bounds);
    if (!/\|\s*$/.test(line)) edges.push(le);
    const out = [];
    for (let k = 0; k + 1 < edges.length; k++) {
      let a = edges[k] + 1, b = edges[k + 1];
      while (a < b && /[ \t]/.test(src[a])) a++;
      while (b > a && /[ \t]/.test(src[b - 1])) b--;
      out.push([a, b]);
    }
    return out;
  }

  function container(m, tokens, C, cur, end, extendTrailing) {
    const map = alignText(m.src, C, cur.p, end);
    if (map && map.length) cur.p = map[map.length - 1] + 1;
    const ctx = { m, C, map, end, extendTrailing };
    walkInline(ctx, tokens || [], 0, C.length, true);
  }

  function leafKey(kind, display) {
    return kind === "inline" ? "L:" + norm(display) : (kind === "code" ? "K:" : "C:") + display;
  }

  function newLeaf(m, kind) {
    const leaf = { id: m.leafBase + m.leaves.length, kind, parts: [], display: "", skelIdx: -1, prevEnd: -1 };
    m.leaves.push(leaf);
    return leaf;
  }

  function closeLeaf(m, leaf) {
    m.skel.push(leafKey(leaf.kind, leaf.display));
    leaf.skelIdx = m.skelBase + m.skel.length - 1;
    leaf.partsDisplay = leaf.parts.map((p) => p.disp).join("");
  }

  // Add the characters C[a,b) of token t to a leaf as runs (identity) and atoms (display != source).
  function addChars(m, leaf, t, C, map, a, b, isCode) {
    t._parts = t._parts || [];
    t._leaf = leaf.id;
    const push = (kind, disp, dom, s, e) => {
      const d = leaf.parts.length ? leaf.parts[leaf.parts.length - 1].d + leaf.parts[leaf.parts.length - 1].dl : 0;
      const last = t._parts[t._parts.length - 1];
      if (kind === "run" && last && last.kind === "run" && last.e === s) {
        last.e = e; last.disp += disp; last.dl += disp.length; last.text += disp;
        return;
      }
      const part = { kind, disp, dom, s, e, d, dl: disp.length, text: kind === "run" ? disp : "" };
      leaf.parts.push(part);
      t._parts.push(part);
    };
    if (t.type === "escape") {
      const s = leaf.prevEnd >= 0 ? leaf.prevEnd : map[a];
      push("atom", t.text, t.text, s, map[b - 1] + 1);
      leaf.prevEnd = map[b - 1] + 1;
      return;
    }
    let i = a;
    while (i < b) {
      if (!isCode && C[i] === "&") {
        const ent = ENTITY.exec(C.slice(i, b));
        if (ent && decodeEntity(ent[0]) !== ent[0]) {
          const s = leaf.prevEnd >= 0 ? leaf.prevEnd : map[i];
          const dec = decodeEntity(ent[0]);
          push("atom", dec, dec, s, map[i + ent[0].length - 1] + 1);
          leaf.prevEnd = map[i + ent[0].length - 1] + 1;
          i += ent[0].length;
          continue;
        }
      }
      const ch = C[i];
      const s = map[i];
      const hasGapBefore = leaf.prevEnd >= 0 && s !== leaf.prevEnd;
      if (ch === "\n") {
        // the newline owns any dedent / "> " prefix that follows it
        const next = i + 1 < C.length ? map[i + 1] : s + 1;
        const start = hasGapBefore ? leaf.prevEnd : s;
        if (isCode && next === s + 1 && !hasGapBefore) push("run", "\n", "\n", s, s + 1);
        else push("atom", "\n", isCode ? "\n" : " ", start, next);
        leaf.prevEnd = next;
      } else if (hasGapBefore) {
        push("atom", ch, ch, leaf.prevEnd, s + 1); // e.g. "\|" shown as "|"
        leaf.prevEnd = s + 1;
      } else {
        push("run", ch, ch, s, s + 1);
        leaf.prevEnd = s + 1;
      }
      i++;
    }
  }

  function walkInline(ctx, tokens, from, to, isContainerTop) {
    const { m, C } = ctx;
    const map = ctx.map;
    let c = from;
    let leaf = null;
    let lastTextTok = null;
    const close = () => {
      if (!leaf) return;
      if (ctx.extendTrailing && isContainerTop && map && leaf.parts.length && lastTextTok && lastTextTok.raw && c >= to) {
        // let the caret sit after trailing spaces the user types at the end of a heading/cell/paragraph
        const lastPart = leaf.parts[leaf.parts.length - 1];
        let j = lastPart.e;
        while (j < ctx.end && /[ \t]/.test(m.src[j])) j++;
        if (j > lastPart.e) {
          const sp = m.src.slice(lastPart.e, j);
          lastTextTok._parts = lastTextTok._parts || [];
          if (lastPart.kind === "run" && lastTextTok._parts.includes(lastPart)) {
            lastPart.e = j; lastPart.disp += sp; lastPart.dl += sp.length; lastPart.text += sp;
          } else {
            const part = { kind: "run", disp: sp, dom: sp, s: lastPart.e, e: j, d: lastPart.d + lastPart.dl, dl: sp.length, text: sp };
            leaf.parts.push(part); lastTextTok._parts.push(part);
          }
        }
      }
      closeLeaf(m, leaf);
      leaf = null;
    };
    for (const t of tokens) {
      let a = C.startsWith(t.raw, c) ? c : C.indexOf(t.raw, c);
      const located = a >= 0 && a + t.raw.length <= to;
      if (!located) a = c;
      const b = located ? a + t.raw.length : c;
      const tmap = located ? map : null;
      if (t.type === "text" || t.type === "escape") {
        if (!leaf) leaf = newLeaf(m, "inline");
        const disp = t.type === "escape" ? t.text : decodeAll(t.text);
        leaf.display += disp;
        if (tmap) addChars(m, leaf, t, C, tmap, a, b, false);
        else leaf.frozen = true;
        lastTextTok = t;
      } else {
        close();
        switch (t.type) {
          case "strong": case "em": case "del":
            m.skel.push(t.type);
            walkInline({ ...ctx, map: tmap }, t.tokens, a, b, false);
            m.skel.push("/" + t.type);
            break;
          case "link": {
            // autolinks and [shortcut]/[collapsed][] references: the text IS the target, so freeze it
            const frozen = !t.raw.startsWith("[") || !(/\]\(/.test(t.raw) || /\]\[[^\]]+\]$/.test(t.raw));
            m.skel.push(`a:${t.href}:${t.title || ""}${frozen ? ":" + t.text : ""}`);
            walkInline({ ...ctx, map: frozen ? null : tmap }, t.tokens || [], a, b, false);
            m.skel.push("/a");
            break;
          }
          case "codespan": {
            m.skel.push("code");
            const lf = newLeaf(m, "codespan");
            const k = t.raw.indexOf(t.text);
            if (tmap && k > 0 && t.text.length) addChars(m, lf, t, C, tmap, a + k, a + k + t.text.length, true);
            lf.display = t.text;
            closeLeaf(m, lf);
            m.skel.push("/code");
            break;
          }
          case "image": m.skel.push(`img:${t.href}:${t.text}:${t.title || ""}`); break;
          case "html": m.skel.push("ih:" + t.raw); break;
          case "br": m.skel.push("br"); break;
          case "checkbox": m.skel.push(`cb:${t.checked}`); break;
          default: m.skel.push("?" + t.type + ":" + t.raw);
        }
      }
      c = b;
    }
    close();
  }

  // ---------- leaf geometry (display offset d <-> source offset) ----------

  function dToS(leaf, d) {
    for (const p of leaf.parts) {
      if (p.kind === "run" && p.d <= d && d <= p.d + p.dl) return p.s + (d - p.d);
      if (p.kind === "atom" && d === p.d) return p.s;
      if (p.kind === "atom" && d === p.d + p.dl) return p.e;
    }
    return -1;
  }
  function leafLen(leaf) { return leaf.partsDisplay.length; }
  function unitBefore(leaf, d) {
    for (const p of leaf.parts) {
      if (p.d < d && d <= p.d + p.dl) {
        if (p.kind === "atom") return [p.d, p.d + p.dl];
        const k = d - 1 - p.d;
        const code = p.text.charCodeAt(k);
        return (code >= 0xdc00 && code <= 0xdfff && k > 0) ? [d - 2, d] : [d - 1, d];
      }
    }
    return null;
  }
  function unitAfter(leaf, d) {
    for (const p of leaf.parts) {
      if (p.d <= d && d < p.d + p.dl) {
        if (p.kind === "atom") return [p.d, p.d + p.dl];
        const code = p.text.charCodeAt(d - p.d);
        return (code >= 0xd800 && code <= 0xdbff) ? [d, d + 2] : [d, d + 1];
      }
    }
    return null;
  }
  function snapToParts(leaf, d, dir) {
    // a display offset inside an atom snaps to the atom's edge
    for (const p of leaf.parts) {
      if (p.kind === "atom" && p.d < d && d < p.d + p.dl) return dir < 0 ? p.d : p.d + p.dl;
    }
    return d;
  }
  function editableLeaves(m) { return m.leaves.filter((l) => l.parts.some((p) => p.kind === "run")); }

  // nearest editable point for a source offset (Raw -> Quick, undo)
  function pointForSource(m, pos) {
    let best = null;
    for (const leaf of m.leaves) {
      for (const p of leaf.parts) {
        if (p.kind !== "run") continue;
        if (p.s <= pos && pos <= p.e) return { leaf: leaf.id, d: p.d + (pos - p.s) };
        if (p.s > pos && (!best || p.s < best.s)) best = { s: p.s, pt: { leaf: leaf.id, d: p.d } };
      }
    }
    return best ? best.pt : null;
  }

  function findBlock(m, lo0, hi0, keyStart, keyEnd, id) {
    let lo = 0, hi = m.blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = m.blocks[mid];
      if (id < b[keyStart]) hi = mid - 1;
      else if (id >= b[keyEnd]) lo = mid + 1;
      else return mid;
    }
    return -1;
  }
  function blockOfLeaf(m, id) { return findBlock(m, 0, 0, "leaf0", "leaf1", id); }
  function blockOfBox(m, id) { return findBlock(m, 0, 0, "box0", "box1", id); }
  function blockAt(m, pos) {
    let lo = 0, hi = m.blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = m.blocks[mid];
      if (pos < b.s) hi = mid - 1;
      else if (pos >= b.e) lo = mid + 1;
      else return mid;
    }
    return Math.max(0, Math.min(m.blocks.length - 1, lo));
  }

  // ---------- verification and patching ----------

  function sameSkel(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // The single verification gate: same structure skeleton, and the edited leaf shows exactly the wanted text.
  function accepts(gotSkel, expectSkel, leafOk) {
    return sameSkel(gotSkel, expectSkel) && leafOk;
  }

  const FALLBACK = { fallback: true };

  function windowAround(m, bi) {
    let i0 = bi, i1 = bi;
    while (i0 > 0) { i0--; if (m.blocks[i0].tok.type !== "space") break; }
    while (i1 < m.blocks.length - 1) { i1++; if (m.blocks[i1].tok.type !== "space") break; }
    return [i0, i1];
  }

  function shiftSub(sub, by) {
    for (const b of sub.blocks) { b.s += by; b.e += by; }
    for (const l of sub.leaves) for (const p of l.parts) { p.s += by; p.e += by; }
    for (const x of sub.boxes) x.s += by;
  }

  function planWindow(m, bi, next, delta, expectMut, leafCheck) {
    const [i0, i1] = windowAround(m, bi);
    const b0 = m.blocks[i0], b1 = m.blocks[i1];
    const ws = b0.s, we = b1.e + delta;
    const text = next.slice(ws, we);
    let toks;
    try { toks = lex(text, m.tokens.links); } catch (err) { return FALLBACK; }
    if (toks.length !== i1 - i0 + 1) return FALLBACK;
    let joined = "";
    for (const t of toks) joined += t.raw;
    if (joined !== text) return FALLBACK;                    // raw-concatenation == source, for the window
    for (let i = i0; i <= i1; i++) {
      const old = m.blocks[i].tok, nt = toks[i - i0];
      if (nt.type !== old.type) return FALLBACK;
      if (i !== bi && nt.raw !== old.raw) return FALLBACK;   // neighbours must lex exactly as before
    }
    const sub = emptyModel(text, toks, { leaf: b0.leaf0, skel: b0.skel0, box: b0.box0 });
    const end = walkTokens(sub, toks, 0);
    if (!sub.exact || end !== text.length) return FALLBACK;
    shiftSub(sub, ws);
    const expect = m.skel.slice(b0.skel0, b1.skel1);
    expectMut(expect, b0.skel0);
    const leafOk = leafCheck((id) => sub.leaves[id - sub.leafBase]);
    if (!accepts(sub.skel, expect, leafOk)) return null;
    return { full: false, i0, i1, sub, delta, next };
  }

  // Plan a source replacement [s,e) -> ins. Returns a plan, or null when the structure would change.
  function planEdit(m, s, e, ins, bi, expectMut, leafCheck) {
    const next = m.src.slice(0, s) + ins + m.src.slice(e);
    const delta = ins.length - (e - s);
    if (m.joined && bi >= 0) {
      const plan = planWindow(m, bi, next, delta, expectMut, leafCheck);
      if (plan !== FALLBACK) { if (plan) stats.fast++; return plan; }
      stats.fallback++;
    }
    stats.full++;
    const nm = buildModel(next);
    const expect = m.skel.slice();
    expectMut(expect, 0);
    const leafOk = leafCheck((id) => nm.leaves[id]);
    return accepts(nm.skel, expect, leafOk) ? { full: true, model: nm, next, i0: 0, i1: nm.blocks.length - 1 } : null;
  }

  // Apply a plan: the old model is patched in place (window spliced, later offsets shifted).
  function commit(m, plan) {
    if (plan.full) return plan.model;
    const { i0, i1, sub, delta } = plan;
    const b0 = m.blocks[i0], b1 = m.blocks[i1];
    const n = i1 - i0 + 1;
    for (let i = i1 + 1; i < m.blocks.length; i++) { m.blocks[i].s += delta; m.blocks[i].e += delta; }
    for (let L = b1.leaf1 - m.leafBase; L < m.leaves.length; L++) for (const p of m.leaves[L].parts) { p.s += delta; p.e += delta; }
    for (let B = b1.box1; B < m.boxes.length; B++) m.boxes[B].s += delta;
    m.tokens.splice(i0, n, ...sub.tokens);
    m.blocks.splice(i0, n, ...sub.blocks);
    m.leaves.splice(b0.leaf0, b1.leaf1 - b0.leaf0, ...sub.leaves);
    m.skel.splice(b0.skel0, b1.skel1 - b0.skel0, ...sub.skel);
    m.boxes.splice(b0.box0, b1.box1 - b0.box0, ...sub.boxes);
    m.src = plan.next;
    if (selfCheck) compareWithFull(m);
    return m;
  }

  function compareWithFull(m) {
    stats.selfChecks++;
    const f = buildModel(m.src);
    const partKey = (p) => `${p.kind}|${p.s}|${p.e}|${p.d}|${p.dl}|${p.disp}`;
    let ok = sameSkel(f.skel, m.skel) && f.leaves.length === m.leaves.length && f.boxes.length === m.boxes.length
      && f.blocks.length === m.blocks.length;
    for (let i = 0; ok && i < f.leaves.length; i++) {
      const a = f.leaves[i], b = m.leaves[i];
      ok = a.id === b.id && a.skelIdx === b.skelIdx && a.parts.length === b.parts.length
        && a.parts.every((p, k) => partKey(p) === partKey(b.parts[k]));
    }
    for (let i = 0; ok && i < f.boxes.length; i++) {
      const a = f.boxes[i], b = m.boxes[i];
      ok = a.s === b.s && a.cbIdx === b.cbIdx && a.liIdx === b.liIdx && a.checked === b.checked;
    }
    for (let i = 0; ok && i < f.blocks.length; i++) ok = f.blocks[i].s === m.blocks[i].s && f.blocks[i].e === m.blocks[i].e;
    if (!ok) { stats.selfCheckFail++; console.warn("[mdv] fast patch differs from a full rebuild"); }
  }

  // Replace display range [dA,dB) of a leaf with `text`, trying escaped variants. Returns a plan or null.
  function editLeaf(m, leafId, dA, dB, text) {
    const leaf = m.leaves[leafId];
    const sA = dToS(leaf, dA);
    const sB = dToS(leaf, dB);
    if (sA < 0 || sB < 0) return null;
    const want = leaf.partsDisplay.slice(0, dA) + text + leaf.partsDisplay.slice(dB);
    const key = leafKey(leaf.kind, want);
    const cands = [{ s: sA, e: sB, ins: text }];
    if (leaf.kind === "inline") {
      const esc = escapeMd(text);
      if (esc !== text) cands.push({ s: sA, e: sB, ins: esc });
      const prev = m.src[sA - 1];
      const prevInRun = leaf.parts.some((p) => p.kind === "run" && p.s <= sA - 1 && sA - 1 < p.e);
      if (prev && PUNCT.test(prev) && prevInRun) {
        cands.push({ s: sA - 1, e: sB, ins: "\\" + prev + text });
        if (esc !== text) cands.push({ s: sA - 1, e: sB, ins: "\\" + prev + esc });
      }
    }
    const bi = blockOfLeaf(m, leafId);
    const skelIdx = leaf.skelIdx;
    const expectMut = (arr, base) => { arr[skelIdx - base] = key; };
    const leafCheck = (get) => { const l = get(leafId); return !!l && l.partsDisplay === want && !l.frozen; };
    for (const c of cands) {
      const plan = planEdit(m, c.s, c.e, c.ins, bi, expectMut, leafCheck);
      if (plan) { plan.d = dA + text.length; return plan; }
    }
    return null;
  }

  // Task boxes: flip exactly the one character between the brackets.
  function toggleBox(m, index) {
    const box = m.boxes[index];
    if (!box) return null;
    const ch = box.checked ? " " : "x";
    const expectMut = (arr, base) => {
      arr[box.cbIdx - base] = `cb:${!box.checked}`;
      if (box.liIdx >= 0) arr[box.liIdx - base] = arr[box.liIdx - base].replace(/:(true|false)$/, `:${!box.checked}`);
    };
    return planEdit(m, box.s, box.s + 1, ch, blockOfBox(m, index), expectMut, () => true);
  }

  // ---------- rendering ----------

  marked.use({
    renderer: {
      text(token) {
        if (token.tokens || !token._parts) return false;
        return renderParts(token);
      },
      codespan(token) {
        if (!token._parts) return false;
        return `<code>${renderParts(token)}</code>`;
      },
      code(token) {
        if (!token._parts) return false;
        const lang = (token.lang || "").split(/\s/)[0];
        const cls = lang ? ` class="language-${escHtml(lang)}"` : "";
        const parts = token._parts;
        let inner;
        if (parts.length === 1 && lang && hljs.getLanguage(lang)) {
          const p = parts[0];
          const hl = hljs.highlight(p.text, { language: lang, ignoreIllegals: true }).value;
          inner = runSpan(token._leaf, p, hl);
        } else inner = renderParts(token);
        return `<pre><code${cls}>${inner}</code></pre>\n`;
      },
      checkbox(token) {
        const box = token._box == null ? "" : ` data-box="${token._box}"`;
        return `<input type="checkbox"${box}${token.checked ? " checked" : ""}> `;
      },
    },
  });

  function runSpan(leaf, p, innerHtml) {
    return `<span class="qe-r" data-l="${leaf}" data-d="${p.d}">${innerHtml}</span>`;
  }
  function renderParts(token) {
    return token._parts.map((p) => p.kind === "run"
      ? runSpan(token._leaf, p, escHtml(p.text))
      : `<span class="qe-a" data-l="${token._leaf}" data-d="${p.d}" data-dl="${p.dl}">${escHtml(p.dom)}</span>`).join("");
  }

  // One wrapper per top-level token, so an edit can replace just its own block in the DOM.
  function blockHtml(tok, i) {
    return `<div class="b" data-b="${i}">${marked.parser([tok])}</div>`;
  }
  function blocksHtml(m, i0, i1) {
    let html = "";
    for (let i = i0; i <= i1; i++) html += blockHtml(m.tokens[i], i);
    return html;
  }

  return {
    stats, buildModel, editLeaf, toggleBox, commit, blocksHtml, dToS, leafLen, unitBefore, unitAfter, snapToParts,
    editableLeaves, pointForSource, blockAt, blockOfLeaf,
    get selfCheck() { return selfCheck; },
    set selfCheck(v) { selfCheck = !!v; },
  };
})();
