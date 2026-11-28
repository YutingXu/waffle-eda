"use strict";
// Every literal name the app passes to AtriumLazy.need() can load. need() loads a registered
// module; for any other name lazy.js load() resolves only when the global already exists and
// otherwise rejects "<name> is not available in this build." So a name must be one of:
//   - a module registered at startup (lazy.js, an inline index.html script or an eager script);
//   - a global an eager <script src> defines;
//   - registered or defined by the calling file itself, or by a file of the calling file's
//     module or its dependencies (a lazy file runs only after those);
//   - listed in SAFE below, with the reason it exists whenever that call runs.
// A call that runs while its file evaluates (at top level, in an immediately invoked function, in
// a synchronous array callback or in a function called by name there) runs before the files after
// it, so for it the provider must come earlier: earlier in the same file, in an earlier page
// script, or before the calling file in the file order of every module that loads it.
// The calls: X.need(), X.need?.(), appendOnLoad() and prefetch() (both load through need()),
// lazy.js's own need(), appendOnLoad() and prefetch(), and local loader bindings: wrappers such as
// const need = name => G[name] || G.AtriumLazy.need(name), aliases and destructured methods.
// A name is a string in any quote form or a template literal without substitutions: the argument,
// an element of an array literal, or a branch of ?:, || or ?? in either.
// Runs under Node and under JavaScriptCore (scripts/test-jsc.sh lazy-need-names).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {inventoryFrom} = require("../support/app-source-paths.cjs");
const app = path.join(__dirname, "../../app");
const read = f => String(fs.readFileSync(path.join(app, f), "utf8"));
const LOADER = "lazy.js";

// ---- A small JavaScript scanner -------------------------------------------------------------
// Tokens outside comments: "id", "num", "str" (a quoted string or a template literal without
// substitutions; v is its text), "tmpl" (a piece of a template literal with substitutions),
// "re" and "p" (punctuation).
const SPACE = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/y;
const STR = /"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/y;
const ID = /[A-Za-z_$\u00a0-\uffff][\w$\u00a0-\uffff]*/y;
const NUM = /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;
const REGEX = /\/(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*/y;
const PUNCT = /\.\.\.|\?\.(?!\d)|=>|>>>=?|<<=|>>=|\*\*=?|[=!]==?|[<>+\-*/%&|^]=|&&=?|\|\|=?|\?\?=?|\+\+|--|<<|>>|[{}()[\];,<>+\-*/%&|^!~?:=.@#]/y;
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
function scan(src) {
  const out = [], braces = []; // one entry per open "{" (false) or "${" (true)
  let i = 0, line = 1;
  const at = re => { re.lastIndex = i; const m = re.exec(src); return m && m[0]; };
  const count = text => { for (let k = text.indexOf("\n"); k >= 0; k = text.indexOf("\n", k + 1)) line++; };
  const emit = (t, v, start, first) => out.push({t, v, i: start, line: first});
  const regexAllowed = () => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.t === "id") return BEFORE_EXPRESSION.has(p.v);
    return p.t === "p" && p.v !== ")" && p.v !== "]" && p.v !== "}";
  };
  function template(start, fresh) { // i is just past the opening ` or the } that closes a ${
    const first = line;
    for (let k = i; k < src.length; k++) {
      const c = src[k];
      if (c === "\\") { if (src[k + 1] === "\n") line++; k++; continue; }
      if (c === "\n") line++;
      else if (c === "`") { emit(fresh ? "str" : "tmpl", src.slice(i, k), start, first); i = k + 1; return; }
      else if (c === "$" && src[k + 1] === "{") { emit("tmpl", null, start, first); braces.push(true); i = k + 2; return; }
    }
    i = src.length;
  }
  while (i < src.length) {
    let m = at(SPACE);
    if (m) { count(m); i += m.length; continue; }
    const c = src[i], start = i;
    if (c === "\"" || c === "'") {
      m = at(STR) || c;
      emit("str", m.slice(1, -1), start, line); count(m); i += m.length;
    } else if (c === "`") { i++; template(start, true); }
    else if (c === "}" && braces[braces.length - 1] === true) { braces.pop(); i++; template(start, false); }
    else if ((m = at(ID))) { emit("id", m, start, line); i += m.length; }
    else if ((c >= "0" && c <= "9" || c === ".") && (m = at(NUM))) { emit("num", m, start, line); i += m.length; }
    else if (c === "/" && regexAllowed() && (m = at(REGEX))) { emit("re", m, start, line); i += m.length; }
    else {
      m = at(PUNCT) || c;
      if (m === "{") braces.push(false); else if (m === "}") braces.pop();
      emit("p", m, start, line); i += m.length;
    }
  }
  return out;
}

