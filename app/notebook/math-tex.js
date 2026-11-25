"use strict";

// This grammar only builds typographical atoms. It has no macro expansion, execution or I/O.
globalThis.AtriumMathTex = (() => {
  const symbols = new Map();
  function define(cls, lines) {
    for (const pair of lines.split(/\s+/)) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      symbols.set(pair.slice(0, eq), { cls, text: pair.slice(eq + 1) });
    }
  }
  define(
    "ord",
    "alpha=α beta=β gamma=γ delta=δ epsilon=ϵ varepsilon=ε zeta=ζ eta=η theta=θ vartheta=ϑ iota=ι kappa=κ varkappa=ϰ lambda=λ mu=μ nu=ν xi=ξ omicron=ο pi=π varpi=ϖ rho=ρ varrho=ϱ sigma=σ varsigma=ς tau=τ upsilon=υ phi=ϕ varphi=φ chi=χ psi=ψ omega=ω Gamma=Γ Delta=Δ Theta=Θ Lambda=Λ Xi=Ξ Pi=Π Sigma=Σ Upsilon=Υ Phi=Φ Psi=Ψ Omega=Ω"
  );
  define(
    "ord",
    "infty=∞ partial=∂ nabla=∇ ell=ℓ hbar=ℏ imath=ı jmath=ȷ Re=ℜ Im=ℑ angle=∠ measuredangle=∡ degree=° circledR=® emptyset=∅ varnothing=∅ forall=∀ exists=∃ nexists=∄ neg=¬ lnot=¬ aleph=ℵ top=⊤ bot=⊥ surd=√ prime=′ ohm=Ω micro=µ dagger=† ddagger=‡ ldots=… dots=… cdots=⋯ vdots=⋮ ddots=⋱"
  );
  define(
    "bin",
    "pm=± mp=∓ times=× div=÷ cdot=⋅ ast=∗ star=⋆ circ=∘ bullet=∙ oplus=⊕ ominus=⊖ otimes=⊗ oslash=⊘ odot=⊙ wedge=∧ land=∧ vee=∨ lor=∨ cap=∩ cup=∪ setminus=∖ bigcirc=◯ triangle=△ triangleleft=◁ triangleright=▷"
  );
  define(
    "rel",
    "le=≤ leq=≤ ge=≥ geq=≥ ne=≠ neq=≠ ll=≪ gg=≫ approx=≈ simeq=≃ sim=∼ cong=≅ equiv=≡ propto=∝ asymp=≍ in=∈ notin=∉ ni=∋ subset=⊂ supset=⊃ subseteq=⊆ supseteq=⊇ perp=⊥ parallel=∥ mid=∣ models=⊨ to=→ gets=← mapsto=↦ rightarrow=→ leftarrow=← leftrightarrow=↔ Rightarrow=⇒ Leftarrow=⇐ Leftrightarrow=⇔ longrightarrow=⟶ longleftarrow=⟵ longleftrightarrow=⟷ Longrightarrow=⟹ Longleftarrow=⟸ Longleftrightarrow=⟺ uparrow=↑ downarrow=↓ updownarrow=↕ Uparrow=⇑ Downarrow=⇓ Updownarrow=⇕ implies=⟹ iff=⟺"
  );
  const big = new Map(
    Object.entries({
      sum: "∑",
      prod: "∏",
      coprod: "∐",
      int: "∫",
      iint: "∬",
      iiint: "∭",
      oint: "∮",
      oiint: "∯",
      oiiint: "∰",
      bigcup: "⋃",
      bigcap: "⋂",
      bigvee: "⋁",
      bigwedge: "⋀",
      bigoplus: "⨁",
      bigotimes: "⨂"
    })
  );
  const functions = new Set(
    "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth log ln lg exp lim limsup liminf max min sup inf arg det gcd Pr ker dim hom".split(
      " "
    )
  );
  const accents = {
    hat: "\u0302",
    widehat: "\u0302",
    tilde: "\u0303",
    widetilde: "\u0303",
    bar: "\u0304",
    vec: "\u20d7",
    overrightarrow: "\u20d7",
    dot: "\u0307",
    ddot: "\u0308",
    dddot: "\u20db",
    breve: "\u0306",
    check: "\u030c",
    acute: "\u0301",
    grave: "\u0300",
    mathring: "\u030a",
    overbrace: "⏞",
    underbrace: "⏟"
  };
  const delimiters = {
    langle: "⟨",
    rangle: "⟩",
    lbrace: "{",
    rbrace: "}",
    lbrack: "[",
    rbrack: "]",
    lvert: "|",
    rvert: "|",
    vert: "|",
    lVert: "‖",
    rVert: "‖",
    Vert: "‖",
    "|": "‖",
    "{": "{",
    "}": "}",
    lfloor: "⌊",
    rfloor: "⌋",
    lceil: "⌈",
    rceil: "⌉",
    backslash: "\\",
    uparrow: "↑",
    downarrow: "↓",
    updownarrow: "↕",
    Uparrow: "⇑",
    Downarrow: "⇓",
    Updownarrow: "⇕"
  };
  const spaces = {
    ",": 3,
    ":": 4,
    ";": 5,
    "!": -3,
    " ": 6,
    quad: 18,
    qquad: 36,
    enspace: 9,
    thinspace: 3,
    negthinspace: -3,
    medspace: 4,
    thickspace: 5
  };
  const fonts = {
    mathrm: "roman",
    mathit: "italic",
    mathbf: "bold",
    boldsymbol: "bolditalic",
    mathsf: "sans",
    mathtt: "mono",
    mathbb: "double",
    mathcal: "script",
    mathscr: "script",
    mathfrak: "fraktur",
    mathnormal: "normal"
  };
  const styles = {
    displaystyle: "display",
    textstyle: "text",
    scriptstyle: "script",
    scriptscriptstyle: "scriptscript"
  };
  const delimitEnv = {
    matrix: ["", ""],
    smallmatrix: ["", ""],
    pmatrix: ["(", ")"],
    bmatrix: ["[", "]"],
    Bmatrix: ["{", "}"],
    vmatrix: ["|", "|"],
    Vmatrix: ["‖", "‖"],
    cases: ["{", ""],
    dcases: ["{", ""],
    aligned: ["", ""],
    alignedat: ["", ""],
    gathered: ["", ""],
    array: ["", ""]
  };
  const basicClasses = new Map();
  for (const [cls, chars] of Object.entries({
    bin: "+−±∓×÷∗⋅⊕⊗∧∨",
    rel: "=<>≤≥≠≈∼≡∝∈∥→←⇒⇔",
    open: "([{⟨⌊⌈",
    close: ")]}⟩⌋⌉",
    punct: ",;:"
  }))
    for (const c of chars) basicClasses.set(c, cls);
  const known = [
    ...new Set([
      ...symbols.keys(),
      ...big.keys(),
      ...functions,
      ...Object.keys(accents),
      ...Object.keys(delimiters),
      ...Object.keys(spaces),
      ...Object.keys(fonts),
      ...Object.keys(styles),
      "frac",
      "dfrac",
      "tfrac",
      "binom",
      "sqrt",
      "left",
      "middle",
      "right",
      "begin",
      "end",
      "text",
      "operatorname",
      "overline",
      "underline",
      "overset",
      "underset",
      "limits",
      "nolimits",
      "hspace",
      "phantom"
    ])
  ].sort();
  const MAX_LENGTH = 8192,
    MAX_DEPTH = 48,
    MAX_NODES = 3072,
    MAX_CELLS = 256;
  function tokens(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const start = i,
        cp = src.codePointAt(i),
        c = String.fromCodePoint(cp);
      i += c.length;
      if (c === "%") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "\\") {
        let end = i;
        while (end < src.length && /[A-Za-z]/.test(src[end])) end++;
        if (end === i && i < src.length) end += String.fromCodePoint(src.codePointAt(i)).length;
        const text = src.slice(i, end);
        i = end;
        out.push({ kind: "cmd", text, start, end: i });
      } else out.push({ kind: /\s/.test(c) ? "space" : "char", text: c, start, end: i });
    }
    out.push({ kind: "end", text: "", start: i, end: i });
    return out;
  }
  function parse(input) {
    const src = String(input ?? ""),
      errors = [],
      list = tokens(src.slice(0, MAX_LENGTH));
    let cursor = 0,
      depth = 0,
      nodes = 0,
      cells = 0;
    function error(t, message) {
      if (errors.length < 24) errors.push({ start: t.start, end: t.end, message });
    }
    if (src.length > MAX_LENGTH)
      error({ start: MAX_LENGTH, end: src.length }, "Formula exceeds " + MAX_LENGTH + " characters.");
    const peek = () => list[cursor],
      take = () => list[Math.min(cursor++, list.length - 1)];
    const skip = () => {
      while (peek().kind === "space") cursor++;
    };
    const at = (kind, v) => peek().kind === kind && peek().text === v;
    const cmd = v => at("cmd", v),
      char = v => at("char", v);
    function node(t, kind, extra = {}) {
      return { kind, start: t.start, end: list[Math.max(0, cursor - 1)].end, ...extra };
    }
    function fault(t, message) {
      error(t, message);
      return node(t, "glyph", { text: "□", cls: "ord", error: true });
    }
    function rawGroup(t) {
      skip();
      if (!char("{")) {
        error(peek(), "Expected a braced argument for " + t.text + ".");
        return "";
      }
      take();
      let depth = 1,
        value = "";
      while (peek().kind !== "end" && depth) {
        const q = take();
        if (q.kind === "char" && q.text === "{") {
          depth++;
          if (depth > 1) value += "{";
        } else if (q.kind === "char" && q.text === "}") {
          depth--;
          if (depth) value += "}";
        } else if (q.kind === "cmd") {
          value += q.text.length === 1 ? q.text : "\\" + q.text;
        } else value += q.text;
      }
      if (depth) error(peek(), "Missing closing brace.");
      return value;
    }
    function argument(t) {
      skip();
      if (peek().kind === "end" || char("}") || cmd("right") || cmd("end"))
        return fault(peek(), "Missing argument for " + t.text + ".");
      if (depth >= MAX_DEPTH) {
        cursor = list.length - 1;
        return fault(t, "Formula nesting exceeds " + MAX_DEPTH + " levels.");
      }
      depth++;
      const value = atom();
      depth--;
      return value;
    }
    function delim(t) {
      skip();
      if (peek().kind === "end") {
        error(t, "Missing delimiter.");
        return "";
      }
      const q = take(),
        v = q.kind === "cmd" ? delimiters[q.text] : q.text;
      if (v === "." || v === "") return "";
      if (v && "()[]{}<>|‖⟨⟩⌊⌋⌈⌉/\\↑↓↕⇑⇓⇕".includes(v)) return v === "<" ? "⟨" : v === ">" ? "⟩" : v;
      error(q, "Expected a delimiter.");
      return "";
    }
    function group(t) {
      const value = sequence(() => char("}"));
      if (char("}")) take();
      else error(peek(), "Missing closing brace.");
      return node(t, "group", { value });
    }
    function matrix(t) {
      const name = rawGroup(t);
      if (!Object.hasOwn(delimitEnv, name)) return fault(t, "Unknown environment “" + name + "”.");
      const columns =
        name === "array" ? rawGroup(t).replace(/[^lcr]/g, "") : name === "alignedat" ? (rawGroup(t), "") : "";
      const rows = [[]];
      let closed = false;
      while (peek().kind !== "end") {
        if (++cells > MAX_CELLS) {
          cursor = list.length - 1;
          error(t, "Formula exceeds " + MAX_CELLS + " matrix cells.");
          break;
        }
        rows.at(-1).push(sequence(() => char("&") || cmd("\\") || cmd("end")));
        if (char("&")) {
          take();
          continue;
        }
        if (cmd("\\")) {
          take();
          rows.push([]);
          continue;
        }
        if (cmd("end")) {
          const end = take();
          closed = true;
          if (rawGroup(end) !== name) error(end, "Environment does not match " + name + ".");
          break;
        }
        break;
      }
      if (!closed) error(peek(), "Missing \\end{" + name + "}.");
      return node(t, "matrix", { name, rows, columns, delimiters: delimitEnv[name] });
    }
    function command(t) {
      const k = t.text;
      if (symbols.has(k)) return node(t, "glyph", symbols.get(k));
      if (big.has(k)) return node(t, "operator", { text: big.get(k), integral: k.includes("int"), cls: "op" });
      if (functions.has(k))
        return node(t, "operator", {
          text: k,
          named: true,
          limits: ["lim", "limsup", "liminf", "min", "max", "inf", "sup"].includes(k),
          cls: "op"
        });
      if (Object.hasOwn(spaces, k)) return node(t, "space", { mu: spaces[k] });
      if (Object.hasOwn(fonts, k)) return node(t, "font", { font: fonts[k], value: argument(t) });
      if (Object.hasOwn(styles, k)) return node(t, "style", { style: styles[k] });
      if (Object.hasOwn(accents, k)) return node(t, "accent", { name: k, mark: accents[k], value: argument(t) });
      if (Object.hasOwn(delimiters, k)) {
        const text = delimiters[k];
        return node(t, "glyph", {
          text,
          cls: k.startsWith("l") ? "open" : k.startsWith("r") ? "close" : basicClasses.get(text) || "ord"
        });
      }
      if (["frac", "tfrac", "dfrac", "binom", "tbinom", "dbinom"].includes(k)) {
        const num = argument(t),
          den = argument(t);
        return node(t, "fraction", {
          num,
          den,
          style: k[0] === "t" ? "text" : k[0] === "d" ? "display" : null,
          binomial: k.endsWith("binom")
        });
      }
      if (k === "sqrt") {
        skip();
        let degree = null;
        if (char("[")) {
          take();
          degree = sequence(() => char("]"));
          if (char("]")) take();
          else error(peek(), "Missing ] for root degree.");
        }
        return node(t, "radical", { degree, value: argument(t) });
      }
      if (k === "left") {
        const left = delim(t),
          parts = [],
          middle = [];
        do {
          parts.push(sequence(() => cmd("middle") || cmd("right")));
          if (!cmd("middle")) break;
          middle.push(delim(take()));
        } while (peek().kind !== "end");
        let right = "";
        if (cmd("right")) right = delim(take());
        else error(peek(), "Missing \\right delimiter.");
        return node(t, "fenced", { left, right, parts, middle, cls: "inner" });
      }
      if (/^(big|Big|bigg|Bigg)[lrm]?$/.test(k)) {
        const text = delim(t),
          extent = { big: 1.2, Big: 1.8, bigg: 2.4, Bigg: 3 }[k.replace(/[lrm]$/, "")];
        return node(t, "delimiter", {
          text,
          extent,
          cls: k.endsWith("l") ? "open" : k.endsWith("r") ? "close" : k.endsWith("m") ? "rel" : "ord"
        });
      }
      if (k === "text" || k === "textrm" || k === "mbox" || k === "operatorname") {
        const text = rawGroup(t);
        return node(t, k === "operatorname" ? "operator" : "text", {
          text,
          named: k === "operatorname",
          cls: k === "operatorname" ? "op" : "ord"
        });
      }
      if (k === "begin") return matrix(t);
      if (k === "overline" || k === "underline" || k === "phantom") return node(t, k, { value: argument(t) });
      if (k === "overset" || k === "stackrel" || k === "underset") {
        const script = argument(t),
          value = argument(t);
        return node(t, "scripts", {
          value,
          sub: k === "underset" ? script : null,
          sup: k === "underset" ? null : script,
          limits: true
        });
      }
      if (k === "hspace" || k === "kern" || k === "mkern") {
        const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(em|mu|ex|pt)$/.exec(rawGroup(t));
        return match
          ? node(t, "space", {
              mu: Math.max(-180, Math.min(180, +match[1] * { em: 18, mu: 1, ex: 8, pt: 1.8 }[match[2]]))
            })
          : fault(t, "Use a spacing length in em, ex, mu or pt.");
      }
      if (["%", "$", "_", "#", "&", "\\"].includes(k)) return node(t, "glyph", { text: k, cls: "ord" });
      return fault(t, "Unknown command \\" + k + ".");
    }
    function atom() {
      const t = take();
      if (++nodes > MAX_NODES) {
        cursor = list.length - 1;
        return fault(t, "Formula exceeds " + MAX_NODES + " atoms.");
      }
      if (t.kind === "cmd") return command(t);
      if (t.text === "{") return group(t);
      if ("}_^&".includes(t.text)) return fault(t, "Unexpected “" + t.text + "”.");
      const text = t.text === "-" ? "−" : t.text === "*" ? "∗" : t.text === "~" ? " " : t.text;
      return node(t, "glyph", { text, cls: basicClasses.get(text) || "ord" });
    }
    function sequence(stop) {
      const t = peek(),
        items = [];
      if (++depth > MAX_DEPTH) {
        depth--;
        cursor = list.length - 1;
        return fault(t, "Formula nesting exceeds " + MAX_DEPTH + " levels.");
      }
      while (peek().kind !== "end") {
        skip();
        if (peek().kind === "end" || stop()) break;
        let value = atom(),
          sub = null,
          sup = null,
          limits = null;
        while (true) {
          skip();
          if (cmd("limits") || cmd("nolimits")) {
            limits = take().text === "limits";
            continue;
          }
          if (char("'") && !sup) {
            const q = take();
            let count = 1;
            while (char("'")) {
              take();
              count++;
            }
            sup = node(q, "text", { text: "′".repeat(count), primes: true });
            continue;
          }
          if (!char("^") && !char("_")) break;
          const op = take(),
            script = argument(op);
          if (op.text === "^") {
            if (sup) error(op, "Duplicate superscript.");
            else sup = script;
          } else {
            if (sub) error(op, "Duplicate subscript.");
            else sub = script;
          }
        }
        if (sub || sup)
          value = {
            kind: "scripts",
            start: value.start,
            end: list[Math.max(0, cursor - 1)].end,
            value,
            sub,
            sup,
            limits
          };
        items.push(value);
      }
      depth--;
      return { kind: "row", items, start: t.start, end: list[Math.max(0, cursor - 1)].end };
    }
    const root = sequence(() => false);
    return { root, errors };
  }
  return Object.freeze({ parse, commands: known, MAX_LENGTH });
})();
