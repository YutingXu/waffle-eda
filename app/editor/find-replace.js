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
  const ALL_FIELDS = {designators:true, comments:true, labels:true, parameters:true, text:true};
  const KIND_NAMES = {part:"Part", netlabel:"Net label", power:"Power port", port:"Port", offsheet:"Off sheet", sheetsymbol:"Sheet symbol", label:"Text", textframe:"Text frame"};
  const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Regular expressions that can backtrack exponentially are refused: a quantified group that
  // itself contains a quantifier or an alternation ((a+)+, (a|aa)*, (x\d*){2,}), and
  // backreferences. Typed by the user or sent over MCP, they would otherwise freeze the thread.
  const MAX_REGEX = 200, BUDGET_MS = 2000, MAX_FIELD = 20000, MAX_RESULTS = 5000;
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
  // key is the path used when replacing the text.
  function visitFields(i, visit, want = ALL_FIELDS) {
    switch (i.kind) {
      case "part":
        if (want.designators) visit("designators", "ref", "Designator", i.ref);
        if (want.comments) visit("comments", "value", "Comment", i.value);
        if (want.parameters && i.parameters) {
          for (const k of Object.keys(i.parameters)) {
            const text = i.parameters[k];
            if (typeof text === "string") visit("parameters", "parameters." + k, k, text);
          }
        }
        break;
      case "netlabel": case "power": case "port": case "offsheet":
        if (want.labels) visit("labels", "text", KIND_NAMES[i.kind], i.text);
        break;
      case "sheetsymbol":
        if (want.designators) visit("designators", "name", "Sheet symbol", i.name);
        if (want.labels && i.entries) i.entries.forEach((e, n) => visit("labels", "entries." + n + ".name", "Sheet entry", e?.name));
        break;
      case "label": case "textframe":
        if (want.text) visit("text", "text", KIND_NAMES[i.kind], i.text);
        break;
    }
  }
  function fieldsOf(i) {
    const out = [];
    visitFields(i, (category, key, label) => out.push([category, key, label]));
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
    const re = matcher(o), want = o.fields ? {...ALL_FIELDS, ...o.fields} : ALL_FIELDS;
    if (!re) return [];
    const sel = o.scope === "selection" ? new Set(o.selection || []) : null, out = [], start = Date.now();
    let doc, item;
    function match(field, key, label, text) {
      if (out.length >= MAX_RESULTS || typeof text !== "string" || !text || (o.regex && text.length > MAX_FIELD)) return;
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m) out.push({docId:doc.id, docName:doc.name, id:item.id, kind:item.kind, field, key, label, text, index:m.index, length:m[0].length});
    }
    for (const d of documents(project, o)) {
      doc = d;
      for (const i of d.items) {
        // A total time budget, whatever the pattern: the search stops instead of holding the thread.
        if (o.regex && Date.now() - start > BUDGET_MS) throw Error("The search took longer than " + BUDGET_MS / 1000 + " s and was stopped. Narrow the scope or simplify the expression.");
        if (sel && !sel.has(i.id)) continue;
        item = i;
        visitFields(i, match, want);
        if (out.length >= MAX_RESULTS) return out;
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
    let hits = [], current = -1, frame = 0;
    const options = () => ({query:find.value, scope:scope.value, docId:H.currentId(), selection:H.selection(), matchCase:matchCase.checked, wholeWord:wholeWord.checked, regex:regex.checked,
      fields:Object.fromEntries(Object.entries(fieldBoxes).map(([k, c]) => [k, c.checked]))});
    function render() {
      const rows = hits.slice(0, 500).map((h, n) => {
        const li = el("li"), b = el("button", null, "fr-hit"); b.type = "button"; b.setAttribute("aria-current", String(n === current));
        const pre = h.text.slice(0, h.index), mid = h.text.slice(h.index, h.index + h.length), post = h.text.slice(h.index + h.length);
        const t = el("span", null, "fr-text"); t.append(pre, el("mark", mid), post);
        b.append(el("span", h.label, "fr-kind"), t, el("span", h.docName, "fr-doc"));
        b.onclick = () => {
          list.children[current]?.firstElementChild?.setAttribute("aria-current", "false");
          b.setAttribute("aria-current", "true");
          current = n;
          go(h);
        };
        li.append(b);
        return li;
      });
      if (hits.length > 500) rows.push(el("li", "… " + (hits.length - 500) + " more", "fr-more"));
      list.replaceChildren(...rows);
    }
    function go(h) {
      const owner = H.project().documents.find(x => x.id === h.docId);
      if (!owner) return;
      H.messageContext().select(h.id);
    }
    function cancelSearch() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
    function scan() {
      cancelSearch();
      const project = H.project(), o = options();
      try {return {hits:search(project, o), project, options:o};}
      catch (error) {return {hits:[], error};}
    }
    function showResults(result = scan(), at = 0) {
      hits = result.hits;
      current = Math.min(at, hits.length - 1);
      summary.textContent = result.error ? result.error.message : !find.value ? "Type the text to find." :
        hits.length + (hits.length === 1 ? " match" : " matches");
      summary.classList.toggle("fr-error", !!result.error);
      render();
    }
    form.onsubmit = e => {e.preventDefault(); showResults(); if (hits[0]) go(hits[0]);};
    function searchSoon() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (d.open) showResults();
      });
    }
    find.oninput = e => {if (!e.isComposing) searchSoon();};
    find.addEventListener("compositionstart", cancelSearch);
    find.addEventListener("compositionend", searchSoon);
    for (const c of [matchCase, wholeWord, regex, scope, ...Object.values(fieldBoxes)]) c.onchange = () => showResults();
    function replaceMatches(all) {
      const previous = all || frame ? null : hits[current];
      const result = scan();
      if (!result.hits.length) {showResults(result); return;}
      const at = previous ? result.hits.findIndex(h => h.docId === previous.docId && h.id === previous.id && h.key === previous.key) : -1;
      const index = Math.max(0, at);
      const h = result.hits[index];
      const targets = all ? result.hits : [h];
      let n = 0;
      try {H.edit(() => {n = replace(result.project, targets, repl.value, result.options);});}
      catch (e) {summary.textContent = e.message; return;}
      showResults(scan(), index);
      if (all) {
        H.info("Replace All: " + n + (n === 1 ? " field" : " fields") + " changed (one undo step).");
        summary.textContent = n + (n === 1 ? " field replaced" : " fields replaced") + (hits.length ? " · " + hits.length + " still match" : "") + ".";
      } else {
        H.info(n ? "Replaced in " + h.label.toLowerCase() + " " + h.text + "." : "Nothing replaced.");
        if (hits[current]) go(hits[current]);
      }
    }
    bOne.onclick = () => replaceMatches(false);
    bAll.onclick = () => replaceMatches(true);
    d.addEventListener("close", () => {
      cancelSearch();
      d.remove();
      if (dialog === d) dialog = null;
    }, {once: true});
    const done = () => {cancelSearch(); d.close(); H.canvas?.()?.focus?.();};
    close.onclick = done;
    d.addEventListener("keydown", e => {
      if (e.isComposing) return;
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
    if (find.value) showResults();
  }
  function install(H) {
    H.registerAction("find-replace", () => open(true));
    H.registerAction("find-text", () => open(false));
  }
  if (globalThis.AtriumNavHost) install(globalThis.AtriumNavHost);
  return Object.freeze({search, replace, matcher, fieldsOf, open, FIELD_LABELS});
})();