// Functions, and whether each token runs while the file evaluates.
const BLOCK_HEAD = new Set(["if", "for", "while", "switch", "catch", "with", "await"]);
// Array methods that call their callback before they return.
const SYNC_CALLBACK = new Set(["forEach", "map", "flatMap", "filter", "some", "every", "find", "findIndex", "reduce"]);
function structure(tok) {
  const n = tok.length, P = (k, v) => tok[k]?.t === "p" && tok[k].v === v, I = (k, v) => tok[k]?.t === "id" && (v == null || tok[k].v === v);
  const match = new Int32Array(n).fill(-1), open = [];
  for (let k = 0; k < n; k++) {
    if (tok[k].t !== "p") continue;
    const v = tok[k].v;
    if (v === "(" || v === "[" || v === "{") open.push(k);
    else if (v === ")" || v === "]" || v === "}") { const o = open.pop(); if (o != null) { match[o] = k; match[k] = o; } }
  }
  const ends = t => t.t === "str" || t.t === "num" || t.t === "re" || t.t === "tmpl" || t.t === "id" && !BEFORE_EXPRESSION.has(t.v) || t.t === "p" && (t.v === ")" || t.v === "]" || t.v === "}");
  const continues = t => t.t === "tmpl" || t.t === "id" && (t.v === "in" || t.v === "instanceof") || t.t === "p" && !["{", "!", "~", "++", "--", "@", "#"].includes(t.v);
  function conciseEnd(j0) { // an arrow's expression body: to the , ; or closing bracket around it
    for (let j = j0; j < n; j++) {
      const t = tok[j];
      if (j > j0 && t.line > tok[j - 1].line && ends(tok[j - 1]) && !continues(t)) return j - 1;
      if (t.t !== "p") continue;
      if (t.v === "(" || t.v === "[" || t.v === "{") { if (match[j] < 0) return n - 1; j = match[j]; }
      else if (t.v === ")" || t.v === "]" || t.v === "}" || t.v === "," || t.v === ";") return j - 1;
    }
    return n - 1;
  }
  const fns = [];
  for (let k = 0; k < n; k++) {
    if (P(k, "=>")) {
      const s = P(k - 1, ")") && match[k - 1] >= 0 ? match[k - 1] : k - 1, async = I(s - 1, "async");
      fns.push({s: async ? s - 1 : s, e: P(k + 1, "{") && match[k + 1] > 0 ? match[k + 1] : conciseEnd(k + 1), async});
    } else if (P(k, "{") && match[k] > 0) {
      if (P(k - 1, ")") && match[k - 1] >= 0) {
        let h = match[k - 1] - 1, async = false;
        if (!I(h) || BLOCK_HEAD.has(tok[h].v)) continue;
        // function name(, function* name(, async function (, and methods: async *name(, get name(
        while (I(h - 1) && ["function", "async", "get", "set", "static"].includes(tok[h - 1].v) || P(h - 1, "*")) { h--; async ||= I(h, "async"); }
        fns.push({s: h, e: match[k], async});
      } else {
        // A class body: its methods and field initializers run later.
        for (let h = k - 1; h >= 0 && h > k - 8 && (I(h) || P(h, ".")); h--) if (I(h, "class")) { fns.push({s: h, e: match[k], cls: true}); break; }
      }
    }
  }
  for (const f of fns) {
    const a = f.e + 1, call = j => P(j, "(") || P(j, ".") && (I(j + 1, "call") || I(j + 1, "apply")) && P(j + 2, "(");
    const expression = f.s > 0 && !P(f.s - 1, ";") && !P(f.s - 1, "{") && !P(f.s - 1, "}");
    f.transparent = !f.cls && (expression && call(a) || P(a, ")") && match[a] === f.s - 1 && call(a + 1) ||
      P(f.s - 1, "(") && I(f.s - 2) && SYNC_CALLBACK.has(tok[f.s - 2].v) && (P(f.s - 3, ".") || P(f.s - 3, "?.")));
  }
  // The innermost function of every token; an inner function starts later or ends sooner.
  fns.sort((a, b) => a.s - b.s || b.e - a.e);
  const owner = new Int32Array(n).fill(-1);
  fns.forEach((f, x) => { f.parent = owner[f.s]; f.firstAwait = Infinity; for (let k = f.s; k <= f.e; k++) owner[k] = x; });
  for (let k = 0; k < n; k++) if (I(k, "await") && owner[k] >= 0) fns[owner[k]].firstAwait = Math.min(fns[owner[k]].firstAwait, k);
  // Runs while the file evaluates: every enclosing function is invoked at once, and an async
  // one has not reached its first await.
  const evaluating = (k, x = owner[k]) => { for (; x >= 0; x = fns[x].parent) if (!fns[x].transparent || fns[x].async && fns[x].firstAwait < k) return false; return true; };
  // A named function is invoked at once too when a call by its name runs while the file
  // evaluates: function install() {…} install(); or const init = () => {…}; init();
  const named = new Map();
  for (const f of fns) {
    const j = I(f.s, "async") ? f.s + 1 : f.s;
    const name =I(j, "function") ? (P(j + 1, "*") ? tok[j + 2] : tok[j + 1]) : P(f.s - 1, "=") && I(f.s - 2) && (I(f.s - 3, "const") || I(f.s - 3, "let") || I(f.s - 3, "var") || P(f.s - 3, ",")) ? tok[f.s - 2] : null;
    if (!f.cls && name?.t === "id" && name.v !== "function") named.set(name.v, [...named.get(name.v) || [], f]);
  }
  for (let changed = named.size > 0; changed;) {
    changed = false;
    for (let k = 0; k < n; k++) {
      if (!I(k) || !named.has(tok[k].v) || !P(k + 1, "(") || P(k - 1, ".") || P(k - 1, "?.") || I(k - 1, "function") || !evaluating(k)) continue;
      for (const f of named.get(tok[k].v)) if (!f.transparent && evaluating(f.s, f.parent)) { f.transparent = changed = true; }
    }
  }
  return {match, fns, owner, evaluating, P, I};
}

