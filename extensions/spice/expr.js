"use strict";
// Safe expressions for behavioural (B) sources: a hand-written parser and an evaluator with
// forward-mode automatic derivatives. Never eval or new Function, even though the extension
// sandbox's CSP would allow it (docs/design/spice-models.md §8, §10).
//
//   parse(text)        -> {ast, vars: [{t: "v", node} | {t: "i", name}]}   (throws on bad input)
//   compile(parsed, P) -> f(x: number[], env: {time, temp}) -> {v, d: Float64Array}
//                         x holds the values of parsed.vars in order; d[k] = ∂v/∂x[k].
//                         P maps lower-case parameter names to numbers (.param).
// Grammar: + - * / ^ (or **), unary - + !, < > <= >= == !=, && ||, c ? a : b, ( ), numbers with
// SPICE scale suffixes (1k, 10meg, 2.2u), V(node), V(a,b), I(source), time, temp, pi, and
//   abs sqrt exp ln log log10 sin cos tan atan tanh sinh cosh sgn sign u uramp floor ceil
//   min max pow pwr limit(x, lo, hi) if(c, a, b) table(x, x1, y1, x2, y2, ...)
// exp() is linearised above 80 (as the junction models are), ln/sqrt are guarded at 0.
// Budgets: 20 000 characters, 4000 nodes and 64 levels of nesting per expression.
(function () {
  const LIMITS = {chars: 20000, nodes: 4000, depth: 64};
  const SCALE = {t: 1e12, g: 1e9, meg: 1e6, k: 1e3, mil: 25.4e-6, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15};
  const FN1 = new Set(["abs", "sqrt", "exp", "ln", "log", "log10", "sin", "cos", "tan", "atan", "tanh", "sinh", "cosh", "sgn", "sign", "u", "uramp", "floor", "ceil"]);
  const FN2 = new Set(["min", "max", "pow", "pwr"]);
  const fail = m => { throw Error(m); };

  function lex(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      let m;
      if ((m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(meg|mil|[tgkmunpf])?[a-z]*/i.exec(src.slice(i)))) {
        const base = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(m[0])[0];
        out.push({k: "num", v: Number(base) * (m[1] ? SCALE[m[1].toLowerCase()] : 1)}); i += m[0].length; continue;
      }
      if ((m = /^[A-Za-z_][\w.$#]*/.exec(src.slice(i)))) { out.push({k: "id", v: m[0]}); i += m[0].length; continue; }
      if ((m = /^(\*\*|<=|>=|==|!=|&&|\|\||[-+*/^()<>,?:!{}])/.exec(src.slice(i)))) { out.push({k: "op", v: m[0] === "{" ? "(" : m[0] === "}" ? ")" : m[0]}); i += m[0].length; continue; }
      fail("Cannot read the expression at \"" + src.slice(i, i + 12) + "\".");
    }
    return out;
  }

  function parse(text) {
    const src = String(text ?? "");
    if (src.length > LIMITS.chars) fail("The expression is longer than " + LIMITS.chars + " characters.");
    if (!src.trim()) fail("The expression is empty.");
    const tk = lex(src), vars = [], varKey = new Map();
    let pos = 0, count = 0, depth = 0;
    const peek = v => tk[pos] && tk[pos].k === "op" && tk[pos].v === v;
    const take = v => { if (peek(v)) { pos++; return true; } return false; };
    const need = v => { if (!take(v)) fail("Expected \"" + v + "\" in the expression" + (tk[pos] ? " before \"" + tk[pos].v + "\"" : " at its end") + "."); };
    const node = n => { if (++count > LIMITS.nodes) fail("The expression has more than " + LIMITS.nodes + " terms."); return n; };
    const variable = (t, name) => {
      const key = t + ":" + name.toLowerCase();
      if (!varKey.has(key)) { varKey.set(key, vars.length); vars.push(t === "v" ? {t, node: name} : {t, name}); }
      return varKey.get(key);
    };
    const nest = f => { if (++depth > LIMITS.depth) fail("The expression nests more than " + LIMITS.depth + " levels deep."); try { return f(); } finally { depth--; } };
    function expr() { return nest(ternary); }
    function ternary() {
      const c = or();
      if (take("?")) { const a = expr(); need(":"); const b = expr(); return node({k: "if", c, a, b}); }
      return c;
    }
    function bin(next, ops) { return () => { let l = next(); for (;;) { const t = tk[pos]; if (t && t.k === "op" && ops.includes(t.v)) { pos++; l = node({k: "bin", op: t.v, l, r: next()}); } else return l; } }; }
    const or = bin(() => and(), ["||"]);
    const and = bin(() => cmp(), ["&&"]);
    const cmp = bin(() => addsub(), ["<", ">", "<=", ">=", "==", "!="]);
    const addsub = bin(() => muldiv(), ["+", "-"]);
    const muldiv = bin(() => unary(), ["*", "/"]);
    function unary() {
      if (take("-")) return node({k: "neg", a: nest(unary)});
      if (take("+")) return nest(unary);
      if (take("!")) return node({k: "not", a: nest(unary)});
      return power();
    }
    function power() {
      const b = primary();
      if (take("^") || take("**")) return node({k: "bin", op: "^", l: b, r: nest(unary)});
      return b;
    }
    // V(a) V(a,b) I(name): node and source names are read raw, up to "," or ")".
    function probe(kind) {
      need("(");
      const names = [];
      for (;;) {
        const t = tk[pos++];
        if (!t || t.k === "op") fail(kind.toUpperCase() + "() needs a " + (kind === "v" ? "node" : "source") + " name.");
        names.push(t.k === "num" ? String(t.v) : t.v);
        if (take(")")) break;
        need(",");
      }
      if (kind === "i" && names.length !== 1) fail("I() takes one source name.");
      if (names.length > 2) fail("V() takes one or two node names.");
      const ground = n => /^(0|gnd)$/i.test(n);
      const ref = n => (ground(n) ? {k: "num", v: 0} : {k: "var", i: variable(kind, n)});
      if (names.length === 1) return node(ref(names[0]));
      return node({k: "bin", op: "-", l: ref(names[0]), r: ref(names[1])});
    }
    function primary() {
      const t = tk[pos];
      if (!t) fail("The expression ends too early.");
      if (t.k === "num") { pos++; return node({k: "num", v: t.v}); }
      if (t.k === "op" && t.v === "(") { pos++; const e = expr(); need(")"); return e; }
      if (t.k !== "id") fail("Unexpected \"" + t.v + "\" in the expression.");
      pos++;
      const name = t.v.toLowerCase();
      if ((name === "v" || name === "i") && peek("(")) return probe(name);
      if (peek("(")) {
        pos++;
        const args = [];
        if (!take(")")) { for (;;) { args.push(expr()); if (take(")")) break; need(","); } }
        const n = args.length;
        if (FN1.has(name) && n !== 1) fail(name + "() takes one argument.");
        if (FN2.has(name) && n !== 2) fail(name + "() takes two arguments.");
        if ((name === "limit" || name === "if") && n !== 3) fail(name + "() takes three arguments.");
        if (name === "table" && (n < 3 || n % 2 === 0)) fail("table() takes x and then x, y pairs.");
        if (!FN1.has(name) && !FN2.has(name) && !["limit", "if", "table"].includes(name)) fail("Unknown function " + t.v + "().");
        return node({k: "fn", name, args});
      }
      if (name === "time" || name === "temp") return node({k: "env", name});
      if (name === "pi") return node({k: "num", v: Math.PI});
      return node({k: "par", name});
    }
    const ast = expr();
    if (pos < tk.length) fail("Unexpected \"" + tk[pos].v + "\" in the expression.");
    return {ast, vars, text: src};
  }

  // ------------------------------------------------------------------ evaluation with derivatives
  const E80 = Math.exp(80);
  function compile(parsed, params = {}) {
    const n = parsed.vars.length, zero = new Float64Array(n);
    const C = v => ({v, d: zero});
    const scale = (a, s) => { if (a.d === zero || s === 0) return zero; const d = new Float64Array(n); for (let k = 0; k < n; k++) d[k] = a.d[k] * s; return d; };
    const comb = (a, sa, b, sb) => { // sa·a.d + sb·b.d
      if (a.d === zero) return scale(b, sb);
      if (b.d === zero) return scale(a, sa);
      const d = new Float64Array(n); for (let k = 0; k < n; k++) d[k] = a.d[k] * sa + b.d[k] * sb; return d;
    };
    const chain = (a, v, dv) => ({v, d: scale(a, dv)});
    function build(e) {
      switch (e.k) {
        case "num": { const r = C(e.v); return () => r; }
        case "var": { const i = e.i; return x => { const d = new Float64Array(n); d[i] = 1; return {v: x[i], d}; }; }
        case "env": { const name = e.name; return (x, env) => C(name === "time" ? env.time || 0 : env.temp ?? 27); }
        case "par": {
          const v = params[e.name];
          if (v == null || !Number.isFinite(Number(v))) fail("Unknown name " + e.name + " in the expression.");
          const r = C(Number(v)); return () => r;
        }
        case "neg": { const a = build(e.a); return (x, env) => { const r = a(x, env); return {v: -r.v, d: scale(r, -1)}; }; }
        case "not": { const a = build(e.a); return (x, env) => C(a(x, env).v ? 0 : 1); }
        case "if": { const c = build(e.c), a = build(e.a), b = build(e.b); return (x, env) => (c(x, env).v ? a(x, env) : b(x, env)); }
        case "bin": {
          const l = build(e.l), r = build(e.r), op = e.op;
          return (x, env) => {
            const a = l(x, env), b = r(x, env);
            switch (op) {
              case "+": return {v: a.v + b.v, d: comb(a, 1, b, 1)};
              case "-": return {v: a.v - b.v, d: comb(a, 1, b, -1)};
              case "*": return {v: a.v * b.v, d: comb(a, b.v, b, a.v)};
              case "/": return {v: a.v / b.v, d: comb(a, 1 / b.v, b, -a.v / (b.v * b.v))};
              case "^": return powD(a, b);
              case "<": return C(a.v < b.v ? 1 : 0); case ">": return C(a.v > b.v ? 1 : 0);
              case "<=": return C(a.v <= b.v ? 1 : 0); case ">=": return C(a.v >= b.v ? 1 : 0);
              case "==": return C(a.v === b.v ? 1 : 0); case "!=": return C(a.v !== b.v ? 1 : 0);
              case "&&": return C(a.v && b.v ? 1 : 0); case "||": return C(a.v || b.v ? 1 : 0);
            }
            return fail("Unknown operator " + op + ".");
          };
        }
        case "fn": return fn(e.name, e.args.map(build));
      }
      return fail("Bad expression node.");
    }
    function powD(a, b) {
      const v = Math.pow(a.v, b.v);
      if (b.d === zero) return {v, d: scale(a, b.v === 0 ? 0 : b.v * Math.pow(a.v, b.v - 1))};
      const la = a.v > 0 ? Math.log(a.v) : 0;
      return {v, d: comb(a, a.v !== 0 ? b.v * Math.pow(a.v, b.v - 1) : 0, b, v * la)};
    }
    function fn(name, args) {
      const [f0, f1, f2] = args;
      const one = g => (x, env) => g(f0(x, env));
      switch (name) {
        case "abs": return one(a => chain(a, Math.abs(a.v), a.v > 0 ? 1 : a.v < 0 ? -1 : 0));
        case "sqrt": return one(a => { const s = Math.sqrt(Math.max(a.v, 0)); return chain(a, s, 0.5 / Math.max(s, 1e-150)); });
        case "exp": return one(a => (a.v > 80 ? chain(a, E80 * (1 + a.v - 80), E80) : (s => chain(a, s, s))(Math.exp(a.v))));
        case "ln": case "log": return one(a => { const t = Math.max(a.v, 1e-300); return chain(a, Math.log(t), 1 / t); });
        case "log10": return one(a => { const t = Math.max(a.v, 1e-300); return chain(a, Math.log10(t), 1 / (t * Math.LN10)); });
        case "sin": return one(a => chain(a, Math.sin(a.v), Math.cos(a.v)));
        case "cos": return one(a => chain(a, Math.cos(a.v), -Math.sin(a.v)));
        case "tan": return one(a => { const c = Math.cos(a.v); return chain(a, Math.tan(a.v), 1 / (c * c)); });
        case "atan": return one(a => chain(a, Math.atan(a.v), 1 / (1 + a.v * a.v)));
        case "tanh": return one(a => { const t = Math.tanh(a.v); return chain(a, t, 1 - t * t); });
        case "sinh": return one(a => chain(a, Math.sinh(a.v), Math.cosh(a.v)));
        case "cosh": return one(a => chain(a, Math.cosh(a.v), Math.sinh(a.v)));
        case "sgn": case "sign": return one(a => C(Math.sign(a.v)));
        case "u": return one(a => C(a.v > 0 ? 1 : 0));
        case "uramp": return one(a => chain(a, Math.max(a.v, 0), a.v > 0 ? 1 : 0));
        case "floor": return one(a => C(Math.floor(a.v)));
        case "ceil": return one(a => C(Math.ceil(a.v)));
        case "min": return (x, env) => { const a = f0(x, env), b = f1(x, env); return a.v <= b.v ? a : b; };
        case "max": return (x, env) => { const a = f0(x, env), b = f1(x, env); return a.v >= b.v ? a : b; };
        case "pow": return (x, env) => powD(f0(x, env), f1(x, env));
        case "pwr": return (x, env) => { // sign(a)·|a|^b
          const a = f0(x, env), b = f1(x, env), s = a.v < 0 ? -1 : 1, m = powD({v: Math.abs(a.v), d: scale(a, s)}, b);
          return {v: s * m.v, d: scale(m, s)};
        };
        case "limit": return (x, env) => { const a = f0(x, env), lo = f1(x, env), hi = f2(x, env); return a.v < lo.v ? lo : a.v > hi.v ? hi : a; };
        case "if": return (x, env) => (f0(x, env).v ? f1(x, env) : f2(x, env));
        case "table": {
          const xs = args.slice(1).filter((_, i) => i % 2 === 0), ys = args.slice(1).filter((_, i) => i % 2 === 1);
          return (x, env) => {
            const a = f0(x, env), px = xs.map(g => g(x, env).v), py = ys.map(g => g(x, env).v), m = px.length;
            if (a.v <= px[0]) return C(py[0]);
            if (a.v >= px[m - 1]) return C(py[m - 1]);
            let k = 1; while (k < m - 1 && a.v > px[k]) k++;
            const s = (py[k] - py[k - 1]) / ((px[k] - px[k - 1]) || 1);
            return chain(a, py[k - 1] + s * (a.v - px[k - 1]), s);
          };
        }
      }
      return fail("Unknown function " + name + "().");
    }
    const f = build(parsed.ast);
    return (x, env = {}) => f(x, env);
  }

  const api = {parse, compile, LIMITS};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumSpiceExpr = api;
})();
