"use strict";

// TeX atom spacing and OpenType MATH layout. All display-list positions share one baseline,
// in source ems. Cached commands carry original font GIDs and UTF-16 source ranges.
globalThis.AtriumMath = (() => {
  const F = globalThis.AtriumMathFont,
    T = globalThis.AtriumMathTex;
  const cache = new Map(),
    canvasPaths = new Map(),
    MAX_COMMANDS = 16000,
    MAX_CACHE = 256,
    MAX_CACHED_COMMANDS = 100000;
  let cachedCommands = 0;
  const newBox = (cls = "ord") => ({ advance: 0, ascent: 0, descent: 0, commands: [], plain: "", cls });
  const styleLevel = s => (s === "script" ? 1 : s === "scriptscript" ? 2 : 0);
  const smaller = s => (s === "script" || s === "scriptscript" ? "scriptscript" : "script");
  const fractionStyle = s => (s === "display" ? "text" : smaller(s));
  // LaTeX's three optical sizes for 24 pt maths are 24, 16.8 and 12 pt.
  // Respect a smaller script face requested by the font as well.
  const fontSize = s =>
    [
      1,
      Math.min(0.7, F.constants().ScriptPercentScaleDown),
      Math.min(0.5, F.constants().ScriptScriptPercentScaleDown)
    ][styleLevel(s)];
  function put(parent, child, x, y) {
    parent.ascent = Math.max(parent.ascent, child.ascent - y);
    parent.descent = Math.max(parent.descent, child.descent + y);
    if (parent.commands.length + child.commands.length > MAX_COMMANDS)
      throw new RangeError("Formula generates too many glyphs.");
    for (const c of child.commands) parent.commands.push({ ...c, x: c.x + x, y: c.y + y });
  }
  function append(parent, child) {
    put(parent, child, parent.advance, 0);
    parent.advance += child.advance;
    parent.plain += child.plain;
  }
  function rule(b, x, y, w, h) {
    b.commands.push({ kind: "rule", x, y, w, h });
    b.ascent = Math.max(b.ascent, -y);
    b.descent = Math.max(b.descent, y + h);
  }
  function glyph(gid, text, t, scale, italic = true) {
    const m = F.glyph(gid),
      b = newBox();
    b.gid = gid;
    b.scale = scale;
    b.italic = m.italic * scale;
    b.accent = m.accent * scale;
    b.advance = m.advance * scale + (italic ? b.italic : 0);
    b.ascent = m.ascent * scale;
    b.descent = m.descent * scale;
    b.plain = text;
    b.firstKern = { gid, scale };
    b.commands.push({ kind: "glyph", gid, x: 0, y: 0, scale, text, start: t.start, end: t.end });
    return b;
  }
  const latin = {
    normal: [0x1d434, 0x1d44e],
    italic: [0x1d434, 0x1d44e],
    bold: [0x1d400, 0x1d41a, 0x1d7ce],
    bolditalic: [0x1d468, 0x1d482],
    sans: [0x1d5a0, 0x1d5ba, 0x1d7e2],
    mono: [0x1d670, 0x1d68a, 0x1d7f6],
    double: [0x1d538, 0x1d552, 0x1d7d8],
    script: [0x1d49c, 0x1d4b6],
    fraktur: [0x1d504, 0x1d51e]
  };
  const exceptions = {
    normal: { h: "ℎ", ı: "𝚤", ȷ: "𝚥" },
    italic: { h: "ℎ", ı: "𝚤", ȷ: "𝚥" },
    double: { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" },
    script: { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ", e: "ℯ", g: "ℊ", o: "ℴ" },
    fraktur: { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" }
  };
  const greekUpper = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇",
    greekLower = "αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ";
  function codepoint(ch, font) {
    const cp = ch.codePointAt(0),
      range = latin[font];
    if (!range) return cp;
    const special = exceptions[font]?.[ch];
    if (special) return special.codePointAt(0);
    if (cp >= 65 && cp <= 90) return range[0] + cp - 65;
    if (cp >= 97 && cp <= 122) return range[1] + cp - 97;
    if (cp >= 48 && cp <= 57 && range[2]) return range[2] + cp - 48;
    const lower = greekLower.indexOf(ch),
      upper = greekUpper.indexOf(ch);
    if (lower >= 0 && ["normal", "italic", "bold", "bolditalic"].includes(font))
      return { normal: 0x1d6fc, italic: 0x1d6fc, bold: 0x1d6c2, bolditalic: 0x1d736 }[font] + lower;
    if (upper >= 0 && ["italic", "bold", "bolditalic"].includes(font))
      return { italic: 0x1d6e2, bold: 0x1d6a8, bolditalic: 0x1d71c }[font] + upper;
    return cp;
  }
  function character(ch, t, sz, font, correct = true) {
    const gid = F.idFor(codepoint(ch, font)) || F.idFor(ch.codePointAt(0));
    return glyph(gid, ch, t, sz, correct);
  }
  function words(t, sz, font) {
    const b = newBox(t.cls);
    for (const ch of t.text) {
      const piece = character(ch, t, sz, font, false);
      if (t.primes && !b.firstKern) b.firstKern = piece.firstKern;
      append(b, piece);
    }
    return b;
  }
  // Positive entries apply at every style, negative entries only in text/display.
  const classes = ["ord", "op", "bin", "rel", "open", "close", "punct", "inner"];
  const glue = [
    [0, 3, -4, -5, 0, 0, 0, -3],
    [3, 3, 0, -5, 0, 0, 0, -3],
    [-4, -4, 0, 0, -4, 0, 0, -4],
    [-5, -5, 0, 0, -5, 0, 0, -5],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 3, -4, -5, 0, 0, 0, -3],
    [-3, -3, 0, -3, -3, -3, -3, -3],
    [-3, 3, -4, -5, -3, 0, -3, -3]
  ];
  function row(t, style, font, cramped) {
    const b = newBox(),
      items = [];
    for (const node of t.items) {
      if (node.kind === "style") {
        style = node.style;
        continue;
      }
      const item = build(node, style, font, cramped);
      items.push({ item, style, cls: item.cls });
    }
    const atoms = items.filter(e => e.cls !== "space");
    for (let i = 0; i < atoms.length; i++) {
      const e = atoms[i];
      if (e.cls !== "bin") continue;
      if (
        !i ||
        i === atoms.length - 1 ||
        ["bin", "op", "rel", "open", "punct"].includes(atoms[i - 1].cls) ||
        ["rel", "close", "punct"].includes(atoms[i + 1]?.cls)
      )
        e.cls = "ord";
    }
    let prev = null;
    for (const e of items) {
      if (prev && e.cls !== "space") {
        const g = glue[classes.indexOf(prev)][classes.indexOf(e.cls)];
        if (g > 0 || styleLevel(e.style) === 0) b.advance += (Math.abs(g) * fontSize(e.style)) / 18;
      }
      append(b, e.item);
      if (e.cls !== "space") prev = e.cls;
    }
    if (items[0]?.cls === "ord") b.firstKern = items[0].item.firstKern;
    if (items.length === 1) {
      const single = items[0].item;
      for (const k of ["gid", "italic", "accent", "scale"]) if (k in single) b[k] = single[k];
    }
    return b;
  }
  function assembly(parts, v, required) {
    let repeats = 0,
      run = [],
      max = 0,
      joins = [];
    do {
      run = parts.flatMap(p => Array(p.extender ? repeats : 1).fill(p));
      joins = [];
      for (let i = 1; i < run.length; i++) joins.push(Math.min(run[i - 1].end, run[i].start));
      max = run.reduce((n, p) => n + p.extent, 0) - joins.reduce((n, j) => n + Math.min(j, v.minimumOverlap), 0);
      if (max >= required || !parts.some(p => p.extender)) break;
      repeats++;
    } while (repeats < 128);
    const flex = joins.reduce((n, j) => n + Math.max(0, j - v.minimumOverlap), 0);
    const factor = flex ? Math.max(0, Math.min(1, (max - required) / flex)) : 0;
    return {
      run,
      joins: joins.map(j => Math.min(j, v.minimumOverlap) + Math.max(0, j - v.minimumOverlap) * factor)
    };
  }
  function stretch(ch, t, sz, extent, vertical = true, under = false, assemble = true) {
    const id = F.idFor(ch.codePointAt(0)),
      v = F.variants(id, vertical),
      required = extent / sz;
    if (!v?.choices.length) return glyph(id, ch, t, sz, false);
    const choice = under
      ? [...v.choices].reverse().find(c => c.extent <= required) || v.choices[0]
      : v.choices.find(c => c.extent >= required);
    if (choice || !v.parts.length || !assemble) return glyph((choice || v.choices.at(-1)).gid, ch, t, sz, false);
    const { run, joins } = assembly(v.parts, v, required),
      b = newBox();
    let pos = 0;
    run.forEach((part, i) => {
      const g = F.glyph(part.gid),
        piece = glyph(part.gid, i === 0 ? ch : "", t, sz, false);
      put(b, piece, vertical ? 0 : pos - g.left * sz, vertical ? -pos + g.yMin * sz : 0);
      b.advance = vertical ? Math.max(b.advance, g.advance * sz) : pos + part.extent * sz;
      pos += (part.extent - (joins[i] || 0)) * sz;
    });
    b.plain = ch;
    b.italic = v.italic * sz;
    return b;
  }
  function centerAxis(b, sz) {
    const y = (b.ascent - b.descent) / 2 - F.constants().AxisHeight * sz,
      aligned = newBox(b.cls);
    put(aligned, b, 0, y);
    aligned.advance = b.advance;
    aligned.italic = b.italic || 0;
    aligned.plain = b.plain;
    return aligned;
  }
  function envelope(b, sz) {
    const d = Math.max(b.ascent - F.constants().AxisHeight * sz, b.descent + F.constants().AxisHeight * sz);
    return Math.max(2 * d * 0.901, 2 * d - (5 / 24) * sz);
  }
  function delimiter(ch, t, sz, extent) {
    if (ch) return centerAxis(stretch(ch, t, sz, extent), sz);
    const b = newBox();
    b.advance = 0.05 * sz;
    return b;
  }
  function fenced(t, style, font, cramped) {
    const sz = fontSize(style),
      content = t.parts.map(n => build(n, style, font, cramped)),
      b = newBox("inner");
    const extent = Math.max(...content.map(c => envelope(c, sz)));
    append(b, delimiter(t.left, t, sz, extent));
    content.forEach((p, i) => {
      if (i) append(b, delimiter(t.middle[i - 1], t, sz, extent));
      append(b, p);
    });
    append(b, delimiter(t.right, t, sz, extent));
    return b;
  }
  function fraction(t, style, font, cramped) {
    style = t.style || style;
    const sz = fontSize(style),
      C = F.constants(),
      display = style === "display",
      inner = fractionStyle(style);
    const num = build(t.num, inner, font, cramped),
      den = build(t.den, inner, font, true),
      b = newBox("inner");
    const w = Math.max(num.advance, den.advance),
      thick = C.FractionRuleThickness * sz,
      axis = C.AxisHeight * sz;
    let up, down;
    if (t.binomial) {
      up = (display ? C.StackTopDisplayStyleShiftUp : C.StackTopShiftUp) * sz;
      down = (display ? C.StackBottomDisplayStyleShiftDown : C.StackBottomShiftDown) * sz;
      const extra = Math.max(
        0,
        ((display ? C.StackDisplayStyleGapMin : C.StackGapMin) * sz - up - down + num.descent + den.ascent) / 2
      );
      up += extra;
      down += extra;
    } else {
      up = Math.max(
        (display ? C.FractionNumeratorDisplayStyleShiftUp : C.FractionNumeratorShiftUp) * sz,
        axis +
          thick / 2 +
          (display ? C.FractionNumDisplayStyleGapMin : C.FractionNumeratorGapMin) * sz +
          num.descent
      );
      down = Math.max(
        (display ? C.FractionDenominatorDisplayStyleShiftDown : C.FractionDenominatorShiftDown) * sz,
        den.ascent -
          axis +
          thick / 2 +
          (display ? C.FractionDenomDisplayStyleGapMin : C.FractionDenominatorGapMin) * sz
      );
      rule(b, 0, -axis - thick / 2, w, thick);
    }
    put(b, num, (w - num.advance) / 2, -up);
    put(b, den, (w - den.advance) / 2, down);
    b.advance = w;
    b.plain = t.binomial
      ? "(" + num.plain + " choose " + den.plain + ")"
      : "(" + num.plain + ")/(" + den.plain + ")";
    const framed = newBox("ord"),
      extent = display ? C.DelimitedSubFormulaMinHeight * sz : 0;
    append(framed, delimiter(t.binomial ? "(" : "", t, sz, extent));
    append(framed, b);
    append(framed, delimiter(t.binomial ? ")" : "", t, sz, extent));
    return framed;
  }
  function scripts(t, style, font, cramped) {
    const sz = fontSize(style),
      C = F.constants(),
      base = build(t.value, style, font, cramped),
      ss = smaller(style);
    const sup = t.sup && build(t.sup, ss, font, cramped),
      sub = t.sub && build(t.sub, ss, font, true);
    const b = newBox(base.cls),
      it = base.italic || 0;
    const limits =
      t.limits ??
      (t.value.kind === "operator" && style === "display" && (t.value.named ? t.value.limits : !t.value.integral));
    if (limits) {
      const w = Math.max(base.advance, sup?.advance || 0, sub?.advance || 0);
      put(b, base, (w - base.advance) / 2, 0);
      if (sup)
        put(
          b,
          sup,
          (w - sup.advance + it) / 2,
          -base.ascent - Math.max(C.UpperLimitGapMin * sz + sup.descent, C.UpperLimitBaselineRiseMin * sz)
        );
      if (sub)
        put(
          b,
          sub,
          (w - sub.advance - it) / 2,
          base.descent + Math.max(C.LowerLimitGapMin * sz + sub.ascent, C.LowerLimitBaselineDropMin * sz)
        );
      b.advance = w;
      if (sup) b.ascent += C.MathLeading * sz;
      if (sub) b.descent += C.MathLeading * sz;
    } else {
      let up = 0,
        down = 0;
      if (sup)
        up = Math.max(
          (cramped ? C.SuperscriptShiftUpCramped : C.SuperscriptShiftUp) * sz,
          sup.descent + C.SuperscriptBottomMin * sz,
          base.gid == null ? base.ascent - C.SuperscriptBaselineDropMax * fontSize(ss) : 0
        );
      if (sub)
        down = Math.max(
          C.SubscriptShiftDown * sz,
          sub.ascent - C.SubscriptTopMax * sz,
          base.gid == null ? base.descent + C.SubscriptBaselineDropMin * fontSize(ss) : 0
        );
      if (sub && sup) {
        const gap = Math.max(0, C.SubSuperscriptGapMin * sz - (up + down - sup.descent - sub.ascent));
        down += gap;
        const lift = gap > 0 ? Math.max(0, C.SuperscriptBottomMaxWithSubscript * sz - (up - sup.descent)) : 0;
        up += lift;
        down -= lift;
      }
      put(b, base, 0, 0);
      b.advance = base.advance;
      function xAttachment(script, above) {
        const first = script.firstKern;
        if (base.gid == null || !first) return base.advance - (above ? 0 : it);
        const sy = above ? up : -down,
          level = first.scale,
          baseY = above ? base.ascent : -base.descent,
          scriptY = (above ? F.glyph(first.gid).yMin : F.glyph(first.gid).yMax) * level;
        const corner = above ? 0 : 2,
          opposite = above ? 3 : 1;
        const kernAt = h =>
          F.kern(base.gid, corner, h / base.scale) * base.scale +
          F.kern(first.gid, opposite, (h - sy) / level) * level;
        return base.advance - (above ? 0 : it) + Math.max(kernAt(baseY), kernAt(sy + scriptY));
      }
      for (const [part, above, y] of [
        [sup, true, -up],
        [sub, false, down]
      ])
        if (part) {
          const x = xAttachment(part, above);
          put(b, part, x, y);
          b.advance = Math.max(b.advance, x + part.advance);
        }
      b.advance += 1 / 48;
    }
    b.plain = base.plain + (sub ? "_(" + sub.plain + ")" : "") + (sup ? "^(" + sup.plain + ")" : "");
    return b;
  }
  function radical(t, style, font) {
    const sz = fontSize(style),
      C = F.constants(),
      body = build(t.value, style, font, true),
      b = newBox();
    const thick = C.RadicalRuleThickness * sz,
      minimum = (style === "display" ? C.RadicalDisplayStyleVerticalGap : C.RadicalVerticalGap) * sz;
    const required = body.ascent + body.descent + minimum + thick,
      sign = stretch("√", t, sz, required);
    const gap = minimum + Math.max(0, (sign.ascent + sign.descent - required) / 2);
    const top = -body.ascent - gap - thick,
      degree = t.degree && build(t.degree, "scriptscript", font, false);
    const height = Math.max(body.ascent, -top + Math.min(C.RadicalExtraAscender * sz, thick));
    const depth = Math.max(body.descent, top + sign.ascent + sign.descent);
    let x = 0;
    if (degree) {
      const degreeScale = fontSize("scriptscript"),
        before = C.RadicalKernBeforeDegree * degreeScale;
      x = Math.max(0, before + degree.advance + C.RadicalKernAfterDegree * degreeScale);
      put(b, degree, before, -(height - depth) * C.RadicalDegreeBottomRaisePercent);
    }
    put(b, sign, x, top + sign.ascent);
    put(b, body, x + sign.advance, 0);
    rule(b, x + sign.advance, top, body.advance, thick);
    b.advance = x + sign.advance + body.advance;
    b.ascent = Math.max(b.ascent, height);
    b.plain = (degree ? "root[" + degree.plain + "]" : "√") + "(" + body.plain + ")";
    return b;
  }
  function accent(t, style, font, cramped) {
    const sz = fontSize(style),
      C = F.constants(),
      body = build(t.value, style, font, true),
      b = newBox();
    put(b, body, 0, 0);
    b.advance = body.advance;
    b.plain = body.plain;
    if (t.kind === "overline" || t.kind === "underline") {
      const over = t.kind === "overline",
        w = (over ? C.OverbarRuleThickness : C.UnderbarRuleThickness) * sz;
      const y = over ? -body.ascent - C.OverbarVerticalGap * sz - w : body.descent + C.UnderbarVerticalGap * sz;
      rule(b, 0, y, b.advance, w);
      if (over) b.ascent += C.OverbarExtraAscender * sz;
      else b.descent += C.UnderbarExtraDescender * sz;
      b.plain = t.kind + "(" + body.plain + ")";
      return b;
    }
    const wide = ["widehat", "widetilde", "overrightarrow", "overbrace", "underbrace"].includes(t.name);
    const mark = wide
      ? stretch(t.mark, t, sz, body.advance, false, true)
      : character(t.mark, t, sz, "roman", false);
    const g = F.glyph(mark.gid ?? 0),
      brace = t.name.endsWith("brace");
    if (brace) {
      const y =
        t.name === "underbrace"
          ? body.descent + mark.ascent + C.StretchStackGapBelowMin * sz
          : -body.ascent - mark.descent - C.StretchStackGapAboveMin * sz;
      put(b, mark, (body.advance - mark.advance) / 2, y);
    } else
      put(
        b,
        mark,
        (body.accent ?? body.advance / 2) - g.accent * sz,
        -Math.max(0, body.ascent - C.AccentBaseHeight * sz)
      );
    if (body.gid != null) {
      b.gid = body.gid;
      b.scale = body.scale;
      b.italic = body.italic;
      b.accent = body.accent;
      b.firstKern = body.firstKern;
    }
    b.plain = t.name + "(" + body.plain + ")";
    return b;
  }
  function matrix(t, style, font, cramped) {
    const sz = fontSize(style),
      small = t.name === "smallmatrix",
      cases = t.name.endsWith("cases"),
      align = t.name.startsWith("aligned");
    const inner = small ? "script" : t.name === "dcases" || align ? "display" : "text";
    const cells = t.rows.filter(r => r.length).map(r => r.map(c => build(c, inner, font, cramped)));
    const n = Math.max(0, ...cells.map(r => r.length)),
      widths = Array(n).fill(0),
      body = newBox();
    for (const r of cells)
      r.forEach((c, i) => {
        widths[i] = Math.max(widths[i], c.advance);
      });
    const gap = (cases ? 1 : small ? 5 / 18 : align ? 0 : 10 / 24) * sz;
    const strut = metric => (small ? 0 : metric * (cases ? 1.2 : 1) * sz);
    let next = 0,
      previousBase;
    for (const r of cells) {
      const up = Math.max(strut(0.875), ...r.map(c => c.ascent)),
        down = Math.max(strut(0.375), ...r.map(c => c.descent));
      let baseline = next + up;
      if (small && previousBase != null) {
        const ex = (1.5 / 24) * sz;
        baseline = Math.max(previousBase + 6 * ex, next + 1.5 * ex + up);
      }
      previousBase = baseline;
      let x = small ? sz / 6 : 0;
      r.forEach((c, i) => {
        const alignCol = t.columns[i] || (cases ? "l" : align ? (i % 2 ? "l" : "r") : "c");
        const offset =
          alignCol === "l" ? 0 : alignCol === "r" ? widths[i] - c.advance : (widths[i] - c.advance) / 2;
        put(body, c, x + offset, baseline);
        x += widths[i] + gap;
      });
      next = baseline + down;
    }
    body.advance = widths.reduce((a, c) => a + c, 0) + Math.max(n - 1, 0) * gap + (small ? sz / 3 : 0);
    body.ascent = 0;
    body.descent = next;
    body.plain = cells.map(r => r.map(c => c.plain).join(", ")).join("; ");
    const centered = centerAxis(body, sz),
      extent = envelope(centered, sz),
      b = newBox("inner");
    if (t.delimiters[0]) append(b, delimiter(t.delimiters[0], t, sz, extent));
    append(b, centered);
    if (t.delimiters[1] || cases) append(b, delimiter(t.delimiters[1], t, sz, extent));
    return b;
  }
  function build(t, style, font, cramped) {
    const sz = fontSize(style);
    switch (t.kind) {
      case "row":
        return row(t, style, font, cramped);
      case "group":
        return build(t.value, style, font, cramped);
      case "font":
        return build(t.value, style, t.font, cramped);
      case "text":
        return words(t, sz, "roman");
      case "glyph": {
        const b = character(t.text, t, sz, font);
        b.cls = t.cls;
        return b;
      }
      case "space": {
        const b = newBox("space");
        b.advance = (t.mu * sz) / 18;
        b.plain = t.mu > 0 ? " " : "";
        return b;
      }
      case "operator": {
        if (t.named) return words(t, sz, "roman");
        const extent = style === "display" ? F.constants().DisplayOperatorMinHeight * sz : 0;
        const b = centerAxis(stretch(t.text, t, sz, extent, true, false, false), sz);
        b.cls = "op";
        return b;
      }
      case "delimiter": {
        const b = delimiter(t.text, t, sz, t.extent * sz);
        b.cls = t.cls;
        return b;
      }
      case "fenced":
        return fenced(t, style, font, cramped);
      case "fraction":
        return fraction(t, style, font, cramped);
      case "radical":
        return radical(t, style, font);
      case "scripts":
        return scripts(t, style, font, cramped);
      case "matrix":
        return matrix(t, style, font, cramped);
      case "accent":
      case "overline":
      case "underline":
        return accent(t, style, font, cramped);
      case "phantom": {
        const b = build(t.value, style, font, cramped);
        b.commands = [];
        b.plain = "";
        return b;
      }
      default:
        return newBox();
    }
  }
  function layout(source, { display = false } = {}) {
    const tex = String(source ?? ""),
      key = (display ? "D" : "I") + tex;
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const { root, errors } = T.parse(tex);
    let b;
    try {
      b = build(root, display ? "display" : "text", "normal", false);
    } catch (e) {
      b = newBox();
      errors.push({ start: root.start, end: root.end, message: e.message || "Unable to lay out the formula." });
    }
    const value = Object.freeze({
      advance: b.advance,
      ascent: b.ascent,
      descent: b.descent,
      plain: b.plain,
      commands: Object.freeze(b.commands.map(Object.freeze)),
      errors: Object.freeze(errors.map(Object.freeze))
    });
    if (tex.length <= T.MAX_LENGTH) {
      cache.set(key, value);
      cachedCommands += value.commands.length;
      while (cache.size > MAX_CACHE || cachedCommands > MAX_CACHED_COMMANDS) {
        const first = cache.keys().next().value;
        cachedCommands -= cache.get(first).commands.length;
        cache.delete(first);
      }
    }
    return value;
  }
  function canvasPath(gid) {
    let path = canvasPaths.get(gid);
    if (!path) {
      path = new Path2D(F.path(gid));
      canvasPaths.set(gid, path);
    }
    return path;
  }
  function draw(ctx, l, { x = 0, y = 0, size = 1, ink = "currentColor" } = {}) {
    if (typeof ctx.drawMath === "function") {
      ctx.save();
      ctx.fillStyle = ink;
      ctx.drawMath(l, x, y, size);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size, size);
    ctx.fillStyle = ink;
    for (const c of l.commands) {
      if (c.kind === "rule") {
        ctx.fillRect(c.x, c.y, c.w, c.h);
        continue;
      }
      const factor = c.scale / F.unitsPerEm(),
        path = canvasPath(c.gid);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(factor, factor);
      ctx.fill(path);
      ctx.restore();
    }
    ctx.restore();
  }
  const esc = s =>
    String(s).replace(
      /[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]
    );
  function inkBounds(l) {
    // Pad actual outlines (some accents and italic glyphs overhang their TeX advance).
    let left = 0,
      right = l.advance,
      top = -l.ascent,
      bottom = l.descent;
    for (const c of l.commands)
      if (c.kind === "glyph") {
        const g = F.glyph(c.gid);
        left = Math.min(left, c.x + g.left * c.scale);
        right = Math.max(right, c.x + g.right * c.scale);
        top = Math.min(top, c.y - g.yMax * c.scale);
        bottom = Math.max(bottom, c.y - g.yMin * c.scale);
      }
    return { left, top, w: Math.max(0.01, right - left), h: Math.max(0.01, bottom - top) };
  }
  function svg(l, { size = 24, ink = "currentColor" } = {}) {
    if (
      typeof ink !== "string" ||
      !/^(?:[a-z]+|#[a-f0-9]{3,8}|(?:rgb|hsl)a?\([\d.,% +/]+\)|var\(--[a-z0-9-]+\))$/i.test(ink)
    )
      ink = "currentColor";
    const glyphs = new Set(l.commands.filter(c => c.kind === "glyph").map(c => c.gid));
    const num = n => Number(n.toFixed(6));
    const defs = Array.from(glyphs, g => '<path id="g' + g + '" d="' + F.path(g) + '"/>').join("");
    const shapes = F.svgShapes(l, gid => "g" + gid);
    const { left, top, w, h } = inkBounds(l);
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="' +
      [left, top, w, h].map(num).join(" ") +
      '" width="' +
      num(w * size) +
      '" height="' +
      num(h * size) +
      '"><title>' +
      esc(l.plain) +
      "</title><defs>" +
      defs +
      '</defs><g fill="' +
      esc(ink) +
      '">' +
      shapes +
      "</g></svg>"
    );
  }
  const DEFAULT_SIZE = 3.5;
  const noteBoxes = new WeakMap(),
    noteLayouts = new WeakMap();
  function noteDimensions(l, size = DEFAULT_SIZE) {
    let ink = noteBoxes.get(l);
    if (!ink) {
      ink = inkBounds(l);
      noteBoxes.set(l, ink);
    }
    return { w: ink.w * size, h: ink.h * size, dx: -ink.left * size, dy: -ink.top * size };
  }
  function noteLayout(item) {
    let entry = noteLayouts.get(item);
    if (!entry || entry.tex !== item.text) {
      entry = { tex: item.text, layout: layout(item.text, { display: true }) };
      noteLayouts.set(item, entry);
    }
    return entry.layout;
  }
  async function prepareSheet(sheet, check) {
    if (sheet?.kind !== "schematic") return;
    let slice = performance.now();
    for (const item of sheet.items) {
      if (item.kind !== "textframe" || item.math !== true) continue;
      const l = noteLayout(item);
      noteDimensions(l, item.size || DEFAULT_SIZE);
      if (typeof Path2D === "function") for (const c of l.commands) if (c.kind === "glyph") canvasPath(c.gid);
      if (performance.now() - slice >= 4) {
        check?.();
        await new Promise(resolve => setTimeout(resolve, 0));
        slice = performance.now();
      }
    }
    check?.();
  }
  function drawItem(ctx, item, ink) {
    const l = noteLayout(item),
      size = item.size || DEFAULT_SIZE,
      d = noteDimensions(l, size);
    draw(ctx, l, { x: item.x + d.dx, y: item.y + d.dy, size, ink });
  }
  return Object.freeze({
    layout,
    draw,
    svg,
    noteDimensions,
    prepareSheet,
    drawItem,
    DEFAULT_SIZE,
    commands: T.commands
  });
})();
