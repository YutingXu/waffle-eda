"use strict";
// Find and Replace Text (Edit menu, Ctrl/⌘+F on schematics, Ctrl/⌘+H): designators,
// comments, net labels, ports, power ports, off sheet connectors, sheet symbols and entries,
// part parameters and free text, on the current document, the selection or the whole
// project. Case, whole-word and regular-expression options. Replace All is one undo step.
//
//   AtriumFindReplace.search(project, {query, scope, docId, selection, matchCase, wholeWord, regex, fields})
//     -> [{docId, docName, id, kind, field, key, label, text, index, length}]
//   AtriumFindReplace.replace(project, hits, replacement, options) -> number of fields changed
// fields: {designators, comments, labels, parameters, text} (all true by default).
globalThis.AtriumFindReplace = (() => {
  const FIELD_LABELS = {designators:"Designators", comments:"Comments", labels:"Net labels and ports", parameters:"Parameters", text:"Text"};
  const KIND_NAMES = {part:"Part", netlabel:"Net label", power:"Power port", port:"Port", offsheet:"Off sheet", sheetsymbol:"Sheet symbol", label:"Text", textframe:"Text frame"};
  const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Regular expressions that can backtrack exponentially are refused: a quantified group that
  // itself contains a quantifier or an alternation ((a+)+, (a|aa)*, (x\d*){2,}), and
  // backreferences. Typed by the user or sent over MCP, they would otherwise freeze the thread.
  const MAX_REGEX = 200, BUDGET_MS = 2000, MAX_FIELD = 20000;
  function riskyRegex(src) {
    if (/\\[1-9k]/.test(src)) return "backreferences";
    const stack = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") { i++; continue; }
      if (c === "[") { while (i < src.length && src[i] !== "]") { if (src[i] === "\\") i++; i++; } continue; }
      if (c === "(") stack.push({inner: false});
      else if (c === ")") {
        const g = stack.pop() || {inner: false}, next = src[i + 1];
        if (g.inner && (next === "+" || next === "*" || next === "{")) return "a repeated group that repeats or alternates inside";
        if (stack.length) stack[stack.length - 1].inner ||= g.inner || next === "+" || next === "*" || next === "{" || next === "?";
      } else if ((c === "+" || c === "*" || c === "{" || c === "|") && stack.length) stack[stack.length - 1].inner = true;
    }
    return null;
  }
  // A global RegExp for the query, or throws with a readable message.
  function matcher(o) {
    const q = String(o.query ?? "");
    if (!q) return null;
    if (o.regex && q.length > MAX_REGEX) throw Error("Regular expressions are limited to " + MAX_REGEX + " characters.");
    const risk = o.regex ? riskyRegex(q) : null;
    if (risk) throw Error("This regular expression could take very long to run (" + risk + "). Simplify it, for example (ab)+ instead of (a|ab)+.");
    let src = o.regex ? q : escape(q);
    if (o.wholeWord) src = "(?<![\\p{L}\\p{N}_])(?:" + src + ")(?![\\p{L}\\p{N}_])";
    try {return new RegExp(src, "gu" + (o.matchCase ? "" : "i"));}
    catch (e) {throw Error("Invalid regular expression: " + e.message);}
  }
  // Every searchable text field of an item: [category, key, label]. key is a path.
  function fieldsOf(i) {
    const out = [];
    switch (i.kind) {
      case "part":
        out.push(["designators", "ref", "Designator"], ["comments", "value", "Comment"]);
        for (const k of Object.keys(i.parameters || {})) if (typeof i.parameters[k] === "string") out.push(["parameters", "parameters." + k, k]);
        break;
      case "netlabel": out.push(["labels", "text", "Net label"]); break;
      case "power": case "port": case "offsheet": out.push(["labels", "text", KIND_NAMES[i.kind]]); break;
      case "sheetsymbol":
        out.push(["designators", "name", "Sheet symbol"]);
        (i.entries || []).forEach((e, n) => out.push(["labels", "entries." + n + ".name", "Sheet entry"]));
        break;
      case "label": case "textframe": out.push(["text", "text", KIND_NAMES[i.kind]]); break;
    }
    return out;
  }
  function get(i, key) {
    const p = key.split(".");
    if (p[0] === "parameters") return i.parameters?.[p.slice(1).join(".")];
    if (p[0] === "entries") return i.entries?.[+p[1]]?.name;
    return i[key];
  }
  function set(i, key, v) {
    const p = key.split(".");
    if (p[0] === "parameters") i.parameters[p.slice(1).join(".")] = v;
    else if (p[0] === "entries") i.entries[+p[1]].name = v;
    else i[key] = v;
  }
  function documents(project, o) {
    const docs = project?.documents || [];
    if (o.scope === "project") return docs;
    return docs.filter(d => d.id === o.docId);
  }
  function search(project, o = {}) {
    const re = matcher(o), want = {designators:true, comments:true, labels:true, parameters:true, text:true, ...(o.fields || {})};
    if (!re) return [];
    const sel = o.scope === "selection" ? new Set(o.selection || []) : null, out = [], start = Date.now();
    for (const d of documents(project, o)) for (const i of d.items) {
      // A total time budget, whatever the pattern: the search stops instead of holding the thread.
      if (o.regex && Date.now() - start > BUDGET_MS) throw Error("The search took longer than " + BUDGET_MS / 1000 + " s and was stopped. Narrow the scope or simplify the expression.");
      if (sel && !sel.has(i.id)) continue;
      for (const [cat, key, label] of fieldsOf(i)) {
        if (!want[cat]) continue;
        const text = get(i, key);
        if (typeof text !== "string" || !text || (o.regex && text.length > MAX_FIELD)) continue;
        re.lastIndex = 0;
        const m = re.exec(text);
        if (!m) continue;
        out.push({docId:d.id, docName:d.name, id:i.id, kind:i.kind, field:cat, key, label, text, index:m.index, length:m[0].length});
        if (out.length >= 5000) return out;
      }
    }
    return out;
  }
  // Replace every match inside each hit's field. With regex on, $1… refer to groups.
  function replace(project, hits, replacement, o = {}) {
    const re = matcher(o);
    if (!re) return 0;
    const byDoc = new Map((project?.documents || []).map(d => [d.id, d]));
    let n = 0;
    for (const h of hits) {
      const item = byDoc.get(h.docId)?.items.find(i => i.id === h.id);
      if (!item) continue;
      const text = get(item, h.key);
      if (typeof text !== "string") continue;
      re.lastIndex = 0;
      const next = o.regex ? text.replace(re, String(replacement ?? "")) : text.replace(re, () => String(replacement ?? ""));
      if (next !== text && (next.trim() || h.field === "text" || h.field === "parameters")) {set(item, h.key, next); n++;}
    }
    return n;
  }

  // ------------------------------------------------------------------ dialog
  let dialog = null;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const host = () => globalThis.AtriumNavHost;
  function open(focusReplace = false) {
    const H = host();
    if (!H) return;
    // The native close event may still be queued when another command arrives.
    if (dialog?.open && dialog.isConnected) {
      dialog.querySelector(focusReplace ? ".fr-replace" : ".fr-find")?.focus();
      dialog.querySelector(focusReplace ? ".fr-replace" : ".fr-find")?.select?.();
      return;
    }
    const d = el("dialog", null, "fr-dialog"); d.setAttribute("aria-label", "Find and Replace Text");
    const head = el("header", null, "fr-head"); head.append(el("h2", "Find and Replace Text"));
    const close = el("button", "×", "ui-close fr-close"); close.type = "button"; AtriumNavCommon.shortcutTitle(close, "Close", "Escape"); close.setAttribute("aria-label", "Close"); head.append(close);
    const form = el("form", null, "fr-form");
    const input = (cls, label, placeholder) => {const l = el("label", null, "fr-row"), i = el("input", null, "ui-field " + cls); i.type = "text"; i.placeholder = placeholder; i.autocomplete = "off"; i.spellcheck = false; i.setAttribute("aria-label", label); l.append(el("span", label), i); form.append(l); return i;};
    const find = input("fr-find", "Find", "Text, R1, NET_*…"), repl = input("fr-replace", "Replace with", "Replacement");
    const scopeRow = el("label", null, "fr-row"), scope = el("select", null, "ui-field");
    for (const [v, t] of [["doc", "Current document"], ["project", "Whole project"], ["selection", "Selection"]]) scope.add(new Option(t, v));
    scope.setAttribute("aria-label", "Scope"); scopeRow.append(el("span", "Scope"), scope); form.append(scopeRow);
    const opts = el("div", null, "fr-options"), flag = (label, on = false) => {const l = el("label", null, "ui-checkbox-row"), c = el("input", null, "ui-checkbox"); c.type = "checkbox"; c.checked = on; l.append(c, " " + label); opts.append(l); return c;};
    const matchCase = flag("Match case"), wholeWord = flag("Whole words"), regex = flag("Regular expression");
    form.append(opts);
    const cats = el("fieldset", null, "fr-fields"); cats.append(el("legend", "Search in"));
    const fieldBoxes = {};
    for (const [k, t] of Object.entries(FIELD_LABELS)) {const l = el("label", null, "ui-checkbox-row"), c = el("input", null, "ui-checkbox"); c.type = "checkbox"; c.checked = true; fieldBoxes[k] = c; l.append(c, " " + t); cats.append(l);}
    form.append(cats);
    const actions = el("div", null, "fr-actions");
    const bFind = el("button", "Find All", "is-primary"), bOne = el("button", "Replace"), bAll = el("button", "Replace All");
    bFind.type = "submit"; bOne.type = bAll.type = "button"; actions.append(bFind, bOne, bAll); form.append(actions);
    const summary = el("p", "", "fr-summary"); summary.setAttribute("role", "status");
    const list = el("ol", null, "fr-results"); list.setAttribute("aria-label", "Results");
    d.append(head, form, summary, list); document.body.append(d); dialog = d;
    let hits = [], current = -1;
    const options = () => ({query:find.value, scope:scope.value, docId:H.currentId(), selection:H.selection(), matchCase:matchCase.checked, wholeWord:wholeWord.checked, regex:regex.checked,
      fields:Object.fromEntries(Object.entries(fieldBoxes).map(([k, c]) => [k, c.checked]))});
    function render() {
      list.replaceChildren();
      hits.slice(0, 500).forEach((h, n) => {
        const li = el("li"), b = el("button", null, "fr-hit"); b.type = "button"; b.setAttribute("aria-current", String(n === current));
        const pre = h.text.slice(0, h.index), mid = h.text.slice(h.index, h.index + h.length), post = h.text.slice(h.index + h.length);
        const t = el("span", null, "fr-text"); t.append(pre, el("mark", mid), post);
        b.append(el("span", h.label, "fr-kind"), t, el("span", h.docName, "fr-doc"));
        b.onclick = () => {current = n; go(h); render();};
        li.append(b); list.append(li);
      });
      if (hits.length > 500) list.append(el("li", "… " + (hits.length - 500) + " more", "fr-more"));
    }
    function go(h) {
      const owner = H.project().documents.find(x => x.id === h.docId);
      if (!owner) return;
      H.messageContext().select(h.id);
    }
    function run() {
      try {hits = search(H.project(), options()); current = hits.length ? 0 : -1; summary.textContent = find.value ? hits.length + (hits.length === 1 ? " match" : " matches") : "Type the text to find."; summary.classList.remove("fr-error");}
      catch (e) {hits = []; current = -1; summary.textContent = e.message; summary.classList.add("fr-error");}
      render();
      return hits;
    }
    form.onsubmit = e => {e.preventDefault(); run(); if (hits[0]) go(hits[0]);};
    let timer = 0;
    find.oninput = () => {clearTimeout(timer); timer = setTimeout(run, 120);};
    for (const c of [matchCase, wholeWord, regex, scope, ...Object.values(fieldBoxes)]) c.onchange = run;
    bOne.onclick = () => {
      if (!hits.length) run();
      const h = hits[current] || hits[0];
      if (!h) return;
      let n = 0;
      try {H.edit(() => {n = replace(H.project(), [h], repl.value, options());});} catch (e) {summary.textContent = e.message; return;}
      H.info(n ? "Replaced in " + h.label.toLowerCase() + " " + (h.text) + "." : "Nothing replaced.");
      const at = current; run(); current = Math.min(at, hits.length - 1); render(); if (hits[current]) go(hits[current]);
    };
    bAll.onclick = () => {
      const found = run();
      if (!found.length) return;
      let n = 0;
      try {H.edit(() => {n = replace(H.project(), found, repl.value, options());});} catch (e) {summary.textContent = e.message; return;}
      H.info("Replace All: " + n + (n === 1 ? " field" : " fields") + " changed (one undo step).");
      run(); summary.textContent = n + (n === 1 ? " field replaced" : " fields replaced") + (hits.length ? " · " + hits.length + " still match" : "") + ".";
    };
    d.addEventListener("close", () => {
      clearTimeout(timer);
      d.remove();
      if (dialog === d) dialog = null;
    }, {once: true});
    const done = () => {clearTimeout(timer); d.close(); H.canvas?.()?.focus?.();};
    close.onclick = done;
    d.addEventListener("keydown", e => {
      if (e.key === "Escape") {e.preventDefault(); e.stopPropagation(); done();}
      else if (e.key === "Enter" && e.target === repl) {e.preventDefault(); bOne.click();}
    });
    globalThis.AtriumShell?.adoptDialog?.(d, {title:head.querySelector("h2"), body:[form,summary,list], actions, order:"provided"});
    d.show();
    const sel = H.selection(), item = sel.length === 1 && H.doc().items.find(i => i.id === sel[0]);
    const seed = item && (item.ref || item.text || item.name);
    if (seed && typeof seed === "string") find.value = seed;
    (focusReplace ? repl : find).focus(); find.select();
    H.info(focusReplace ? "Find and replace: type the text and its replacement." : "Find: type the text to look for.");
    if (find.value) run();
  }
  function install(H) {
    H.registerAction("find-replace", () => open(true));
    H.registerAction("find-text", () => open(false));
  }
  if (globalThis.AtriumNavHost) install(globalThis.AtriumNavHost);
  return Object.freeze({search, replace, matcher, fieldsOf, open, FIELD_LABELS});
})();