// ---- The calls -------------------------------------------------------------------------------
const METHODS = new Set(["need", "appendOnLoad", "prefetch"]);
// Local names bound to the loader's methods: lazy.js's own functions, destructured or copied
// methods, and wrappers (a function whose first parameter reaches the loader's need()). Name -> method.
function loaderBindings(tok, S, file) {
  const {match, fns, P, I} = S, out = new Map(file === LOADER ? [...METHODS].map(m => [m, m]) : []);
  const lazy = new Set(["AtriumLazy"]);
  // The start of a receiver chain such as G.AtriumLazy or globalThis?.AtriumLazy that ends at k.
  const chainStart = k => { while ((P(k - 1, ".") || P(k - 1, "?.")) && I(k - 2)) k -= 2; return k; };
  const free = k => !P(k, ".") && !P(k, "?.") && !P(k, "(") && !P(k, "[");
  for (let k = 0; k < tok.length; k++) if (I(k, "AtriumLazy") && free(k + 1)) { const s = chainStart(k); if (P(s - 1, "=") && I(s - 2)) lazy.add(tok[s - 2].v); }
  // The argument range [from, to) of a call to the loader's need() at k, or null.
  const needArgs = k => {
    if (!I(k, "need") || !(P(k - 1, ".") || P(k - 1, "?.")) || !I(k - 2) || !lazy.has(tok[k - 2].v)) return null;
    const o = P(k + 1, "?.") ? k + 2 : k + 1;
    return P(o, "(") && match[o] > o ? [o + 1, match[o]] : null;
  };
  // A wrapper passes its first parameter, or a local set from it, to the loader's need(). A key
  // into a table (FEATURES[feature]) is not a module name, so computed member accesses do not count.
  const wrapper = f => {
    let j = f.s;
    while (I(j) && ["function", "async", "get", "set", "static"].includes(tok[j].v) || P(j, "*")) j++;
    if (I(j) && !P(j + 1, "=>")) j++; // the function's name
    if (P(j, "(")) j++;
    if (!I(j)) return false;
    const tainted = new Set([tok[j].v]);
    const reads = (from, to) => {
      for (let x = from; x < to; x++) {
        if (P(x, "[") && match[x] > x && (I(x - 1) && !BEFORE_EXPRESSION.has(tok[x - 1].v) || P(x - 1, ")") || P(x - 1, "]") || P(x - 1, "?."))) x = match[x];
        else if (I(x) && tainted.has(tok[x].v)) return true;
      }
      return false;
    };
    for (let k = j + 1; k <= f.e; k++) {
      const args = needArgs(k);
      if (args && reads(...args)) return true;
      if (I(k) && P(k + 1, "=")) { // const miss = [].concat(names).filter(…)
        let e = k + 2;
        while (e <= f.e && !P(e, ";") && !P(e, ",") && !P(e, ")") && !P(e, "]") && !P(e, "}")) e = match[e] > e ? match[e] + 1 : e + 1;
        if (reads(k + 2, e)) tainted.add(tok[k].v);
      }
    }
    return false;
  };
  const fnAt = new Map(fns.map(f => [f.s, f]));
  for (let k = 0; k < tok.length; k++) {
    // const need = <wrapper>, or function need(…) {<wrapper body>}
    let f = null;
    if (I(k) && P(k + 1, "=") && (I(k - 1, "const") || I(k - 1, "let") || I(k - 1, "var") || P(k - 1, ","))) f = fnAt.get(k + 2);
    else if (I(k - 1, "function") && I(k)) f = fnAt.get(k - 1) || fnAt.get(k - 2);
    if (f && !f.cls) { if (wrapper(f)) out.set(tok[k].v, "need"); continue; }
    // const load = L.need (or L.need.bind(L))
    if (I(k) && P(k + 1, "=") && I(k + 2) && lazy.has(tok[k + 2].v) && (P(k + 3, ".") || P(k + 3, "?.")) && I(k + 4) && METHODS.has(tok[k + 4].v) && !P(k + 5, "(")) out.set(tok[k].v, tok[k + 4].v);
    // const {need, prefetch: warm} = G.AtriumLazy
    if (P(k, "{") && match[k] > k && P(match[k] + 1, "=")) {
      let e = match[k] + 2; while ((P(e + 1, ".") || P(e + 1, "?.")) && I(e + 2)) e += 2;
      if (!I(e) || !lazy.has(tok[e].v) || !free(e + 1)) continue;
      for (let j = k + 1; j < match[k]; j++) if (I(j) && METHODS.has(tok[j].v) && (P(j - 1, "{") || P(j - 1, ","))) out.set(P(j + 1, ":") && I(j + 2) ? tok[j + 2].v : tok[j].v, tok[j].v);
    }
  }
  return out;
}
// The literal names the first argument of the call whose "(" is at token o can pass: strings that
// are the argument or an array element, or a branch of ?:, || or ?? there, with arrays and
// parentheses nested in it: "A", ["A", c ? 'B' : `C`, ...(d ? ["D"] : [])]. Strings passed to
// another call, used as an object key or combined into a longer string do not count.
const NAME_BEFORE = new Set(["(", "[", ",", "?", ":", "...", "||", "??", "&&"]), NAME_AFTER = new Set([")", "]", ",", ":", "||", "??"]);
function literalNames(tok, S, o) {
  const {match, P, I} = S, out = [];
  for (let j = o + 1, depth = 0; j < match[o]; j++) {
    const t = tok[j];
    if (t.t === "p" && (t.v === "(" || t.v === "[" || t.v === "{") && match[j] > j) {
      // Skip calls, member accesses and object literals; look inside groups and arrays.
      if (t.v === "{" || I(j - 1) && !BEFORE_EXPRESSION.has(tok[j - 1].v) || P(j - 1, ")") || P(j - 1, "]") || P(j - 1, "?.")) j = match[j];
      else depth++;
      continue;
    }
    if (P(j, ")") || P(j, "]")) depth--;
    else if (P(j, ",") && !depth) break; // the end of the first argument
    else if (t.t === "str" && tok[j - 1].t === "p" && NAME_BEFORE.has(tok[j - 1].v) && tok[j + 1]?.t === "p" && NAME_AFTER.has(tok[j + 1].v)) out.push(t.v);
  }
  return out;
}
// [{name, line, pos, evaluating}] for one script. line0 places an inline script in its page.
function calls(source, file, line0 = 0) {
  const tok = scan(source), S = structure(tok), {P, I} = S, bound = loaderBindings(tok, S, file), found = [];
  for (let k = 0; k < tok.length; k++) {
    if (!I(k)) continue;
    const dotted = P(k - 1, ".") || P(k - 1, "?.");
    const method = dotted ? METHODS.has(tok[k].v) && tok[k].v : !I(k - 1, "function") && bound.get(tok[k].v);
    if (!method) continue;
    const p = P(k + 1, "?.") ? k + 2 : k + 1;
    if (!P(p, "(")) continue;
    // prefetch() starts loading only when the page is idle.
    const evaluating = method !== "prefetch" && S.evaluating(k);
    for (const name of literalNames(tok, S, p)) found.push({name, line: line0 + tok[k].line, pos: tok[k].i, evaluating});
  }
  return found;
}

