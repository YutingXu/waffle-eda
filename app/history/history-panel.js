"use strict";
// History panel (Window › Panels › History; lazy). Two lists:
//   Undo      every undo step with a label made from the edit ("Move R1, R2", "Route GND (3 tracks)",
//             "Repour GND_TOP", "Delete 12 objects"; the action's name when the edit says nothing
//             clearer). Click to preview, then click the step again to restore the reviewed changes in one edit.
//             Hover outlines the objects the step
//             touched on the canvas. Redo states an edit replaced are kept as alternate branches.
//   Timeline  autosave snapshots, explicit saves and (in the desktop app, for a saved project) Git
//             commits. Each has Compare with Current (Review Changes) and Restore as Copy.
// The undo states are AtriumUndoStore states (undo-store.js); labels come from the store's changes()
// between two states, which parses only the objects the step changed. diff() reads trees of the
// earlier store. diff(), summarize() and label() need no DOM (tests).
globalThis.AtriumHistoryPanel = (() => {
  const G = globalThis, U = () => G.AtriumUndoStore;
  const KIND = {part: "component", track: "track", arc: "arc", via: "via", pad: "pad", wire: "wire", polygon: "pour", netlabel: "net label", label: "text",
    text: "text", junction: "junction", region: "region", fill: "fill", port: "port", power: "power port", bus: "bus", noconnect: "no-connect", keepout: "keepout"};
  const MOVE = new Set(["x", "y", "points", "at", "center", "start", "end", "origin", "outline", "cx", "cy"]);
  const SETTINGS = {outline: "Change board outline", rules: "Edit design rules", grid: "Change grid", layerSets: "Edit layer sets",
    stackup: "Edit layer stack", variants: "Edit variants", classes: "Edit classes", rooms: "Edit rooms"};
  const plural = (n, w, p = w.replace(/(s|x|ch)$/, "$1e") + "s") => globalThis.AtriumI18n?.plural?.(n, w, p) ?? n + " " + (n === 1 ? w : p);

  // ------------------------------------------------------------------ diff (pure)
  const parsed = new WeakMap();
  const rows = c => { let v = parsed.get(c); if (!v) { v = JSON.parse("[" + c.s + "]"); parsed.set(c, v); } return v; };
  const restOf = n => (n?.r ? rows(n.r)[0] : {}) || {};
  const keyOf = e => e && typeof e === "object" && e.id != null ? "#" + e.id : "=" + JSON.stringify(e);
  const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  function changedKeys(a, b) {
    const out = [];
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) if (!same(a?.[k], b?.[k])) out.push(k);
    return out;
  }
  function arrDiff(ca, cb) {
    const A = new Set(ca), B = new Set(cb);
    let onlyA = ca.filter(c => !B.has(c)), onlyB = cb.filter(c => !A.has(c));
    if (onlyA.length && onlyB.length) { // equal text, different chunk objects
      const byText = new Map(onlyA.map(c => [c.s, c]));
      onlyB = onlyB.filter(c => { if (byText.has(c.s)) { byText.delete(c.s); return false; } return true; });
      onlyA = [...byText.values()];
    }
    const ma = new Map(), mb = new Map();
    for (const c of onlyA) for (const e of rows(c)) ma.set(keyOf(e), e);
    for (const c of onlyB) for (const e of rows(c)) mb.set(keyOf(e), e);
    const added = [], removed = [], modified = [];
    for (const [k, e] of mb) { const was = ma.get(k); if (!ma.has(k)) added.push(e); else if (!same(was, e)) modified.push([was, e]); }
    for (const [k, e] of ma) if (!mb.has(k)) removed.push(e);
    return {added, removed, modified};
  }
  // Every change between two trees: [{doc, path, added, removed, modified, keys, docAdded, docRemoved}].
  function diff(a, b) {
    const out = [];
    const docInfo = n => { const r = restOf(n); return {id: r.id, name: r.name || "", kind: r.kind || ""}; };
    function node(na, nb, path, doc) {
      if (!na && !nb) return;
      if (!na || !nb || !!na.a !== !!nb.a || !!na.l !== !!nb.l) { out.push({doc, path, keys: [path.split(".").pop()], replaced: true}); return; }
      if (na.a) { const d = arrDiff(na.a, nb.a); if (d.added.length || d.removed.length || d.modified.length) out.push({doc, path, ...d}); return; }
      if (na.l) {
        if (path === "documents") {
          const da = new Map(na.l.map(n => [restOf(n).id, n])), db = new Map(nb.l.map(n => [restOf(n).id, n]));
          for (const [id, n] of db) if (!da.has(id)) out.push({doc: docInfo(n), path: "", docAdded: true});
          for (const [id, n] of da) if (!db.has(id)) out.push({doc: docInfo(n), path: "", docRemoved: true});
          for (const [id, n] of db) if (da.has(id) && da.get(id) !== n) node(da.get(id), n, "", docInfo(n));
        } else if (na.l.length !== nb.l.length) out.push({doc, path, keys: [path], replaced: true});
        else na.l.forEach((n, i) => node(n, nb.l[i], path, doc));
        return;
      }
      if (na === nb) return;
      if (na.r !== nb.r && na.r.s !== nb.r.s) {
        const keys = changedKeys(restOf(na), restOf(nb));
        if (keys.length) out.push({doc, path, keys});
      }
      for (const k of new Set([...Object.keys(na.c), ...Object.keys(nb.c)])) {
        if (na.c[k] === nb.c[k]) continue;
        node(na.c[k], nb.c[k], path ? path + "." + k : k, doc);
      }
    }
    if (a && b) node(a.root, b.root, "", null);
    return out;
  }

  // ------------------------------------------------------------------ labels (pure)
  const nameOf = i => i?.kind === "part" && i.ref ? i.ref : i?.kind === "netlabel" && i.text ? i.text : i?.name || KIND[i?.kind] || i?.kind || "object";
  function names(list, word = "object") {
    const refs = [], kinds = new Map();
    for (const i of list) if (i?.kind === "part" && i.ref) refs.push(i.ref); else kinds.set(KIND[i?.kind] || word, (kinds.get(KIND[i?.kind] || word) || 0) + 1);
    const parts = refs.length > 3 ? [refs.slice(0, 2).join(", ") + " +" + (refs.length - 2)] : refs.length ? [refs.join(", ")] : [];
    if (kinds.size > 2) parts.push(plural([...kinds.values()].reduce((x, y) => x + y, 0), word));
    else for (const [w, n] of kinds) parts.push(n === 1 && !refs.length ? w : plural(n, w));
    return parts.join(", ");
  }
  const netsOf = list => [...new Set(list.map(i => i.net).filter(Boolean))];
  const netText = nets => nets.slice(0, 2).join(", ") + (nets.length > 2 ? " +" + (nets.length - 2) : "");
  // {label, generic, count, docs}: generic labels give way to the action's name.
  function summarize(changes, o = {}) {
    const added = [], removed = [], modified = [], pours = [], settings = [], docs = new Map();
    for (const c of changes) {
      if (c.doc?.id) docs.set(c.doc.id, c.doc);
      if (c.docAdded || c.docRemoved) continue;
      if (c.path === "items") { added.push(...c.added); removed.push(...c.removed); modified.push(...c.modified); }
      else if (/(^|\.)pours$/.test(c.path)) pours.push(c);
      else if (/^pcbDrawing(\.|$)/.test(c.path)) continue; // derived drawing data
      else settings.push(c);
    }
    const docAdded = changes.find(c => c.docAdded), docRemoved = changes.find(c => c.docRemoved);
    const docWord = d => d.kind === "pcb" ? "board" : d.kind === "schematic" ? "sheet" : "document";
    const count = added.length + removed.length + modified.length;
    const r = (label, generic = false) => ({label, generic, count, docs: [...docs.values()]});
    if (docAdded && !docRemoved) return r("Add " + docWord(docAdded.doc) + (docAdded.doc.name ? " " + docAdded.doc.name : ""));
    if (docRemoved && !docAdded) return r("Delete " + docWord(docRemoved.doc) + (docRemoved.doc.name ? " " + docRemoved.doc.name : ""));
    if (!count) {
      if (pours.length) {
        const ids = new Set();
        for (const p of pours) for (const x of [...p.added, ...p.removed, ...p.modified.map(m => m[1])]) ids.add(x.polygon ?? x.net);
        const nm = [...ids].map(id => o.pourName?.(id) || String(id ?? "pour"));
        return r(nm.length === 1 ? "Repour " + nm[0] : nm.length <= 3 ? "Repour " + nm.join(", ") : "Repour " + plural(nm.length, "pour"));
      }
      if (settings.length) {
        const keys = [...new Set(settings.flatMap(s => s.keys || [s.path.split(".")[0]]))];
        const k = keys.find(x => SETTINGS[x]);
        if (k) return r(SETTINGS[k]);
        if (keys.includes("name")) return r(settings.some(s => s.doc) ? "Rename " + docWord(settings.find(s => s.doc).doc) : "Rename project");
        if (settings.some(s => /^library/.test(s.path))) return r("Update library");
        return r("Edit " + (settings.some(s => s.doc) ? docWord(settings.find(s => s.doc).doc) : "project") + " settings", true);
      }
      return r("No visible change", true);
    }
    if (added.length && !removed.length && !modified.length) {
      const copper = added.filter(i => ["track", "via", "arc"].includes(i.kind));
      if (copper.length === added.length) {
        const t = copper.filter(i => i.kind !== "via").length, v = copper.length - t, nets = netsOf(copper);
        const what = [t && plural(t, "track"), v && plural(v, "via")].filter(Boolean).join(", ");
        return r(nets.length ? "Route " + netText(nets) + " (" + what + ")" : "Draw " + what);
      }
      if (added.every(i => i.kind === "part")) return r("Place " + names(added, "component"));
      if (added.every(i => i.kind === "wire")) return r(added.length === 1 ? "Draw wire" : "Draw " + plural(added.length, "wire"));
      return r("Add " + names(added));
    }
    if (removed.length && !added.length && !modified.length) {
      if (removed.length === 1) return r("Delete " + nameOf(removed[0]));
      const copper = removed.every(i => ["track", "via", "arc"].includes(i.kind)), nets = netsOf(removed);
      if (copper && nets.length && removed.some(i => i.kind !== "via")) return r("Unroute " + netText(nets) + " (" + plural(removed.length, new Set(removed.map(i => i.kind)).size === 1 ? KIND[removed[0].kind] : "object") + ")");
      const kinds = new Set(removed.map(i => i.kind));
      return r("Delete " + plural(removed.length, kinds.size === 1 ? KIND[removed[0].kind] || "object" : "object"));
    }
    if (modified.length && !added.length && !removed.length) {
      const keys = new Set(), items = modified.map(m => m[1]);
      for (const [a, b] of modified) for (const k of changedKeys(a, b)) keys.add(k);
      const only = set => [...keys].every(k => set.has(k));
      if (only(MOVE)) return r("Move " + names(items));
      if (keys.has("angle") && only(new Set([...MOVE, "angle"]))) return r("Rotate " + names(items));
      if (["side", "mirror", "mirrored", "flipped"].some(k => keys.has(k)) || keys.has("layer") && items.some(i => i.kind === "part")) return r("Flip " + names(items));
      if (only(new Set(["width"]))) return r("Change width of " + names(items));
      if (only(new Set(["layer"]))) return r("Change layer of " + names(items));
      if (only(new Set(["net"]))) return r("Change net of " + names(items));
      if (only(new Set(["locked"]))) return r((items.every(i => i.locked) ? "Lock " : "Unlock ") + names(items));
      if (modified.length === 1) return r("Edit " + nameOf(items[0]) + " (" + [...keys].slice(0, 3).join(", ") + ")", true);
      return r("Edit " + names(items), true);
    }
    const copper = [...added, ...removed, ...modified.map(m => m[1])].every(i => ["track", "via", "arc"].includes(i.kind));
    const nets = netsOf([...added, ...removed, ...modified.map(m => m[1])]);
    const parts = [added.length && added.length + " added", removed.length && removed.length + " removed", modified.length && modified.length + " changed"].filter(Boolean).join(", ");
    if (copper && nets.length) return r("Route " + netText(nets) + " (" + parts + ")");
    return r("Edit " + plural(count, "object") + " (" + parts + ")", true);
  }
  function actionTitle(id) {
    if (!id || /^(undo|redo|history-panel)$/.test(id)) return "";
    const title = G.AtriumKeymap?.command?.(id)?.title;
    const button = !title && G.document?.querySelector?.('.menu-items [data-action="' + String(id).replace(/"/g, "") + '"]');
    const t = title || (button ? G.AtriumNavCommon.menuLabel(button) : "");
    return String(t).trim().replace(/…$|\.\.\.$/, "");
  }
  // The label of the step from tree a to tree b (b.act names the edit that produced b).
  // Deferred comparison data belongs to the two marks. A label cache must
  // allow the journal to reclaim records after either mark drops out of Undo.
  const labels = new WeakMap();
  function label(a, b, o = {}) {
    if (!a || !b) return {label: b?.act?.label || "Start", generic: true, count: 0, docs: []};
    let successors=labels.get(a);
    if (!successors) {successors=new WeakMap();labels.set(a,successors);}
    const cached=successors.get(b);
    if (cached) return cached;
    const summary = b.root ? null : U().changeSummary?.(a,b);
    const rows = summary?.rows ?? (b.root ? diff(a,b) : U().changes(a,b));
    const s = summarize(rows, {pourName: id => pourName(b, id), ...o});
    const act = b.act || {}, explicit = act.label && !/^edit$/i.test(act.label) ? act.label : "", title = actionTitle(act.action);
    const text = act.branch ? act.label : explicit || (s.generic && title ? title + (s.count ? " (" + plural(s.count, "object") + ")" : "") : s.label);
    const out = {...s, label: text, rows, get changes() {return summary ? summary.details() : rows;}};
    successors.set(b,out);
    return out;
  }
  // A pour's name in tree b: find the chunk holding the polygon, parse only that one.
  function pourName(b, id) {
    if (id == null) return "";
    if (!b.root) { const p = U()?.find?.(id); return p ? p.name || [p.net, p.layer].filter(Boolean).join(" · ") || "pour" : ""; }
    const needle = '"id":' + JSON.stringify(id);
    for (const d of b.root.c.documents?.l || []) for (const c of d.c.items?.a || []) {
      if (!c.s.includes(needle)) continue;
      const p = rows(c).find(i => i.id === id);
      if (p) return p.name || [p.net, p.layer].filter(Boolean).join(" · ") || "pour";
    }
    return "";
  }

  // ------------------------------------------------------------------ host side
  let host = null, panel = null, ui = null, visual = null, visualLoading = null, tab = "undo", hover = null, paintTimer = 0, timeline = null;
  const hasDOM = () => typeof document !== "undefined" && !!document.createElement;
  const el = (tag, cls, text) => AtriumNavCommon.classedElement(document, tag, cls, text);
  const btn = (text, cls, fn, title) => {
    const b = el("button", cls, text); b.type = "button";
    if (cls === "hist-btn") { b.classList.add("ui-button"); b.dataset.size = "sm"; } b.onclick = e => { e.stopPropagation(); fn(e); };
    if (title) b.title = title;
    return b;
  };
  const say = m => host?.info?.(m);
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return "just now"; if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
    const d = new Date(t), today = new Date().toDateString() === d.toDateString();
    return (today ? "" : d.toLocaleDateString() + " ") + d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  }
  const mb = b => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB";
  const states = () => U().timeline(host);
  const tree = (state, i) => state.list[i] || null;
  function stepLabel(s, i) {
    if (i === 0) return {label: "Start", generic: true, count: 0, docs: [], first: true};
    return label(tree(s, i - 1), tree(s, i));
  }
  // Hover preview: boxes of the step's objects (before and after) on the visible document.
  function boxesFor(info, docId) {
    const d = host.docById?.(docId), C = G.AtriumNavCommon, defs = host.defs?.();
    if (!d || !C?.itemBox) return [];
    const out = [], add = i => { try { const b = C.itemBox(d, defs, i); if (b) out.push(b); } catch { /* unknown kind */ } };
    for (const c of info.rows || []) {
      if (c.doc?.id !== docId) continue;
      if (c.path === "items") { c.added.forEach(add); c.removed.forEach(add); for (const [a, b] of c.modified) { add(a); add(b); } }
      else if (/pours$/.test(c.path)) for (const x of [...c.added, ...c.removed, ...c.modified.map(m => m[1])]) if (Array.isArray(x.bounds)) out.push(x.bounds);
    }
    return out.slice(0, 2000);
  }
  function preview(i) {
    if (i == null || i < 1) { if (hover) { hover = null; host.invalidate?.(); } return; }
    const s = states(), info = stepLabel(s, i), id = host.currentId?.();
    hover = {i, doc: id, boxes: boxesFor(info, id)};
    host.invalidate?.();
  }
  function colour(name, fallback) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
  }
  function render(d) {
    if (!hover || !d || d.id !== hover.doc || !hover.boxes.length) return null;
    const boxes = hover.boxes, stroke = colour("--accent", "#3794ff");
    return {overlay: (ctx, {scale}) => {
      const px = 1 / (scale || 1);
      ctx.save(); ctx.strokeStyle = stroke; ctx.fillStyle = stroke; ctx.lineWidth = 1.5 * px; ctx.setLineDash([4 * px, 3 * px]);
      for (const b of boxes) {
        const m = 3 * px, x = b[0] - m, y = b[1] - m, w = b[2] - b[0] + 2 * m, h = b[3] - b[1] + 2 * m;
        ctx.globalAlpha = .12; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; ctx.strokeRect(x, y, w, h);
      }
      ctx.restore();
    }};
  }

  // ------------------------------------------------------------------ panel
  function build() {
    const nav = document.getElementById("properties");
    if (!nav) return false;
    panel = el("section", "panel panel-history"); panel.hidden = true; panel.setAttribute("aria-labelledby", "hist-heading");
    const head = el("header", "pane-heading"), h2 = el("h2", null, "History"); h2.id = "hist-heading";
    const tabs = el("div", "hist-tabs ui-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "History sources");
    const mk = (id, text) => { const b = btn(text, "hist-tab ui-tab", () => setTab(id)); b.setAttribute("role", "tab"); b.dataset.tab = id; return b; };
    tabs.append(mk("undo", "Undo"), mk("timeline", "Timeline"), mk("git", "Git"));
    const close = btn("×", "ui-close hist-close", () => toggle(false), "Close History"); close.setAttribute("aria-label", "Close History");
    head.append(h2, tabs, close);
    const list = el("div", "hist-list pane-scroll"); list.setAttribute("aria-label", "Undo steps"); list.tabIndex = 0;
    const branches = el("details", "hist-branches"); branches.append(el("summary", null, "Alternate branches"));
    const branchList = el("div", "hist-branch-list"); branches.append(branchList);branches.ontoggle=paintBranches;
    const times = el("div", "hist-list hist-timeline pane-scroll"); times.setAttribute("aria-label", "Local history"); times.hidden = true;
    const foot = el("p", "hist-foot");
    // Git tab: the commits that changed this file (file-history.js).
    const gitBox = el("div", "hist-list hist-git pane-scroll"); gitBox.setAttribute("aria-label", "Git file history"); gitBox.hidden = true;
    panel.append(head, list, branches, times, gitBox, foot);
    nav.append(panel);
    ui = {list, branches, branchList, times, gitBox, foot, tabs};
    list.addEventListener("pointerleave", () => preview(null));
    const spec = {id: "history", title: "History", element: panel, area: "right", action: "history-panel"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    return true;
  }
  function updateVisual() {
    const visible = () => tab === "undo" && !panel.hidden;
    const focusList = () => {
      if (ui.list.contains(document.activeElement)) ui.list.focus({preventScroll:true});
    };
    if (!visual && visible() && !visualLoading) {
      ui.list.replaceChildren(el("p", "ui-status-line", "Loading undo history…"));
      visualLoading = G.AtriumLazy.need(["AtriumUIKit", "AtriumVisualHistory"]).then(() => {
        visual = G.AtriumVisualHistory.mount(host, ui, {tree, stepLabel, preview});
        visual.show(visible());
        paint();
      }).catch(error => {
        const K = G.AtriumUIKit;
        if (!K) { say(error.message); return; }
        focusList();
        ui.list.replaceChildren(K.notice({tone:"danger", title:"Undo history could not load.", text:error.message, live:true,
          actions:[K.button("Try again", {size:"sm", run:updateVisual})]}));
      }).finally(() => { visualLoading = null; });
    }
    visual?.show(visible());
  }
  function setTab(id) {
    tab = id;
    updateVisual();
    for (const b of ui.tabs.children) {
      const selected = b.dataset.tab === id;
      b.setAttribute("aria-selected", String(selected)); b.tabIndex = selected ? 0 : -1;
    }
    ui.list.hidden = id !== "undo"; ui.branches.hidden = id !== "undo" || !U().branches().length; ui.times.hidden = id !== "timeline"; ui.gitBox.hidden = id !== "git";
    if (id === "timeline") loadTimeline(); else if (id === "git") loadGit(); else paint();
  }
  function paint() {
    clearTimeout(paintTimer);paintTimer=0;
    if (!panel || panel.hidden || !host?.undoSteps || tab!=="undo") return;
    const s=states(),st=U().stats();
    visual?.update(s);
    let controls=panel.querySelector(".hist-personal");
    if (G.AtriumCollabLive?.active()) {
      if (!controls) {
        controls=el("div","hist-controls hist-personal");
        controls.append(btn("Undo my change","hist-btn",()=>host.historyGo(-1)),btn("Redo my change","hist-btn",()=>host.historyGo(1)));
        ui.list.before(controls);
      }
      const available=G.AtriumCollabLive.historyAvailability?.();
      controls.children[0].disabled=!available?.undo;controls.children[1].disabled=!available?.redo;
    } else controls?.remove();
    paintBranches();
    ui.foot.textContent = G.AtriumCollabLive?.active() ? "Undo and redo apply to your edits in this session."
      : plural(s.list.length-1,"step")+" · "+mb(st.bytes)+" of "+mb(st.budget)+(st.branches?" · "+plural(st.branches,"branch"):"");
  }
  function paintBranches() {
    const list = U().branches();
    ui.branches.hidden = tab !== "undo" || !list.length;
    ui.branches.querySelector("summary").textContent = "Alternate branches (" + list.length + ")";
    if(!ui.branches.open || ui.branches.hidden)return;
    const key=[!!visual,!!G.AtriumCollabLive?.active(),...list.map(b=>b.id)].join("|");
    if(ui.branchList.dataset.version===key)return;
    ui.branchList.dataset.version=key;
    ui.branchList.replaceChildren(...list.slice().reverse().map(b => {
      const tip = b.trees.at(-1), info = label(b.trees.at(-2) || b.fork, tip);
      const r = el("div", "hist-row hist-branch"); r.title = info.label + " · " + plural(b.trees.length, "step");
      const text = el("span", "hist-text");
      text.append(el("span", "hist-label", info.label), el("span", "hist-meta", plural(b.trees.length, "step") + " · " + ago(b.time)));
      r.append(el("span", "hist-dot"), text,
        ...(visual ? [btn("Preview", "hist-btn", () => visual.selectBranch(tip,info.label))] : []),
        btn("Compare", "hist-btn", () => compareTree(tip, info.label), "Compare the branch's last state with the current design"),
        ...(G.AtriumCollabLive?.active() ? [btn("Open privately…", "hist-btn", () => openPrivately(tip, info.label))]
          : [btn("Switch", "hist-btn", () => host.historyGo(0, tip), "Make the branch current")]));
      return r;
    }));
  }
  function schedule() {
    if (!panel || panel.hidden || paintTimer) return;
    paintTimer = setTimeout(paint, 60);
  }
  function toggle(show) {
    if (!panel && !build()) return false;
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    if (on && !globalThis.AtriumDock) document.body.classList.remove("hide-right");
    G.AtriumNavCommon?.setChecked?.("history-panel", on);
    if (on) { setTab(tab); (tab === "undo" ? ui.list : ui.tabs.querySelector('[aria-selected="true"]'))?.focus({preventScroll: true}); } else { visual?.show(false);preview(null); host.canvas?.()?.focus?.(); }
    return on;
  }

  // ------------------------------------------------------------------ compare / restore
  async function compare(project, labelText, active) {
    const right = await G.AtriumGit.readSpec({type:"working"}, host, undefined, active);
    await G.AtriumGit.compare({project, label:labelText}, right, {active});
  }
  async function compareTree(mark, labelText) {
    try {
      if (!G.AtriumGit) await G.AtriumLazy.need("AtriumGitPicker");
      const active = G.AtriumGit.readBound(host);
      const side = await G.AtriumGit.readSpec({type:"undo", mark, label:"Undo: " + labelText}, host, undefined, active);
      await compare(side.project, side.label, active);
    } catch (error) { say(error.message); }
  }
  async function entryProject(e, active) {
    if (!G.AtriumGit) await G.AtriumLazy.need("AtriumGitPicker");
    const spec = e.git ? {type:"commit", rev:e.rev} : {type:"snapshot", id:e.id, slot:e.snapshot?.slot};
    return (await G.AtriumGit.readSpec(spec, host, undefined, active)).project;
  }
  async function restoreCopy(e, current) {
    if (!e.git) { await G.AtriumAutosave.restore(e.id, {copy: true, current}); return; }
    const p = await entryProject(e, current);
    if (!current()) throw Error("The open project changed. Reopen Timeline.");
    if (await G.AtriumGit.openPrivateCopy(host, p, e.rev, current)) say("Opened a copy of commit " + e.rev.slice(0, 7));
  }
  // A small modal confirmation (no hover pop-ups; Escape or Cancel keeps things as they are).
  function confirmDialog(title, text, action, run) {
    const d = el("dialog", "work-dialog ui-dialog"), heading = el("h2", null, title);
    d.setAttribute("aria-label", title);
    const cancel = btn("Cancel", null, () => d.close()), ok = btn(action, "is-primary", () => { d.close(); run(); });
    const actions = el("div", "work-actions ui-dialog-actions"), body = el("div");
    body.append(el("p", null, text));
    actions.append(cancel, ok); d.append(heading, body, actions);
    markConfirmation(d, heading, body, actions, cancel, ok, "primary");
    return d;
  }
  function markConfirmation(d, heading, body, actions, cancel, confirm, variant) {
    heading.classList.add("ui-dialog-title"); body.classList.add("ui-dialog-body");
    cancel.classList.add("ui-button");
    confirm.classList.add("ui-button"); confirm.dataset.variant = variant; confirm.dataset.uiDefault = "false";
    G.AtriumShell?.adoptDialog?.(d, {title: heading, body, actions, initialFocus: cancel});
    d.addEventListener("close", () => d.remove(), {once: true});
    document.body.append(d); d.showModal(); cancel.focus();
  }
  // An alternate branch is a private whole-project state: leave the live session first, after asking.
  function openPrivately(tip, label) {
    return confirmDialog("Leave the live session?", "Opening " + label + " privately leaves the live session in this window. Others keep editing the shared project, and your copy stops receiving their changes.",
      "Leave and Open", () => { G.AtriumCollabLive?.leave(); host.historyGo(0, tip); });
  }
  // Explicit checkpoints (Timeline, and the host's shared restore). They wait for an autosave in
  // flight, pin "before shared restore" for 14 days, and fail rather than record a different state.
  const PINNED = 14 * 24 * 3600e3, LABELS = {checkpoint: "checkpoint", "before-restore": "before shared restore", restored: "shared restore"};
  async function checkpoint(reason = "checkpoint", current = () => true, A = G.AtriumAutosave, h = host) {
    if (!A?.save || A.backend?.() === "localStorage") throw Error("Checkpoints need the browser's IndexedDB recovery storage.");
    const p = h.project(), revision = h.revision?.(), path = G.AtriumHost?.projectPath;
    const ready = () => current() && p === h.project() && revision === h.revision?.() && path === G.AtriumHost?.projectPath;
    const changed = () => Error("The project changed. Review the current version and try again.");
    if (!ready()) throw changed();
    const meta = await A.save(reason, true, {label: LABELS[reason] || reason, ...(reason === "before-restore" && {keep: Date.now() + PINNED})});
    if (meta && (!ready() || meta.reason !== reason)) { await A.remove?.([meta.id]); throw changed(); }
    if (!ready()) throw changed();
    if (!meta) throw Error(/full|quota/i.test(A.stats?.().error || "") ? "Recovery storage is full. Free space in File › Recover… and try again." : A.stats?.().error || "Could not save a recovery checkpoint.");
    return meta;
  }
  // A Timeline snapshot of the open project: its file, or this window's autosave slot (a joined
  // session's copy has its own slot, autosave.js detach()).
  function ownSnapshot(meta, A = G.AtriumAutosave) {
    const path = G.AtriumHost?.projectPath;
    return !!meta && (path ? meta.path === path : !meta.path && meta.slot === A?.slot?.());
  }
  async function reviewRestore(e) {
    const live = G.AtriumCollabLive, review = await live.prepareRestore(e);
    if (!G.AtriumGit) await G.AtriumLazy.need("AtriumGitPicker");
    const title = e.title + " · " + new Date(e.ts).toLocaleString();
    if (!review.current()) throw Error("The shared project changed. Review it again.");
    await G.AtriumGit.compare({project: review.before, label: "Shared project now"}, {project: review.after, label: title}, {
      active: review.current, reviewAction: {label: "Restore for everyone…", run: () => confirmRestore(review, title)}
    });
  }
  function confirmRestore(review, title) {
    const d = el("dialog", "work-dialog ui-dialog"), heading = el("h2", null, "Restore for everyone?");
    d.setAttribute("aria-label", heading.textContent);
    const status = el("p", null, "Restore the whole project, including its settings, to " + title + " for everyone? The current shared version will be saved in your timeline first.");
    status.setAttribute("role", "status");
    const cancel = btn("Cancel", null, () => d.close()), confirm = btn("Restore for everyone", "is-primary", async () => {
      confirm.disabled = cancel.disabled = true;
      status.textContent = "Saving the current version and checking for pending edits…";
      try {
        const comparison = G.AtriumDiffView?.session();
        await review.apply(); d.close();
        if (comparison && G.AtriumDiffView.session() === comparison) G.AtriumDiffView.close();
        say("Restored the shared project. The previous version is in Timeline."); loadTimeline();
      } catch (err) {
        status.textContent = err.message; confirm.hidden = true; cancel.disabled = false; cancel.textContent = "Close"; cancel.focus();
      }
    });
    d.addEventListener("cancel", event => { if (cancel.disabled) event.preventDefault(); });
    const actions = el("div", "work-actions ui-dialog-actions"), body = el("div");
    body.append(status);
    actions.append(cancel, confirm); d.append(heading, body, actions);
    markConfirmation(d, heading, body, actions, cancel, confirm, "danger");
  }
  // Git tab: AtriumFileHistory.mount (lazy) with Compare with Previous / Working and Restore as Copy per commit.
  let gitView = null, gitProject = null, gitSession = null, gitRequest = 0;
  async function loadGit() {
    const project = host.project(), session = host.fileSession?.(), request = ++gitRequest;
    const current = () => request === gitRequest && project === host.project() && session === host.fileSession?.();
    ui.foot.textContent = "Commits that changed this file";
    if (gitView && gitProject === project && gitSession === session) { gitView.refresh(); return; }
    gitView?.destroy();
    gitView = null;
    ui.gitBox.replaceChildren(el("p", "ui-status-line", "Reading the Git history…"));
    try {
      const module = await G.AtriumLazy.need("AtriumFileHistory");
      if (!current()) return;
      ui.gitBox.replaceChildren();
      gitView = module.mount(ui.gitBox, host);
      gitProject = project; gitSession = session;
    } catch (e) {
      if (!current()) return;
      const K = G.AtriumUIKit;
      if (!K) { say(e.message); return; }
      ui.gitBox.replaceChildren(K.notice({tone:"danger", title:"Git history could not load.", text:e.message, live:true,
        actions:[K.button("Try again", {size:"sm", run:loadGit})]}));
    }
  }
  let timelineRequest = 0, timelineProject;
  async function loadTimeline() {
    const box = ui.times, A = G.AtriumAutosave, H = G.AtriumHost;
    const project = host.project(), path = H?.folderGitGrant, session = G.AtriumCollabLive?.session(), request = ++timelineRequest;
    timelineProject = project;
    const sameProject = () => project === host.project() && path === G.AtriumHost?.folderGitGrant && session === G.AtriumCollabLive?.session();
    const current = () => request === timelineRequest && sameProject();
    box.replaceChildren(el("p", "empty-state hist-empty", "Reading the local history…"));
    const entries = [];
    try {
      for (const m of await (A?.recoverySnapshots?.(A) || [])) entries.push({id: m.id, ts: m.ts, snapshot: m.snapshot, title: m.title, meta: m.meta, saved: m.saved});
    } catch (e) { entries.push({error: "Recovery storage: " + e.message}); }
    let gitNote = "";
    if (H?.gitHistory && H.folderGitGrant) {
      try { const data = await H.gitHistory(); for (const c of (Array.isArray(data?.commits) ? data.commits : []).slice(0, 100)) {
        const ts = Date.parse(c.date) || 0; entries.push({git: true, path, rev: c.revision, ts, title: String(c.subject || "(no subject)").slice(0, 80), meta: "Git · " + String(c.revision).slice(0, 7) + (c.author ? " · " + c.author : "")});
      } } catch (e) { gitNote = "Git: " + e.message; }
    } else gitNote = "Git commits appear here for a saved project in the desktop app.";
    if (!current()) return;
    entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    timeline = entries;
    const nodes = entries.map(e => {
      if (e.error) return el("p", "hist-note", e.error);
      const r = el("div", "hist-row hist-time" + (e.git ? " is-git" : e.saved ? " is-saved" : ""));
      const text = el("span", "hist-text");
      text.append(el("span", "hist-label", e.title), el("span", "hist-meta", (e.ts ? ago(e.ts) : "") + (e.meta ? " · " + e.meta.replace(/^[^·]*· /, "") : "")));
      const run = (fn, what) => async () => { try { if (!current()) throw Error("The project changed. Reopen Timeline."); await fn(); } catch (err) { say(what + ": " + err.message); } };
      r.append(el("span", "hist-dot"), text,
        btn("Compare", "hist-btn", run(async () => compare(await entryProject(e, current), (e.git ? e.rev.slice(0, 7) + " · " : "") + e.title + " · " + ago(e.ts), current), "Compare"), "Compare with current (Review Changes)"),
        btn("Restore copy", "hist-btn", run(() => restoreCopy(e, sameProject), "Restore"), session ? "Leave the session and open a private copy of this version" : "Open this version as a private copy"));
      if (session?.mode === "start" && (e.git || ownSnapshot(e.snapshot))) {
        r.append(btn("Review restore…", "hist-btn", run(() => reviewRestore(e), "Restore"), "Compare this version before restoring it for everyone"));
      }
      return r;
    });
    if (!entries.length) nodes.push(el("p", "empty-state hist-empty", "No snapshots yet. Autosave keeps one about every minute while you edit."));
    if (A?.save && A.backend?.() !== "localStorage") {
      const controls = el("div", "hist-controls");
      controls.append(btn("Save checkpoint", "hist-btn", async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await checkpoint("checkpoint", sameProject); if (current()) await loadTimeline(); }
        catch (err) { say(err.message); button.disabled = false; }
      }));
      nodes.unshift(controls);
    }
    if (gitNote) nodes.push(el("p", "hist-note", gitNote));
    box.replaceChildren(...nodes);
    ui.foot.textContent = plural(entries.filter(e => !e.git && !e.error).length, "snapshot") + (entries.some(e => e.git) ? " · " + plural(entries.filter(e => e.git).length, "commit") : "");
  }

  // ------------------------------------------------------------------ preferences
  function prefsPage(P) {
    P.registerPage?.({id: "history", title: "History", order: 8, keywords: "undo redo history memory budget steps branches", render(c, api) {
      const g = api.group(c, "Undo history");
      const n = api.el("div", "prf-row"); n.dataset.search = "undo memory budget history size megabytes";
      const l = api.el("label", "prf-label", "Undo memory budget"); l.htmlFor = "prf-undo-mb";
      const input = api.el("input", "ui-field"); input.type = "number"; input.id = "prf-undo-mb"; input.min = "8"; input.max = "2048"; input.step = "8";
      input.value = String(G.AtriumPref?.get?.("history.undoBudgetMB", 64) ?? 64);
      input.onchange = () => { const v = Math.min(2048, Math.max(8, Math.round(+input.value) || 64)); P.set("history.undoBudgetMB", v); input.value = String(v); };
      const ctl = api.el("span", "prf-control"); ctl.append(input, api.el("span", "prf-unit", "MB"));
      const help = api.el("small", "prf-help", "Oldest steps drop first. Default 64 MB.");
      help.id = input.id + "-help"; input.setAttribute("aria-describedby", help.id);
      n.append(l, ctl, help);
      g.append(n);
    }});
  }

  function attach(h) {
    host = h;
    h.registerAction?.("history-panel", () => toggle());
    h.addRenderer?.(render);
    h.on?.("change", () => {
      if (panel && !panel.hidden && tab === "timeline" && timelineProject !== h.project()) loadTimeline();
      else if (panel && !panel.hidden && tab === "git" && (gitProject !== h.project() || gitSession !== h.fileSession?.())) loadGit();
      else schedule();
    });
    h.on?.("document", schedule);
    U()?.on?.(schedule);
    if (G.AtriumPrefs?.registerPage) prefsPage(G.AtriumPrefs); else G.AtriumLazy?.need?.("AtriumPrefs")?.then?.(prefsPage, () => {});
  }
  if (hasDOM()) G.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({diff, summarize, label, attach, toggle, preview, isOpen: () => !!panel && !panel.hidden, timeline: () => timeline, loadTimeline, checkpoint, ownSnapshot, openPrivately,
    openTimeline() { tab = "timeline"; toggle(true); }, sessionChanged() { if (panel && !panel.hidden) setTab(tab); }});
})();
