"use strict";
// CSS audit, run in WebKit by ui.sh (ui-probes.js) and in Chrome as the baseline. Test-only.
// 1. Parses every app stylesheet with the engine's own parser (a constructed CSSStyleSheet) and
//    lists the rules and declarations it dropped: a selector it does not support drops the whole
//    rule; a property or value it does not support drops that declaration.
// 2. Computes every color-mix() expression and every colour token in each theme (dark, light,
//    high contrast, classic) and lists those the engine cannot compute.
// ui.sh reports only what WebKit drops and Chrome keeps.
globalThis.__cssAudit = (() => {
  // A small CSS reader for the app's own stylesheets: rules in order, with @media/@supports/
  // @layer/@container bodies flattened (the CSSOM walk below flattens the same way).
  function read(text) {
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const out = [];
    function block(s, i, end) {
      while (i < end) {
        while (i < end && /\s/.test(s[i])) i++;
        if (i >= end) break;
        const open = scanTo(s, i, "{;"), head = s.slice(i, open).trim();
        if (s[open] === ";") { i = open + 1; continue; } // @import, @charset
        const close = match(s, open);
        if (head.startsWith("@")) {
          if (/^@(media|supports|layer|container|document)\b/.test(head)) block(s, open + 1, close);
        } else out.push({selector: head, decls: decls(s.slice(open + 1, close))});
        i = close + 1;
      }
    }
    block(text, 0, text.length);
    return out;
  }
  function scanTo(s, i, chars) {
    let q = null, p = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c; else if (c === "(") p++; else if (c === ")") p--; else if (!p && chars.includes(c)) return i;
    }
    return s.length;
  }
  function match(s, i) {
    let depth = 0, q = null;
    for (; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return i;
    }
    return s.length;
  }
  function decls(body) {
    const out = [];
    let i = 0;
    while (i < body.length) {
      const j = scanTo(body, i, ";"), d = body.slice(i, j).trim(); i = j + 1;
      const k = d.indexOf(":"); if (k < 1) continue;
      out.push([d.slice(0, k).trim(), d.slice(k + 1).replace(/!\s*important\s*$/i, "").trim()]);
    }
    return out;
  }
  function cssom(sheet) {
    const out = [];
    (function walk(rules) {
      for (const r of rules) {
        if (r.constructor.name === "CSSStyleRule" || r.type === 1) out.push(r);
        else if (r.cssRules && !/Keyframes/.test(r.constructor.name)) walk(r.cssRules);
      }
    })(sheet.cssRules);
    return out;
  }
  const norm = s => s.replace(/["']/g, "").replace(/\s+/g, "").replace(/::?(before|after)\b/g, "::$1").toLowerCase();
  function colorMixes(value) {
    const out = [];
    let i = 0;
    while ((i = value.indexOf("color-mix(", i)) >= 0) {
      let p = 0, j = i;
      for (; j < value.length; j++) { if (value[j] === "(") p++; else if (value[j] === ")" && --p === 0) break; }
      out.push(value.slice(i, j + 1)); i = j + 1;
    }
    return out;
  }
  function parseAll(sources) {
    const droppedRules = [], dropped = [];
    let rules = 0, declarations = 0;
    const mixes = new Set(), tokens = new Map(), mixRules = [];
    for (const [file, text] of Object.entries(sources).sort()) {
      const sheet = new CSSStyleSheet();
      try { sheet.replaceSync(text); } catch (e) { droppedRules.push({file, selector: "(sheet) " + e.message}); continue; }
      const want = read(text), got = cssom(sheet);
      let g = 0;
      for (const w of want) {
        rules++;
        const n = norm(w.selector);
        // The engine keeps rules in order; a rule it dropped has no counterpart.
        let k = g; while (k < got.length && k < g + 4 && norm(got[k].selectorText) !== n) k++;
        if (k >= got.length || norm(got[k].selectorText) !== n) {
          // Selector serialisation differs between engines for a few forms; count a near miss as kept.
          if (got[g] && w.decls.length && w.decls.every(([p]) => got[g].style.getPropertyValue(p) !== "")) { g++; continue; }
          droppedRules.push({file, selector: w.selector});
          continue;
        }
        const rule = got[k]; g = k + 1;
        for (const [prop, value] of w.decls) {
          declarations++;
          for (const m of colorMixes(value)) mixes.add(m);
          if (!prop.startsWith("--") && /color-mix\(/.test(value)) mixRules.push({file, selector: w.selector, prop});
          if (prop.startsWith("--") && /^:root\b|^html\b|^\[data-theme|^:root\[/.test(w.selector.trim())) tokens.set(prop, value);
          if (rule.style.getPropertyValue(prop) !== "") continue;
          // A later declaration of the same property in this rule replaced it (the fallback pattern).
          if (w.decls.filter(([p]) => p === prop).length > 1) continue;
          // A prefixed twin in the same rule that the engine kept (user-select / -webkit-user-select).
          const twin = prop.startsWith("-webkit-") ? prop.slice(8) : "-webkit-" + prop;
          if (w.decls.some(([p]) => p === twin) && rule.style.getPropertyValue(twin) !== "") continue;
          let supports = null; try { supports = CSS.supports(prop, value); } catch {}
          // A shorthand holding var() is kept unparsed until computed time; some engines then
          // serialise it as "" although it applies. Not a drop.
          if (supports && /var\(/.test(value)) continue;
          dropped.push({file, selector: w.selector, prop, value, supports});
        }
      }
    }
    return {droppedRules, dropped, rules, declarations, mixes: [...mixes], tokens: [...tokens.keys()], mixRules};
  }
  // Computed colours: a probe element under a sentinel colour; an expression the engine cannot
  // compute leaves the inherited sentinel.
  function computeColours(mixes, tokens) {
    const box = document.createElement("div"), probe = document.createElement("span");
    box.style.color = "rgb(1, 2, 3)"; box.append(probe); document.body.append(box);
    const sentinel = getComputedStyle(box).color, out = [];
    const root = getComputedStyle(document.documentElement);
    const colourish = /^(#|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|oklab\(|oklch\(|color\(|color-mix\(|transparent$|currentcolor$|var\()/i;
    const list = [...mixes.map(m => ["mix", m]), ...tokens.filter(t => colourish.test(root.getPropertyValue(t).trim())).map(t => ["token", "var(" + t + ")"])];
    for (const [kind, expr] of list) {
      probe.style.color = ""; probe.style.setProperty("color", expr);
      const got = getComputedStyle(probe).color;
      if (got === sentinel || !got) out.push({kind, expr, got});
    }
    box.remove();
    return {checked: list.length, invalid: out};
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function run(sources) {
    const parsed = parseAll(sources), invalid = [], checked = {};
    const before = document.documentElement.getAttribute("data-theme");
    for (const theme of ["dark", "light", "hc", "classic"]) {
      window.dispatchEvent(new CustomEvent("atrium-command", {detail: "theme-" + theme}));
      await wait(150);
      const r = computeColours(parsed.mixes, parsed.tokens);
      checked[theme] = {applied: document.documentElement.getAttribute("data-theme"), checked: r.checked, invalid: r.invalid.length};
      for (const x of r.invalid) invalid.push({theme, ...x});
    }
    if (before) window.dispatchEvent(new CustomEvent("atrium-command", {detail: "theme-" + before}));
    await wait(100);
    return {engine: navigator.userAgent, rules: parsed.rules, declarations: parsed.declarations, droppedRules: parsed.droppedRules, dropped: parsed.dropped,
      mixes: parsed.mixes.length, tokens: parsed.tokens.length, mixRules: parsed.mixRules, themes: checked, invalid};
  }
  return {run, read, parseAll, computeColours};
})();