// ---- The providers ---------------------------------------------------------------------------
const REGISTERS = /\bregister\??\.?\(\s*["'`]([A-Za-z_$][\w$]*)["'`]\s*,\s*\{\s*scripts\s*:/g;
const defineRe = source => {
  // globalThis.X = …, or the same through a local alias (const G = globalThis).
  const aliases = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*globalThis\s*[,;]/g)].map(m => m[1].replace(/[$]/g, "\\$&"));
  const receiver = ["globalThis", "window", "self", ...aliases].join("|");
  return new RegExp("\\b(?:" + receiver + ")\\.([A-Za-z_$][\\w$]*)\\s*(?:=(?!=)|\\?\\?=|\\|\\|=)", "g");
};
// name -> the earliest offset in source where it is registered or defined.
function provided(source) {
  const out = new Map();
  for (const re of [REGISTERS, defineRe(source)]) for (const m of source.matchAll(re)) if (!out.has(m[1]) || out.get(m[1]) > m.index) out.set(m[1], m.index);
  return out;
}
// Whether a file before `file` provides name in every load order that contains `file`. Without
// `strict` a file anywhere in the shared part of those orders will do: a call made later finds
// every file of the module loaded.
function inOrders(orders, file, name, provides, strict) {
  const mine = orders.filter(o => o.includes(file));
  if (!mine.length) return false;
  if (strict) return mine.every(o => o.slice(0, o.indexOf(file)).some(f => provides(f, name)));
  return mine.reduce((a, b) => a.filter(f => b.includes(f))).some(f => f !== file && provides(f, name));
}

// ---- Self-test -------------------------------------------------------------------------------
{
  const got = (src, file = "x.js") => calls(src, file).map(c => c.name + (c.evaluating ? "!" : ""));
  const cases = [
    ['AtriumLazy.need("A"); G.AtriumLazy?.need?.([\'B\', `C`, c ? "D" : "E"])', ["A!", "B!", "C!", "D!", "E!"]],
    ['need("A"); prefetch(["B"]); x.appendOnLoad("C", p, b)', ["C!"]],
    ['AtriumLazy.need("A" + x); AtriumLazy.need(`A${x}`); AtriumLazy.need([f("A"), m["A"]]); AtriumLazy.need({a: "A"}); AtriumLazy.need(x, "A"); AtriumLazy.need(c === "A")', []],
    ['AtriumLazy.need(n || "A"); AtriumLazy.need(c ? \'B\' : `C`); AtriumLazy.need(["D", ...(c ? ["E"] : []), (c ? "F" : "G")], {measure: false})', ["A!", "B!", "C!", "D!", "E!", "F!", "G!"]],
    ['// AtriumLazy.need("A")\n/* need("B") */ const s = "AtriumLazy.need(\'C\')", r = /need\\("D"\\)/; AtriumLazy.need("E")', ["E!"]],
    ['(function () { AtriumLazy.need("A"); })(); (() => AtriumLazy.need("B"))(); !function () { AtriumLazy.need("C"); }(); (function () { AtriumLazy.need("D"); }).call(this)', ["A!", "B!", "C!", "D!"]],
    ['function f() { AtriumLazy.need("A"); }\n(function () {})(); const g = () => AtriumLazy.need("B"); x.on(() => { AtriumLazy.need("C"); })', ["A", "B", "C"]],
    ['["x"].forEach(n => AtriumLazy.need("A")); setTimeout(() => AtriumLazy.need("B")); class C { m() { AtriumLazy.need("D"); } f = AtriumLazy.need("E") }', ["A!", "B", "D", "E"]],
    ['(async () => { AtriumLazy.need("A"); await 0; AtriumLazy.need("B"); })()', ["A!", "B"]],
    ['init(); function init() { AtriumLazy.need("A"); boot(); } const boot = () => AtriumLazy.need("B"), later = () => AtriumLazy.need("C"); x.on(later)', ["A!", "B!", "C"]],
    ['if (x) { AtriumLazy.need("A"); } else AtriumLazy.need("B")\nconst h = x => x\nAtriumLazy.need("C")', ["A!", "B!", "C!"]],
    ['const need = names => { const L = G.AtriumLazy, miss = [].concat(names).filter(n => !G[n]); return L.need(miss); }; need(["A"]); function f() { need(\'B\'); }', ["A!", "B"]],
    ['const {need: load, prefetch} = globalThis.AtriumLazy; load("A"); prefetch(["B"]); const L = AtriumLazy, warm = L.prefetch; warm(["C"])', ["A!", "B", "C"]],
    ['async function need(n) { return AtriumLazy.need(n); }\nneed("A"); const tell = (el, t) => AtriumLazy.need("T").then(x => x.show(el, t)); tell("Hi", 1)', ["A!", "T!"]],
    ['const need = (n, what) => globalThis[n] || fail(what); need("A", "a")', []],
    ['const L = G.AtriumLazy, view = f => L.need(FEATURES[f]), load = n => L.need(n ? [n] : []); view("links"); load("A")', ["A!"]],
  ];
  for (const [src, want] of cases) assert.deepEqual(got(src), want, src);
  assert.deepEqual(got('need("A"); prefetch(["B"]); appendOnLoad("C", p, b)', LOADER), ["A!", "B", "C!"]);
  assert.deepEqual(calls('x\n\nAtriumLazy.need("A")', "x.js", 10).map(c => c.line), [13]);
  // Load order: b.js provides X after a.js in module M; c.js precedes a.js in M but not in N.
  const orders = [["c.js", "a.js", "b.js"], ["a.js", "c.js"]], X = (f, n) => n === "X" && f !== "a.js";
  assert.equal(inOrders(orders, "a.js", "X", X, false), true, "a later call finds the module's later files");
  assert.equal(inOrders(orders, "a.js", "X", X, true), false, "a call at evaluation needs an earlier file in every order");
  assert.equal(inOrders([["c.js", "a.js", "b.js"]], "a.js", "X", X, true), true);
  assert.equal(inOrders(orders, "z.js", "X", X, false), false);
}

// ---- The app ---------------------------------------------------------------------------------
require("../../app/lazy.js");
const L = globalThis.AtriumLazy;
const BUILT_IN = new Set(L.modules());
// The page's scripts in order; comments become blank lines so line numbers hold.
const html = read("index.html").replace(/<!--[\s\S]*?-->/g, c => c.replace(/[^\n]/g, " "));
const page = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => {
  const src = /\bsrc="([^"]+)"/.exec(m[1]);
  return src ? {file: src[1]} : {file: "index.html", body: m[2], line0: html.slice(0, m.index + m[0].indexOf(">") + 1).split("\n").length - 1};
});
const pageIndex = new Map(page.map((e, x) => [e.file, x]).filter(([f]) => f !== "index.html"));
// Run the inline scripts against an inert document so their registrations are real, noting
// where on the page each module is registered.
const inert = new Proxy(function () {}, {get: () => inert, apply: () => undefined});
const pageRegistered = new Map([...BUILT_IN].map(n => [n, pageIndex.get(LOADER)]));
page.forEach((e, x) => {
  if (e.body == null) return;
  Function("document", "localStorage", "setTimeout", e.body)(inert, inert, () => 0);
  for (const n of L.modules()) if (!pageRegistered.has(n)) pageRegistered.set(n, x);
});
const registered = name => { try { L.files([name]); return true; } catch { return false; } };

const files = [...inventoryFrom().values()].filter(f => /\.js$/.test(f) && !f.startsWith("vendor/")).sort();
const cache = new Map(), source = f => { if (!cache.has(f)) cache.set(f, read(f)); return cache.get(f); };
const providers = new Map(), providedBy = f => { if (!providers.has(f)) providers.set(f, provided(source(f))); return providers.get(f); };
const provides = (f, name) => providedBy(f).has(name);
// name -> the first eager page script that registers or defines it.
const pageProvided = new Map();
page.forEach((e, x) => { if (e.body == null) for (const n of providedBy(e.file).keys()) if (!pageProvided.has(n)) pageProvided.set(n, x); });
// A lazy file runs only as part of a module, after the files before it in that module's order.
const orders = L.modules().map(n => L.files([n]));

// Names that resolve for a reason this check cannot see. Key: "caller file|name".
const SAFE = {
  // collab-presence.js registers the pairing engine itself, in a loop at load.
  "project/collab-presence.js|AtriumCollabPair": "registered by this file at load",
  // modules() first awaits AtriumOutputJobs, whose output-jobs.js registers AtriumReleaseUI.
  "project/revisions-ui.js|AtriumReleaseUI": "registered by output-jobs.js, awaited first",
  // The palette's Library tab action first awaits AtriumLibrary, whose library-panel.js registers AtriumLibraryView.
  "editor/palette.js|AtriumLibraryView": "registered by library-panel.js, awaited first",
  // "Move to New Window" is listed only once AtriumProjectWindowClient exists, and its file registers AtriumWindowsUI.
  "editor/context-menu.js|AtriumWindowsUI": "registered by project-window-client.js, which the menu requires",
  // prefs.js registers AtriumVSCode; index.html requests AtriumPrefs at DOMContentLoaded, before the
  // theme picker or the extension manager (both opened by the user) can run.
  "editor/theme-library.js|AtriumVSCode": "registered by prefs.js, loaded at startup",
  "extension-host/extensions.js|AtriumVSCode": "registered by prefs.js, loaded at startup",
};

// Whether a call's name loads. x is the caller's place on the page, for a page script. A page
// script before lazy.js finds no loader while it evaluates (theme.js checks for it), so its calls
// run later.
function resolves({file, x}, mine, {name, pos, evaluating}) {
  if (!evaluating || x < pageIndex.get(LOADER)) {
    if (registered(name) || pageProvided.has(name) || mine.has(name)) return true;
    return x === undefined && inOrders(orders, file, name, provides, false);
  }
  if (mine.get(name) < pos) return true;
  // A lazy file runs once the page has.
  if (x === undefined) return registered(name) || pageProvided.has(name) || inOrders(orders, file, name, provides, true);
  // A page script runs after the page scripts before it. lazy.js declares its own modules first.
  return pageRegistered.get(name) < x || pageProvided.get(name) < x || file === LOADER && BUILT_IN.has(name);
}

const problems = [], used = new Set();
const scripts = [...page.flatMap((e, x) => e.body == null ? [] : [{file: e.file, body: e.body, line0: e.line0, x}]),
  ...files.map(f => ({file: f, x: pageIndex.get(f)}))];
for (const script of scripts) {
  const {file, body, line0} = script, text = body ?? source(file);
  if (!/\b(?:need|appendOnLoad|prefetch|AtriumLazy)\b/.test(text)) continue;
  const mine = body == null ? providedBy(file) : provided(body);
  for (const call of calls(text, file, line0)) {
    if (resolves(script, mine, call)) continue;
    if (SAFE[file + "|" + call.name]) { used.add(file + "|" + call.name); continue; }
    problems.push(file + ":" + call.line + " needs " + call.name + (call.evaluating
      ? " while the file evaluates, before any file that provides it has run"
      : ", which is neither a registered module nor a global defined before that call"));
  }
}
assert.deepEqual(problems, [], "\n" + problems.join("\n") + "\nAsk for the registered module whose files define the global, or register it.");
assert.deepEqual(Object.keys(SAFE).filter(k => !used.has(k)), [], "stale SAFE entries");
console.log("lazy need() names: every literal module name resolves OK");
