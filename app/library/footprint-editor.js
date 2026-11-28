"use strict";
if (!globalThis.AtriumResolvedLand && typeof require === "function") require("../pcb/pcb-appearance.js");
// Graphical footprint editor. It opens as a large modal work surface over the design
// rather than as a document tab: a footprint is a library def, not a project document,
// so it keeps its own undo history and is committed to the project as ONE undo step
// (with "Update parts" applied) when saved, and Cancel leaves the project untouched.
// The canvas is the board renderer itself (AtriumCanvas), so pads, silk and text look
// exactly as they will on a placed part.
//
// Headless helpers (no DOM):
//   AtriumFootprintEditor.padArray(template, spec) -> pads  (linear, circular, grid)
//   AtriumFootprintEditor.incrementNumber("A9") -> "A10";  nextNumber(pads)
//   AtriumFootprintEditor.renumber(pads, order, {start, step}) -> pads (in place)
//   AtriumFootprintEditor.layerShape(key) -> {style, layer, width} for silk/courtyard/assembly/body/copper
globalThis.AtriumFootprintEditor = (() => {
  const A = globalThis.Atrium;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const clone = v => JSON.parse(JSON.stringify(v));

  // ------------------------------------------------------------------ numbering
  function incrementNumber(n, step = 1) {
    const s = String(n ?? "");
    const m = /^(.*?)(\d+)$/.exec(s);
    if (m) { const v = Math.max(0, +m[2] + step); return m[1] + String(v).padStart(m[2].length > 1 && m[2][0] === "0" ? m[2].length : 0, "0"); }
    if (/^[A-Z]$/i.test(s)) return String.fromCharCode(s.charCodeAt(0) + step);
    return s ? s + "1" : "1";
  }
  function nextNumber(pads) {
    const nums = pads.filter(p => !p.thermalVia).map(p => String(p.number));
    if (!nums.length) return "1";
    const ints = nums.filter(n => /^\d+$/.test(n)).map(Number);
    if (ints.length === nums.length) return String(Math.max(...ints) + 1);
    let n = incrementNumber(nums.at(-1));
    const used = new Set(nums);
    while (used.has(n)) n = incrementNumber(n);
    return n;
  }
  function renumber(pads, order, o = {}) {
    let n = String(o.start ?? "1");
    for (const i of order) { if (pads[i]) pads[i].number = n; n = incrementNumber(n, o.step ?? 1); }
    return pads;
  }
  const ROWS = "ABCDEFGHJKLMNPRTUVWY";
  const rowName = i => { let s = "", n = i; do { s = ROWS[n % ROWS.length] + s; n = Math.floor(n / ROWS.length) - 1; } while (n >= 0); return s; };
  // Pad arrays. Every pad copies the template (shape, size, drill, stack, expansions).
  //   linear:   {count, dx, dy}
  //   circular: {count, radius, startAngle, sweep (360 = full circle), rotate, cx, cy}
  //   grid:     {rows, cols, pitchX, pitchY, order: "rows"|"columns"|"snake"|"alpha"}
  // Numbers start at spec.start and step by spec.step; "alpha" names grid pads A1, A2…, B1…
  function padArray(template, spec) {
    const t = {...clone(template), number: undefined};
    delete t.number;
    const out = [], x0 = spec.x ?? template.x ?? 0, y0 = spec.y ?? template.y ?? 0;
    let n = String(spec.start ?? "1");
    const push = (x, y, extra = {}) => { out.push({...clone(t), number: n, x: r6(x), y: r6(y), ...extra}); n = incrementNumber(n, spec.step ?? 1); };
    const type = spec.type || "linear";
    if (type === "linear") {
      const count = Math.max(1, Math.min(1024, spec.count | 0));
      for (let i = 0; i < count; i++) push(x0 + i * (spec.dx ?? 0), y0 + i * (spec.dy ?? 0));
    } else if (type === "circular") {
      const count = Math.max(1, Math.min(1024, spec.count | 0)), sweep = spec.sweep ?? 360, R = spec.radius ?? 2;
      const cx = spec.cx ?? x0 - R, cy = spec.cy ?? y0, start = spec.startAngle ?? 180;
      const stepA = Math.abs(sweep) >= 360 ? sweep / count : sweep / Math.max(1, count - 1);
      for (let i = 0; i < count; i++) {
        const a = start + i * stepA, rad = a * Math.PI / 180;
        push(cx + R * Math.cos(rad), cy + R * Math.sin(rad), spec.rotate === false ? {} : {angle: r6(((t.angle || 0) + a - start) % 360)});
      }
    } else if (type === "grid") {
      const rows = Math.max(1, Math.min(128, spec.rows | 0)), cols = Math.max(1, Math.min(128, spec.cols | 0));
      const px = spec.pitchX ?? 1, py = spec.pitchY ?? px, order = spec.order || "rows";
      for (let a = 0; a < (order === "columns" ? cols : rows); a++) for (let b0 = 0; b0 < (order === "columns" ? rows : cols); b0++) {
        const b = order === "snake" && a % 2 ? (cols - 1 - b0) : b0;
        const r = order === "columns" ? b : a, c = order === "columns" ? a : b;
        if (order === "alpha") { n = rowName(r) + (c + 1); }
        push(x0 + c * px, y0 + r * py);
      }
    } else throw Error("Choose a linear, circular or grid array.");
    return out;
  }
  const LAYERS = {
    silk: {label: "Silk", title: "Top overlay (silkscreen)", style: "silk", layer: undefined, width: .12},
    courtyard: {label: "Courtyard", title: "Courtyard (Mechanical 15)", style: "courtyard", layer: "Mechanical 15", width: .05},
    assembly: {label: "Assembly", title: "Assembly outline (Mechanical 13)", style: "assembly", layer: "Mechanical 13", width: .1},
    body: {label: "3D body", title: "Component body outline used for the 3D view and STEP", style: "package", layer: undefined, width: .1},
    copper: {label: "Copper", title: "Top copper", style: undefined, layer: "Top", width: .2}
  };
  function layerShape(key) { const l = LAYERS[key] || LAYERS.silk, o = {width: l.width}; if (l.style) o.style = l.style; if (l.layer) o.layer = l.layer; return o; }
  function layerKey(s) {
    if (/court|crtyd/i.test(s.layer || "") || /^mechanical\s*15$/i.test(s.layer || "") || s.style === "courtyard") return "courtyard";
    if (s.style === "package") return "body";
    if (/^mechanical\s*13$/i.test(s.layer || "") || s.style === "assembly" || /assembly|fab/i.test(s.layer || "")) return "assembly";
    if (s.style === "silk" || /silk|overlay/i.test(s.layer || "")) return "silk";
    if (/^(top|bottom|inner)/i.test(s.layer || "")) return "copper";
    return "silk";
  }

  // ------------------------------------------------------------------ geometry helpers
  function padContains(p, q, tol = 0) {
    const land = AtriumPCBAppearance.padGeometry(p, "Top");
    return !!land && AtriumResolvedLand.distance(land, q, [land.x, land.y]) <= tol;
  }
  function shapeDistance(s, q) {
    if (s.kind === "circle") return Math.abs(Math.hypot(q[0] - s.x, q[1] - s.y) - s.r);
    if (s.kind === "text") { const b = shapeBox(s); return q[0] >= b[0] - .1 && q[0] <= b[2] + .1 && q[1] >= b[1] - .1 && q[1] <= b[3] + .1 ? 0 : Infinity; }
    const pts = s.closed ? [...s.points, s.points[0]] : s.points;
    if (pts.length === 1) return Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, A.nearSegment(q, pts[i - 1], pts[i]));
    return d;
  }
  function shapeBox(s) {
    if (s.kind === "circle") return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r];
    if (s.kind === "text") {
      // The board's own text layout, so selection, hit testing and placement match what is drawn.
      try { const b = globalThis.AtriumPCBText?.hitBox(s); if (b?.length === 4 && b.every(Number.isFinite)) return b; } catch {}
      const sz = s.size || .8, w = String(s.text || "").length * sz * .62, x0 = s.align === "center" ? s.x - w / 2 : s.align === "right" ? s.x - w : s.x; return [x0, s.y - sz, x0 + w, s.y];
    }
    return A.bounds(s.points);
  }
  function moveShape(s, dx, dy) {
    if (s.points) {
      const move = ([x,y]) => [r6(x + dx), r6(y + dy)];
      s.points = s.points.map(move);
      if (s.arc?.kind === "arc") s.arc = A.transformArc(s.arc, move);
    }
    else { s.x = r6(s.x + dx); s.y = r6(s.y + dy); }
  }

  // ------------------------------------------------------------------ editor
  function draftFrom(def, library = []) {
    if (def) return clone(def);
    const name = (globalThis.AtriumLibrary?.uniqueName ? AtriumLibrary.uniqueName({library}, "New footprint") : "New footprint");
    return {id: A.id(), name, prefix: "U", value: "", category: "Footprints", footprint: {name, pads: [], shapes: []}};
  }

  function open(ctx = {}) {
    const L = AtriumLibrary, ui = L.ui, el = ui.el;
    const draft = draftFrom(ctx.def, ctx.library);
    // Edit on a part whose editor tab is open shows that tab, and builds no second editor.
    const tabId = "footprint-editor:" + draft.id, openTab = ui.showOpenTab(tabId, !!ctx.asTab);
    if (openTab) return openTab;
    const isNew = !ctx.def;
    if (!draft.footprint) draft.footprint = {name: draft.name, pads: [], shapes: []};
    const fp = () => draft.footprint;
    const dlg = ui.editorSurface("Footprint Editor", "fe-dialog", {tabId, icon: "chip", hostTab: !!ctx.asTab});
    const title = dlg.heading.querySelector("h2");
    const shortcutText = text => AtriumNavCommon.shortcutParts(text, {enter:"Enter", escape:"Escape", shift:"Shift"});
    const endRenumber = " Press {enter} or {escape} to finish.";
    // ---------------- state
    let tool = "select", grid = .05, selection = {pads: new Set(), shapes: new Set()}, hover = null, pointer = [0, 0], screenPointer = null;
    let drawing = null, drag = null, measure = null, renumberState = null, arraySpec = null, guideSession = null, guideResult = null;
    let drawLayer = "silk", issues = [], showIssues = true, saved = JSON.stringify(draft);
    const hidden = new Set();
    let template = {number: "1", x: 0, y: 0, w: 1.5, h: .6, shape: "roundrect", angle: 0, drill: 0};
    const undo = [], redo = [];
    // Undo snapshots keep embedded STEP text out: each distinct model text is stored once in
    // a side table and referenced by index, so a multi-MB model is never copied per step.
    const stepTexts = [];
    let stepTranslation = null, stepRequest = 0;
    const stepRef = v => { let k = stepTexts.indexOf(v); if (k < 0) { stepTexts.push(v); k = stepTexts.length - 1; } return "\u0000step:" + k; };
    function snapshot() { return JSON.stringify(draft, (k, v) => k === "stepText" && typeof v === "string" ? stepRef(v) : v); }
    saved = snapshot(); // as every later snapshot spells STEP text, so an untouched model is clean
    const thaw = text => JSON.parse(text, (k, v) => k === "stepText" && typeof v === "string" && v.startsWith("\u0000step:") ? stepTexts[+v.slice(6)] : v);
    function change(fn, keepSelection = true) {
      const before = snapshot();
      fn();
      if (snapshot() !== before) { undo.push(before); if (undo.length > 200) undo.shift(); redo.length = 0; }
      if (!keepSelection) clearSelection();
      refresh();
    }
    function restore(state) { const d = thaw(state); for (const k of Object.keys(draft)) delete draft[k]; Object.assign(draft, d); clearSelection(); refresh(); }
    function doUndo(back = true) { const from = back ? undo : redo, to = back ? redo : undo; if (!from.length) return; to.push(snapshot()); restore(from.pop()); }
    function clearSelection() { selection = {pads: new Set(), shapes: new Set()}; hover = null; }
    const selectedPads = () => [...selection.pads].map(i => fp().pads[i]).filter(Boolean);
    const selectedShapes = () => [...selection.shapes].map(i => fp().shapes[i]).filter(Boolean);

    // ---------------- layout
    const bar = el("div", null, "fe-toolbar"); bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Footprint tools");
    const TOOLS = [["select", "Select", "V"], ["pad", "Pad", "P"], ["array", "Array", "A"], ["line", "Line", "L"], ["rect", "Rect", "R"], ["circle", "Circle", "C"], ["text", "Text", "T"], ["renumber", "Renumber", "N"], ["measure", "Measure", "M"]];
    const toolButtons = new Map();
    for (const [id, label, key] of TOOLS) {
      const b = ui.editorTool(label, key, () => setTool(id)); b.dataset.tool = id;
      toolButtons.set(id, b); bar.append(b);
    }
    bar.append(el("span", null, "fe-sep"));
    const layerSel = el("select"); layerSel.setAttribute("aria-label", "Drawing layer"); layerSel.title = "Layer for lines, rectangles, circles and text";
    for (const [k, l] of Object.entries(LAYERS)) layerSel.add(new Option(l.label, k));
    layerSel.onchange = () => { drawLayer = layerSel.value; };
    const gridSel = el("select"); gridSel.setAttribute("aria-label", "Grid");
    ui.shortcut(gridSel, "Cycle the snap grid", "G", " on the canvas");
    const GRIDS = [.01, .025, .05, .1, .125, .25, .5, .635, 1, 1.27, 2.54];
    for (const g of GRIDS) gridSel.add(new Option(g + " mm", g));
    gridSel.value = grid; gridSel.onchange = () => { grid = +gridSel.value; };
    bar.append(ui.label("Layer", layerSel, "fe-inline"), ui.label("Grid", gridSel, "fe-inline"));
    const layersMenu = el("details", null, "fe-layers"); layersMenu.append(el("summary", "Show", "ui-disclosure-marker"));
    for (const [layer, label] of [["Top", "Top copper"], ["Bottom", "Bottom copper"], ["Silk", "Silk"], ["Mechanical 13", "Assembly"], ["Mechanical 15", "Courtyard"], ["Mechanical", "3D body"]]) {
      const c = el("input", null, "ui-checkbox"); c.type = "checkbox"; c.checked = true; c.onchange = () => { if (c.checked) hidden.delete(layer); else hidden.add(layer); stage.render(); };
      const lab = el("label", null, "ui-checkbox-row"); lab.append(c, el("span", label)); layersMenu.append(lab);
    }
    bar.append(layersMenu);
    const canvas = el("canvas", null, "fe-canvas"); canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Footprint canvas");
    const props = el("div", null, "fe-props"), checks = el("div", null, "fe-checks"), side = el("aside", null, "fe-side");
    side.setAttribute("aria-label", "Footprint properties and checks");
    side.append(props, checks);
    const statusLine = el("div", null, "fe-status"), coords = el("span", null, "fe-coords"), hint = el("span", null, "fe-hint");
    statusLine.append(coords, hint);
    const centre = el("div", null, "fe-centre"); centre.append(canvas, statusLine);
    const body = el("div", null, "fe-body"); body.append(bar, centre, side);
    const footer = el("div", null, "lib-actions");
    const saveButton = ui.button("Save", () => save(false), "lib-primary"), placeButton = ui.button("Save and place", () => save(true));
    ui.shortcut(saveButton, "Save", "Mod+S");
    footer.append(ui.editorKeys("Rotate"), ui.button("Cancel", () => tryClose()), placeButton, saveButton);
    dlg.append(body, footer);

    const stage = ui.stage(canvas, {kind: "pcb", def: () => draft, hidden: () => hidden, overlay: overlay,
      input:{tool:()=>tool,undo:doUndo,precision:{
        point:p=>drag?.aim || snap(p).at,
        grips(p, consider) {
          for (const i of selection.pads) {
            const pad=fp().pads[i];
            if (pad) consider([pad.x,pad.y],{type:"pad",index:i,id:"pad-"+i});
          }
          for (const i of selection.shapes) {
            const s=fp().shapes[i];
            if (s && !hiddenShape(s)) for (const at of s.points || [[s.x,s.y]]) consider(at,{type:"shape",index:i,id:"shape-"+i});
          }
        }
      },hit(q){
        const h=hit(q);if(!h)return null;
        return {...h,id:h.type+"-"+h.index,box:h.type==="pad"?padRectOf(fp().pads[h.index]):shapeBox(fp().shapes[h.index])};
      },selected:h=>!!selection[h.type==="pad"?"pads":"shapes"]?.has(h.index),inspect(h){clearSelection();selection[h.type==="pad"?"pads":"shapes"].add(h.index);renderProps();stage.render();}},
      options: () => ({guides: guideResult, measure: measure && measure.b ? {a: measure.a, b: measure.b, text: measureText()} : null})});

    // ---------------- hit testing and snapping
    const tol = () => 6 / stage.scale();
    function hit(q) {
      const pads = fp().pads;
      for (let i = pads.length - 1; i >= 0; i--) if (padContains(pads[i], q, tol() * .5)) return {type: "pad", index: i};
      let best = null, bd = tol();
      fp().shapes.forEach((s, i) => { if (hiddenShape(s)) return; const d = shapeDistance(s, q); if (d <= bd) { bd = d; best = {type: "shape", index: i}; } });
      return best;
    }
    function hiddenShape(s) { const k = layerKey(s); return k === "silk" ? hidden.has("Silk") : k === "courtyard" ? hidden.has("Mechanical 15") : k === "assembly" ? hidden.has("Mechanical 13") : k === "body" ? hidden.has("Mechanical") : hidden.has(s.layer || "Top"); }
    // Grid snap, then hotspots (pad centres and edges, shape vertices) within 8 px.
    const freeTouch = () => globalThis.AtriumCanvasInput?.ignoreSnap() || globalThis.AtriumTouchPrecision?.free(canvas);
    function snap(q, o = {}) {
      if (freeTouch()) return {at:q.map(r6), snapped:false};
      let best = null, bd = 8 / stage.scale();
      const consider = p => { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < bd) { bd = d; best = p; } };
      if (o.objects !== false) {
        fp().pads.forEach((p, i) => { if (o.exclude?.has(i)) return; consider([p.x, p.y]); if (tool === "pad" || tool === "array") return; const b = padRectOf(p); for (const c of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [p.x, b[1]], [p.x, b[3]], [b[0], p.y], [b[2], p.y]]) consider(c); });
        for (const s of fp().shapes) if (s.points) s.points.forEach(consider); else consider([s.x, s.y]);
      }
      if (best) return {at: best.map(r6), snapped: true};
      return {at: [A.snap(q[0], grid), A.snap(q[1], grid)].map(r6), snapped: false};
    }
    const padRectOf = p => { const a = Math.abs(Math.round((p.angle || 0) / 90)) % 2 === 1; const w = a ? p.h : p.w, h = a ? p.w : p.h; return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2]; };
    function measureText() {
      const dx = measure.b[0] - measure.a[0], dy = measure.b[1] - measure.a[1];
      return Math.hypot(dx, dy).toFixed(3) + " mm  (Δx " + dx.toFixed(3) + ", Δy " + dy.toFixed(3) + ")";
    }

    // ---------------- overlay (screen space)
    function overlay(c, s) {
      const S = s.toScreen;
      c.lineWidth = 1.5;
      // Selection.
      c.strokeStyle = "#5ee8ff"; c.setLineDash([]);
      for (const p of selectedPads()) outlinePad(c, p, S, 3);
      for (const sh of selectedShapes()) {
        const b = shapeBox(sh); if (!b) continue;
        const a = S([b[0], b[1]]), z = S([b[2], b[3]]);
        c.strokeRect(a[0] - 3, a[1] - 3, z[0] - a[0] + 6, z[1] - a[1] + 6);
        if (sh.points) { c.fillStyle = "#5ee8ff"; for (const p of sh.points) { const q = S(p); c.fillRect(q[0] - 2.5, q[1] - 2.5, 5, 5); } }
      }
      // Hover.
      if (hover && tool === "select" || hover && tool === "renumber") {
        c.strokeStyle = "rgba(255,255,255,.55)";
        const hp = hover.type === "pad" ? fp().pads[hover.index] : null;
        if (hp) outlinePad(c, hp, S, 2); else if (hover.type === "pad") hover = null;
      }
      // DRC markers.
      if (showIssues) for (const x of issues) {
        if (x.level === "info") continue;
        c.strokeStyle = x.level === "error" ? "#ff5b5b" : "#ffbf3c";
        for (const i of x.pads || []) { const p = fp().pads[i]; if (p) { c.setLineDash([3, 2]); outlinePad(c, p, S, 5); c.setLineDash([]); } }
      }
      // Renumber sequence.
      if (renumberState) {
        c.font = "600 11px " + ui.mono; c.textAlign = "center"; c.textBaseline = "middle";
        renumberState.order.forEach((i, k) => { const p = fp().pads[i]; if (!p) return; const q = S([p.x, p.y]); c.fillStyle = "#18c58f"; c.beginPath(); c.arc(q[0], q[1] - 14, 8, 0, Math.PI * 2); c.fill(); c.fillStyle = "#04140f"; c.fillText(String(k + 1), q[0], q[1] - 14); });
      }
      // Ghosts for pad placement and arrays.
      const ghosts = tool === "pad" && screenPointer ? [{...template, ...snap(pointer).at.reduce((o, v, i) => (o[i ? "y" : "x"] = v, o), {})}] : tool === "array" && arraySpec ? previewArray() : [];
      c.strokeStyle = "#ffe08a"; c.setLineDash([4, 3]);
      for (const p of ghosts.slice(0, 600)) outlinePad(c, p, S, 0);
      c.setLineDash([]);
      if (tool === "array" && arraySpec) {
        c.font = "10px " + ui.mono; c.fillStyle = "#ffe08a"; c.textAlign = "center";
        for (const p of ghosts.slice(0, 200)) { const q = S([p.x, p.y]); c.fillText(p.number, q[0], q[1] + 3); }
      }
      // In-progress drawing.
      if (drawing) {
        const pts = [...drawing.points, snap(pointer).at];
        c.strokeStyle = "#ffe08a"; c.setLineDash([5, 3]); c.beginPath();
        if (drawing.kind === "rect" && pts.length >= 2) { const a = S(pts[0]), b = S(pts.at(-1)); c.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
        else if (drawing.kind === "circle" && pts.length >= 2) { const a = S(pts[0]), b = S(pts.at(-1)); c.arc(a[0], a[1], Math.hypot(b[0] - a[0], b[1] - a[1]), 0, Math.PI * 2); }
        else pts.forEach((p, i) => { const q = S(p); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
        c.stroke(); c.setLineDash([]);
      }
      if (drag?.marquee) {
        const a = S(drag.from), b = S(drag.to);
        c.fillStyle = "rgba(94,232,255,.08)"; c.strokeStyle = "#5ee8ff"; c.setLineDash(drag.to[0] < drag.from[0] ? [4, 3] : []);
        c.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); c.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); c.setLineDash([]);
      }
      if (measure && !measure.b && screenPointer) { const a = S(measure.a); c.strokeStyle = "#b3fff0"; c.beginPath(); c.moveTo(a[0], a[1]); const b = S(snap(pointer).at); c.lineTo(b[0], b[1]); c.stroke(); }
      // Snap cursor.
      if (screenPointer && tool !== "select") { const q = S(snap(pointer).at); c.strokeStyle = "#ffffff"; c.lineWidth = 1; c.beginPath(); c.moveTo(q[0] - 6, q[1]); c.lineTo(q[0] + 6, q[1]); c.moveTo(q[0], q[1] - 6); c.lineTo(q[0], q[1] + 6); c.stroke(); }
    }
    function outlinePad(c, p, S, grow) {
      const a = (p.angle || 0) * Math.PI / 180, w = p.w / 2, h = p.h / 2, sc = stage.scale(), g = grow / sc;
      const corners = [[-w - g, -h - g], [w + g, -h - g], [w + g, h + g], [-w - g, h + g]].map(([x, y]) => S([p.x + x * Math.cos(a) - y * Math.sin(a), p.y + x * Math.sin(a) + y * Math.cos(a)]));
      c.beginPath(); corners.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath(); c.stroke();
    }

    // ---------------- arrays
    function previewArray() {
      const t = selectedPads()[0] || template;
      try { return padArray(t, {...arraySpec, x: arraySpec.x ?? t.x, y: arraySpec.y ?? t.y}); } catch { return []; }
    }

    // ---------------- tools and pointer
    function setTool(id) {
      globalThis.AtriumCamera.stopWheel(stage.view);
      if (drawing && drawing.points.length > 1 && drawing.kind === "line") finishDrawing();
      tool = id; drawing = null; measure = id === "measure" ? null : measure; if (id !== "measure") measure = null;
      if (id === "renumber") renumberState = {order: [], start: renumberState?.start || "1"};
      else renumberState = null;
      if (id === "array") arraySpec = arraySpec || {type: "linear", count: 8, dx: 0, dy: 1.27, start: nextNumber(fp().pads), step: 1, rows: 4, cols: 4, pitchX: 1, pitchY: 1, order: "rows", radius: 2, startAngle: 180, sweep: 360, rotate: true};
      if (id === "pad") template.number = nextNumber(fp().pads);
      for (const [k, b] of toolButtons) b.setAttribute("aria-pressed", String(k === id));
      canvas.style.cursor = id === "select" ? "default" : "crosshair";
      const lead = {pad:"Click to place pad " + template.number, renumber:"Click pads in order to number them from " + (renumberState?.start || "1")}[id] || "";
      const help = {select: "Click to select, drag to move (smart guides snap to pad centres), drag empty space to box-select.",
        pad: ". Edit the template on the right. Press {escape} to stop placing pads.",
        array: "Set the array on the right, then choose Create array or press {enter}. The selected pad is the template.",
        line: "Click points. Double-click or press {enter} to finish. {shift} keeps 45°.", rect: "Click two corners.", circle: "Click the centre, then the radius.",
        text: "Click to place text. .Designator and .Comment show the part's values.",
        renumber: "." + endRenumber,
        measure: "Click two points to measure."}[id] || "";
      hint.replaceChildren(lead, ...shortcutText(help));
      renderProps(); stage.render();
    }
    function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    canvas.addEventListener("pointermove", e => {
      screenPointer = local(e); pointer = stage.toLocal(screenPointer);
      const at = snap(pointer).at;
      coords.textContent = "X " + at[0].toFixed(3) + "  Y " + at[1].toFixed(3) + " mm";
      if (drag?.move) moveDrag(e);
      else if (drag?.marquee) drag.to = pointer;
      else hover = hit(pointer);
      stage.render();
    });
    canvas.addEventListener("pointerleave", () => { screenPointer = null; hover = null; stage.render(); });
    canvas.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      canvas.focus();
      screenPointer = local(e); pointer = stage.toLocal(screenPointer);
      const at = snap(pointer).at;
      if (tool === "select") {
        const h = hit(pointer);
        if (h) {
          const key = h.type === "pad" ? "pads" : "shapes";
          const copy=e.pointerType==="touch" && e.ctrlKey;
          if (e.shiftKey || e.metaKey || e.ctrlKey && !copy) { const set = selection[key]; if (set.has(h.index)) set.delete(h.index); else set.add(h.index); }
          else if (!selection[key].has(h.index)) { clearSelection(); selection[key].add(h.index); }
          beginMove(h); drag.copy=copy;
          if(!globalThis.AtriumCanvasInput?.isReplay(e))canvas.setPointerCapture?.(e.pointerId);
        } else {
          if (!e.shiftKey) clearSelection();
          drag = {marquee: true, from: pointer, to: pointer, add: e.shiftKey};
          if(!globalThis.AtriumCanvasInput?.isReplay(e))canvas.setPointerCapture?.(e.pointerId);
        }
        renderProps(); stage.render(); return;
      }
      placeAt(at, e);
    });
    function placeAt(at, e) {
      if (tool === "pad") { change(() => { fp().pads.push({...clone(template), nativeId:A.id(), nativeIdOwner:draft.id, x: at[0], y: at[1]}); }); template.number = incrementNumber(template.number); selection.pads = new Set([fp().pads.length - 1]); setTool("pad"); return; }
      if (tool === "renumber") {
        const h = hit(pointer); if (h?.type !== "pad") return;
        if (renumberState.order.includes(h.index)) return;
        renumberState.order.push(h.index);
        const num = renumberState.order.slice(0, -1).reduce(n => incrementNumber(n), renumberState.start);
        change(() => { fp().pads[h.index].number = num; });
        hint.replaceChildren("Pad set to " + num + ". Next: " + incrementNumber(num) + ".", ...shortcutText(endRenumber));
        return;
      }
      if (tool === "measure") { if (!measure || measure.b) measure = {a: at}; else measure.b = at; stage.render(); return; }
      if (tool === "text") {
        change(() => { fp().shapes.push({kind: "text", text: ".Designator", x: at[0], y: at[1], size: .8, align: "center", ...layerShape(drawLayer === "assembly" ? "assembly" : drawLayer), ...(drawLayer === "silk" ? {layer: "Silk"} : {})}); });
        selection = {pads: new Set(), shapes: new Set([fp().shapes.length - 1])}; setTool("select"); return;
      }
      if (["line", "rect", "circle"].includes(tool)) {
        const q = e.shiftKey && drawing?.points.length ? constrain(drawing.points.at(-1), at) : at;
        if (!drawing) { drawing = {kind: tool, points: [q]}; stage.render(); return; }
        if (e.detail > 1 && tool === "line") { finishDrawing(); return; }
        drawing.points.push(q);
        if (tool !== "line") finishDrawing();
        stage.render();
      }
    }
    canvas.addEventListener("dblclick", () => { if (drawing?.kind === "line") finishDrawing(); });
    canvas.addEventListener("pointercancel", () => {
      const before=drag?.moved && drag.before;drag=null;guideSession=null;guideResult=null;
      if(before)restore(before);else stage.render();
    });
    canvas.addEventListener("pointerup", () => {
      if (drag?.move) { endMove(); }
      else if (drag?.marquee) {
        const b = [Math.min(drag.from[0], drag.to[0]), Math.min(drag.from[1], drag.to[1]), Math.max(drag.from[0], drag.to[0]), Math.max(drag.from[1], drag.to[1])];
        const crossing = drag.to[0] < drag.from[0];
        const within = r => crossing ? r[0] <= b[2] && r[2] >= b[0] && r[1] <= b[3] && r[3] >= b[1] : r[0] >= b[0] && r[2] <= b[2] && r[1] >= b[1] && r[3] <= b[3];
        if (Math.hypot(b[2] - b[0], b[3] - b[1]) * stage.scale() > 3) {
          fp().pads.forEach((p, i) => { if (within(padRectOf(p))) selection.pads.add(i); });
          fp().shapes.forEach((s, i) => { const r = shapeBox(s); if (r && !hiddenShape(s) && within(r)) selection.shapes.add(i); });
        }
        drag = null; renderProps();
      }
      stage.render();
    });
    function constrain(a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1], ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(dx, dy);
      return [r6(A.snap(a[0] + Math.cos(ang) * len, grid)), r6(A.snap(a[1] + Math.sin(ang) * len, grid))];
    }
    function finishDrawing() {
      const d = drawing; drawing = null;
      if (!d) return;
      const props = layerShape(drawLayer);
      change(() => {
        if (d.kind === "line" && d.points.length >= 2) fp().shapes.push({kind: "path", points: d.points, ...props});
        if (d.kind === "rect" && d.points.length >= 2) { const [a, b] = d.points; if (a[0] !== b[0] && a[1] !== b[1]) fp().shapes.push({kind: "path", closed: true, points: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], ...props, ...(drawLayer === "body" ? {fill: true} : {})}); }
        if (d.kind === "circle" && d.points.length >= 2) { const [a, b] = d.points, r = r6(Math.hypot(b[0] - a[0], b[1] - a[1])); if (r > 0) fp().shapes.push({kind: "circle", x: a[0], y: a[1], r, ...props}); }
      });
      stage.render();
    }
    // Moving: grid snap, plus smart guides on pad centres (AtriumGuides) when available.
    function beginMove(h) {
      const pads = selectedPads(), anchor = h.type === "pad" ? [fp().pads[h.index].x, fp().pads[h.index].y] : (() => { const s = fp().shapes[h.index]; return s.points ? s.points[0] : [s.x, s.y]; })();
      drag = {move: true, start: pointer, anchor, before: snapshot(), moved: false};
      guideSession = null;
      if (globalThis.AtriumGuides && pads.length) {
        const items = fp().pads.map((p, i) => ({id: "p" + i, kind: "pad", x: p.x, y: p.y, w: p.w, h: p.h, angle: p.angle || 0}));
        try { guideSession = AtriumGuides.begin({kind: "pcb", items, outline: []}, new Map(), new Set([...selection.pads].map(i => "p" + i)), {}); } catch { guideSession = null; }
      }
      drag.origin = {pads: [...selection.pads].map(i => [i, fp().pads[i].x, fp().pads[i].y]), shapes: [...selection.shapes].map(i => [i, clone(fp().shapes[i])])};
    }
    function moveDrag(e) {
      const raw = [pointer[0] - drag.start[0], pointer[1] - drag.start[1]];
      let delta;
      if (freeTouch()) { delta = raw; guideResult = null; }
      else if (guideSession && !e.altKey) {
        const r = guideSession.snap(raw, {scale: stage.scale(), grid, anchor: drag.anchor});
        delta = r.delta; guideResult = r;
      } else { delta = [A.snap(drag.anchor[0] + raw[0], grid) - drag.anchor[0], A.snap(drag.anchor[1] + raw[1], grid) - drag.anchor[1]]; guideResult = null; }
      if (Math.hypot(...raw) * stage.scale() < 2 && !drag.moved) return;
      if (drag.copy && !drag.moved) {
        const pads=[], shapes=[]; let number=nextNumber(fp().pads);
        for (const [i,x,y] of drag.origin.pads) {
          const pad = {...clone(fp().pads[i]), nativeId:A.id(), nativeIdOwner:draft.id, number};
          delete pad.id;
          pads.push([fp().pads.push(pad)-1,x,y]); number=incrementNumber(number);
        }
        for (const [,s] of drag.origin.shapes) shapes.push([fp().shapes.push(clone(s))-1,s]);
        drag.origin={pads,shapes}; selection={pads:new Set(pads.map(a=>a[0])),shapes:new Set(shapes.map(a=>a[0]))};
      }
      drag.aim=delta.map((v,k)=>drag.start[k]+v);
      drag.moved = true;
      for (const [i, x, y] of drag.origin.pads) { fp().pads[i].x = r6(x + delta[0]); fp().pads[i].y = r6(y + delta[1]); }
      for (const [i, s] of drag.origin.shapes) { const c = clone(s); moveShape(c, delta[0], delta[1]); fp().shapes[i] = c; }
      coords.textContent = "Δ " + delta[0].toFixed(3) + ", " + delta[1].toFixed(3) + " mm";
    }
    function endMove() {
      if (drag.moved) { undo.push(drag.before); redo.length = 0; }
      drag = null; guideSession = null; guideResult = null; refresh();
    }

    // ---------------- keyboard
    dlg.addEventListener("keydown", e => {
      if (ui.activationKey(e)) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      const mod = e.metaKey || e.ctrlKey, k = e.key;
      if (mod && k.toLowerCase() === "s") { e.preventDefault(); save(false); return; }
      if (mod && k.toLowerCase() === "z") { if (typing) return; e.preventDefault(); doUndo(!e.shiftKey); return; }
      if (mod && k.toLowerCase() === "y") { if (typing) return; e.preventDefault(); doUndo(false); return; }
      if (k === "Escape") {
        e.preventDefault();
        if (typing) { e.target.blur(); canvas.focus(); return; }
        if (drawing) { drawing = null; stage.render(); return; }
        if (tool !== "select") { setTool("select"); return; }
        if (selection.pads.size || selection.shapes.size) { clearSelection(); renderProps(); stage.render(); return; }
        tryClose(); return;
      }
      if (typing) { if (k === "Enter" && tool === "array" && e.target.closest(".fe-props")) { e.preventDefault(); createArray(); } return; }
      if (k === " ") { e.preventDefault(); if (tool === "pad") { template.angle = ((template.angle || 0) + 90) % 360; stage.render(); } else rotateSelection(90); return; }
      if (k === "Enter") { e.preventDefault(); if (drawing) finishDrawing(); else if (tool === "renumber") setTool("select"); else if (tool === "array") createArray(); return; }
      if (mod && k.toLowerCase() === "a") { e.preventDefault(); selection = {pads: new Set(fp().pads.keys()), shapes: new Set(fp().shapes.keys())}; renderProps(); stage.render(); return; }
      if (mod && k.toLowerCase() === "d") { e.preventDefault(); duplicateSelection(); return; }
      if (k === "Delete" || k === "Backspace") { e.preventDefault(); deleteSelection(); return; }
      if (k.startsWith("Arrow")) {
        e.preventDefault();
        const s = grid * (e.shiftKey ? 10 : 1), d = {ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s]}[k];
        change(() => { for (const p of selectedPads()) { p.x = r6(p.x + d[0]); p.y = r6(p.y + d[1]); } for (const sh of selectedShapes()) moveShape(sh, d[0], d[1]); });
        return;
      }
      if (mod || e.altKey) return;
      const tk = TOOLS.find(([, , key]) => key === k.toUpperCase())?.[0];
      if (tk) { e.preventDefault(); setTool(tk); return; }
      if (k === "f" || k === "F") { e.preventDefault(); stage.fit(); return; }
      if (k === "g") { e.preventDefault(); grid = GRIDS[(GRIDS.indexOf(grid) + 1) % GRIDS.length]; gridSel.value = grid; hint.textContent = "Grid " + grid + " mm"; return; }
      if (k === "G") { e.preventDefault(); grid = GRIDS[(GRIDS.indexOf(grid) + GRIDS.length - 1) % GRIDS.length]; gridSel.value = grid; hint.textContent = "Grid " + grid + " mm"; return; }
      if (k === "x" && selection.pads.size + selection.shapes.size) { e.preventDefault(); mirrorSelection(0); return; }
      if (k === "y" && selection.pads.size + selection.shapes.size) { e.preventDefault(); mirrorSelection(1); return; }
      if (k === "+" || k === "=") { stage.zoom(1.25); return; }
      if (k === "-") { stage.zoom(.8); return; }
    });
    dlg.addEventListener("keydown", e => { if (e.key === " " && e.target === canvas) stage.spaceDown = true; });
    dlg.addEventListener("keyup", e => { if (e.key === " ") stage.spaceDown = false; });
    function selectionCentre() {
      const b = A.bounds([...selectedPads().map(p => [p.x, p.y]), ...selectedShapes().flatMap(s => { const r = shapeBox(s); return r ? [[r[0], r[1]], [r[2], r[3]]] : []; })]);
      return b ? [A.snap((b[0] + b[2]) / 2, grid), A.snap((b[1] + b[3]) / 2, grid)] : [0, 0];
    }
    function rotateSelection(deg) {
      if (!selection.pads.size && !selection.shapes.size) return;
      const c = selectionCentre(), rot = p => { const q = A.rotate([p[0] - c[0], p[1] - c[1]], deg); return [r6(q[0] + c[0]), r6(q[1] + c[1])]; };
      change(() => {
        for (const p of selectedPads()) { [p.x, p.y] = rot([p.x, p.y]); p.angle = r6(((p.angle || 0) + deg + 360) % 360); }
        for (const s of selectedShapes()) { if (s.points) { s.points = s.points.map(rot); if (s.arc?.kind === "arc") s.arc = A.transformArc(s.arc, rot, deg); } else { [s.x, s.y] = rot([s.x, s.y]); if (s.kind === "text") s.angle = r6(((s.angle || 0) + deg + 360) % 360); } }
      });
    }
    function mirrorSelection(axis) {
      const c = selectionCentre(), f = p => axis === 0 ? [r6(2 * c[0] - p[0]), p[1]] : [p[0], r6(2 * c[1] - p[1])];
      change(() => {
        for (const p of selectedPads()) { [p.x, p.y] = f([p.x, p.y]); if (p.angle) p.angle = r6((360 - p.angle) % 360); if (p.poly) p.poly = p.poly.map(q => axis === 0 ? [-q[0], q[1]] : [q[0], -q[1]]); }
        for (const s of selectedShapes()) { if (s.points) { s.points = s.points.map(f); if (s.arc?.kind === "arc") s.arc = A.transformArc(s.arc, f, axis === 0 ? 0 : 180, true); } else [s.x, s.y] = f([s.x, s.y]); }
      });
    }
    function duplicateSelection() {
      if (!selection.pads.size && !selection.shapes.size) return;
      const pads = selectedPads().map(clone), shapes = selectedShapes().map(clone), off = Math.max(grid * 4, .5);
      let n = nextNumber(fp().pads);
      change(() => {
        const p0 = fp().pads.length, s0 = fp().shapes.length;
        for (const p of pads) { p.x = r6(p.x + off); p.y = r6(p.y + off); p.number = n; n = incrementNumber(n); p.nativeId = A.id(); p.nativeIdOwner = draft.id; delete p.id; fp().pads.push(p); }
        for (const s of shapes) { moveShape(s, off, off); fp().shapes.push(s); }
        selection = {pads: new Set(pads.map((_, i) => p0 + i)), shapes: new Set(shapes.map((_, i) => s0 + i))};
      });
    }
    function deleteSelection() {
      if (!selection.pads.size && !selection.shapes.size) return;
      change(() => {
        fp().pads = fp().pads.filter((_, i) => !selection.pads.has(i));
        fp().shapes = fp().shapes.filter((_, i) => !selection.shapes.has(i));
      }, false);
    }
    function createArray() {
      const pads = previewArray();
      if (!pads.length) return;
      const replace = selection.pads.size === 1;
      change(() => {
        if (replace) fp().pads.splice([...selection.pads][0], 1);
        const p0 = fp().pads.length;
        for (const [i, pad] of pads.entries()) {
          if (i > 0 || !replace) {pad.nativeId = A.id(); pad.nativeIdOwner = draft.id; delete pad.id;}
          fp().pads.push(pad);
        }
        selection = {pads: new Set(pads.map((_, i) => p0 + i)), shapes: new Set()};
      });
      hint.textContent = pads.length + " pads created.";
      setTool("select");
    }

    // ---------------- properties panel
    const field = ui.propertyFields(() => grid), section = ui.editorSection;
    // Edit every selected pad at once; a mixed field shows blank and only changes what you type.
    function padFields(parent, pads, apply) {
      const same = k => pads.every(p => JSON.stringify(p[k]) === JSON.stringify(pads[0][k])) ? pads[0][k] : undefined;
      const set = (k, v) => apply(p => { if (v === undefined) delete p[k]; else p[k] = v; });
      if (pads.length === 1) field(parent, "Number", pads[0].number, v => set("number", String(v).trim()), {title: "Pad designator. Several pads may share a number (they join one net)."});
      const pos = el("div", null, "fe-pair"); parent.append(pos);
      field(pos, "X", same("x"), v => set("x", v), {number: true}); field(pos, "Y", same("y"), v => set("y", v), {number: true});
      const size = el("div", null, "fe-pair"); parent.append(size);
      field(size, "Width", same("w"), v => set("w", v), {number: true, min: .001}); field(size, "Height", same("h"), v => set("h", v), {number: true, min: .001});
      const th = pads.every(p => p.drill > 0), smd = pads.every(p => !(p.drill > 0));
      field(parent, "Shape", same("shape") || "", v => apply(p => { p.shape = v; if (v === "custom" && !p.poly) p.poly = [[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [0, p.h / 2 + p.h * .3], [-p.w / 2, p.h / 2]].map(q => q.map(r6)); }),
        {values: [["", "—"], ["round", "Round"], ["rect", "Rectangle"], ["roundrect", "Rounded rectangle"], ["oval", "Oval"], ["octagon", "Octagon"], ["custom", "Custom polygon"]]});
      if (pads.length === 1 && pads[0].shape === "custom") field(parent, "Polygon (x,y; …)", (pads[0].poly || []).map(q => q.join(",")).join("; "), v => {
        const pts = String(v).split(";").map(s => s.split(",").map(Number)).filter(q => q.length === 2 && q.every(Number.isFinite));
        if (pts.length >= 3) set("poly", pts.map(q => q.map(r6)));
      }, {title: "Pad outline relative to the pad centre, before rotation. Width and height bound it."});
      field(parent, "Rotation °", same("angle") ?? (pads.length > 1 ? undefined : 0), v => set("angle", v), {number:true,unit:"deg"});
      field(parent, "Type", th ? "th" : smd ? "smd" : "", v => apply(p => {
        if (v === "th") { p.drill = p.drill > 0 ? p.drill : r6(Math.min(p.w, p.h) * .6); p.layer = "Multi"; p.plated = true; delete p.pasteExpansion; }
        else if (v === "smd") { p.drill = 0; delete p.layer; delete p.plated; delete p.stackMode; delete p.padStack; }
        else if (v === "npth") { p.drill = Math.min(p.w, p.h); p.layer = "Multi"; p.plated = false; }
      }), {values: [["", "—"], ["smd", "SMD (Top)"], ["th", "Through-hole (plated)"], ["npth", "Mounting hole (NPTH)"]]});
      if (th) {
        field(parent, "Drill Ø", same("drill"), v => set("drill", v), {number: true, min: .01});
        field(parent, "Pad stack", same("stackMode") || "simple", v => apply(p => {
          p.stackMode = v;
          if (v === "simple") { delete p.padStack; delete p.stackMode; }
          else { const base = {w: p.w, h: p.h, shape: p.shape}; p.padStack = v === "tmb" ? {Top: {...base}, Mid: {...base}, Bottom: {...base}} : {Top: {...base}, Mid: {...base}, Bottom: {...base}, ...(p.padStack || {})}; }
        }), {values: [["simple", "Simple (same on every layer)"], ["tmb", "Top / Middle / Bottom"]], title: "Per-layer pad stack. The top land is the drawn pad; inner and bottom sizes are stored for outputs and review."});
        if (pads.length === 1 && pads[0].padStack) for (const layer of ["Top", "Mid", "Bottom"]) {
          const st = pads[0].padStack[layer] || (pads[0].padStack[layer] = {w: pads[0].w, h: pads[0].h, shape: pads[0].shape});
          const row = el("div", null, "fe-pair fe-stack"); row.append(el("span", layer, "fe-stack-name")); parent.append(row);
          field(row, layer + " W", st.w, v => apply(p => { p.padStack[layer].w = v; if (layer === "Top") p.w = v; }), {number: true, min: .01});
          field(row, layer + " H", st.h, v => apply(p => { p.padStack[layer].h = v; if (layer === "Top") p.h = v; }), {number: true, min: .01});
        }
      } else if (smd) field(parent, "Layer", same("layer") || "Top", v => set("layer", v === "Top" ? undefined : v), {values: [["Top", "Top"], ["Bottom", "Bottom"]]});
      const exp = el("div", null, "fe-pair"); parent.append(exp);
      field(exp, "Paste ±", same("pasteExpansion"), v => set("pasteExpansion", v), {number: true, optional: true, placeholder: "rule", title: "Paste mask expansion override (negative shrinks). Blank uses the design rule."});
      field(exp, "Mask ±", same("maskExpansion"), v => set("maskExpansion", v), {number: true, optional: true, placeholder: "rule", title: "Solder mask expansion override. Blank uses the design rule."});
      field(parent, "Thermal / exposed pad", pads.every(p => p.thermal), v => set("thermal", v ? true : undefined), {check: true, title: "Marks an exposed thermal pad: segmented paste and thermal vias are expected."});
    }
    function renderProps() {
      props.replaceChildren();
      const pads = selectedPads(), shapes = selectedShapes();
      if (tool === "array") {
        const s = section(props, "Pad array");
        const a = arraySpec, up = () => stage.render();
        field(s, "Type", a.type, v => { a.type = v; renderProps(); up(); }, {values: [["linear", "Linear"], ["circular", "Circular"], ["grid", "Grid"]]});
        if (a.type === "linear") { field(s, "Count", a.count, v => { a.count = v; up(); }, {number: true, min: 1,unit:"ea",integer:true}); const pr = el("div", null, "fe-pair"); s.append(pr); field(pr, "Pitch X", a.dx, v => { a.dx = v; up(); }, {number: true}); field(pr, "Pitch Y", a.dy, v => { a.dy = v; up(); }, {number: true}); }
        if (a.type === "circular") { field(s, "Count", a.count, v => { a.count = v; up(); }, {number: true, min: 1,unit:"ea",integer:true}); field(s, "Radius", a.radius, v => { a.radius = v; up(); }, {number: true, min: .01}); const pr = el("div", null, "fe-pair"); s.append(pr); field(pr, "Start °", a.startAngle, v => { a.startAngle = v; up(); }, {number:true,unit:"deg"}); field(pr, "Sweep °", a.sweep, v => { a.sweep = v; up(); }, {number:true,unit:"deg"}); field(s, "Rotate pads", a.rotate, v => { a.rotate = v; up(); }, {check: true}); }
        if (a.type === "grid") { const pr = el("div", null, "fe-pair"); s.append(pr); field(pr, "Rows", a.rows, v => { a.rows = v; up(); }, {number: true, min: 1,unit:"ea",integer:true}); field(pr, "Columns", a.cols, v => { a.cols = v; up(); }, {number: true, min: 1,unit:"ea",integer:true});
          const pq = el("div", null, "fe-pair"); s.append(pq); field(pq, "Pitch X", a.pitchX, v => { a.pitchX = v; up(); }, {number: true}); field(pq, "Pitch Y", a.pitchY, v => { a.pitchY = v; up(); }, {number: true});
          field(s, "Numbering", a.order, v => { a.order = v; up(); }, {values: [["rows", "Across rows"], ["columns", "Down columns"], ["snake", "Snake (zig-zag)"], ["alpha", "BGA style (A1, A2… B1)"]]}); }
        const pr = el("div", null, "fe-pair"); s.append(pr);
        field(pr, "First number", a.start, v => { a.start = String(v); up(); }); field(pr, "Step", a.step, v => { a.step = Math.round(v) || 1; up(); }, {number: true, unit: "", integer: true});
        const note = el("p", selectedPads()[0] ? "Template: pad " + selectedPads()[0].number + " (replaced by the array)." : "Template: the pad tool settings below.", "fe-note");
        note.append(...shortcutText(" Press {enter} to create.")); s.append(note);
        const go = ui.button("Create array", createArray, "lib-primary"); s.append(go);
        if (!selectedPads()[0]) { const t = section(props, "Pad template"); padFields(t, [template], fn => { fn(template); stage.render(); }); }
        return;
      }
      if (tool === "renumber") {
        const s = section(props, "Renumber by clicking");
        field(s, "Start at", renumberState.start, v => { renumberState.start = String(v); renumberState.order = []; setTool("renumber"); });
        s.append(el("p", "Click pads in the order you want them numbered. Already-clicked pads keep their new number; the checks below flag duplicates left behind.", "fe-note"));
        s.append(ui.button("Auto-number counter-clockwise from pin 1", () => change(() => autoNumber()), "lib-mini"));
        return;
      }
      if (tool === "pad") {
        const s = section(props, "New pad");
        field(s, "Number", template.number, v => { template.number = String(v); });
        padFields(s, [template], fn => { fn(template); stage.render(); });
        return;
      }
      if (pads.length) {
        const s = section(props, pads.length === 1 ? "Pad " + pads[0].number : pads.length + " pads");
        padFields(s, pads, fn => change(() => pads.forEach(p => fn(p))));
        if (pads.length > 1) {
          const n = section(props, "Numbering");
          n.append(ui.button("Renumber selection in click order…", () => setTool("renumber"), "lib-mini"));
          n.append(ui.button("Number left→right, top→bottom", () => change(() => { const order = [...selection.pads].sort((i, j) => fp().pads[i].y - fp().pads[j].y || fp().pads[i].x - fp().pads[j].x); renumber(fp().pads, order, {start: fp().pads[order[0]].number}); }), "lib-mini"));
        }
      }
      if (shapes.length === 1) {
        const sh = shapes[0], s = section(props, {path: sh.closed ? "Polygon" : "Line", circle: "Circle", text: "Text"}[sh.kind] || "Shape");
        field(s, "Layer", layerKey(sh), v => change(() => { const keep = {kind: sh.kind}; for (const k of ["style", "layer", "width"]) delete sh[k]; Object.assign(sh, layerShape(v), keep); if (sh.kind === "text" && v === "silk") sh.layer = "Silk"; }),
          {values: Object.entries(LAYERS).map(([k, l]) => [k, l.title])});
        if (sh.kind !== "text") field(s, "Line width", sh.width ?? "", v => change(() => { sh.width = v; }), {number: true, min: 0});
        if (sh.kind === "circle") { field(s, "Radius", sh.r, v => change(() => { sh.r = v; }), {number: true, min: .001}); field(s, "Filled", sh.fill, v => change(() => { sh.fill = v || undefined; }), {check: true}); }
        if (sh.kind === "path") field(s, "Closed / filled", sh.closed ? (sh.fill ? "fill" : "closed") : "open", v => change(() => { sh.closed = v !== "open" || undefined; sh.fill = v === "fill" || undefined; }), {values: [["open", "Open polyline"], ["closed", "Closed outline"], ["fill", "Filled region"]]});
        if (sh.kind === "text") {
          const special = field(s, "Text", sh.text, v => change(() => { sh.text = v; }));
          special.setAttribute("list", "fe-special");
          const dl = el("datalist"); dl.id = "fe-special"; for (const v of [".Designator", ".Comment"]) dl.append(new Option(v, v)); s.append(dl);
          const pr = el("div", null, "fe-pair"); s.append(pr);
          field(pr, "Height", sh.size ?? .8, v => change(() => { sh.size = v; }), {number: true, min: .05}); field(pr, "Rotation °", sh.angle ?? 0, v => change(() => { sh.angle = v; }), {number:true,unit:"deg"});
          field(s, "Align", sh.align || "left", v => change(() => { sh.align = v; }), {values: ["left", "center", "right"]});
        }
      } else if (shapes.length > 1) {
        const s = section(props, shapes.length + " shapes");
        field(s, "Layer", "", v => v && change(() => shapes.forEach(sh => { for (const k of ["style", "layer", "width"]) delete sh[k]; Object.assign(sh, layerShape(v)); })), {values: [["", "—"], ...Object.entries(LAYERS).map(([k, l]) => [k, l.title])]});
      }
      if (!pads.length && !shapes.length) footprintProps();
      else if (!pads.length) quickAddSection();
    }
    // Counter-clockwise (as seen from the top) from the top-left pad: pin 1 of dual and quad packages.
    function autoNumber() {
      const pads = fp().pads.map((p, i) => [p, i]).filter(([p]) => !p.thermalVia && !p.thermal);
      if (!pads.length) return;
      const c = A.bounds(pads.map(([p]) => [p.x, p.y])), cx = (c[0] + c[2]) / 2, cy = (c[1] + c[3]) / 2;
      const ang = p => Math.atan2(-(p.y - cy), p.x - cx);
      const first = pads.reduce((b, q) => (q[0].x < b[0].x - 1e-6 || (Math.abs(q[0].x - b[0].x) < 1e-6 && q[0].y < b[0].y)) ? q : b);
      const a0 = ang(first[0]), rel = p => (ang(p) - a0 + 4 * Math.PI) % (2 * Math.PI);
      const order = pads.sort((a, b) => rel(a[0]) - rel(b[0])).map(([, i]) => i);
      renumber(fp().pads, order, {start: renumberState?.start || "1"});
    }
    function footprintProps() {
      const s = section(props, "Footprint");
      field(s, "Name", fp().name || draft.name, v => change(() => { fp().name = String(v).trim(); if (isNew || draft.name === "New footprint") draft.name = fp().name; title.textContent = "Footprint Editor — " + fp().name; }));
      field(s, "Component name", draft.name, v => change(() => { draft.name = String(v).trim(); }));
      // One row each, so the labels stay in the section's label column.
      field(s, "Prefix", draft.prefix || "U", v => change(() => { draft.prefix = String(v).trim(); })); field(s, "Value", draft.value || "", v => change(() => { draft.value = v; }));
      const b = section(props, "3D body");
      field(b, "Body height", fp().height ?? "", v => change(() => { if (v == null) delete fp().height; else fp().height = v; }), {number: true, optional: true, min: 0, unit: "mm", title: "Used by the 3D view and STEP export when no model is linked."});
      const m3 = fp().model3d;
      const info = el("p", m3 ? "STEP model: " + (m3.file || "embedded") + (m3.stepText ? " · " + Math.round(m3.stepText.length / 1024) + " KB embedded" : "") : "No STEP model linked. A body is generated from the 3D body or assembly outline and the height.", "fe-note");
      b.append(info);
      // What the 3D view will show of the model (step-import.js; bounded reader in a worker).
      if (m3?.stepText) {
        const L = globalThis.AtriumLazy;
        (globalThis.AtriumSTEPImport ? Promise.resolve() : L ? L.need("AtriumSTEPImport") : Promise.reject(Error("unavailable")))
          .then(() => AtriumSTEPImport.load(m3.stepText)).then(r => { if (fp().model3d === m3) info.textContent += " · " + AtriumSTEPImport.summary(r); }).catch(() => {});
      }
      const file = el("input"); file.type = "file"; file.accept = ".step,.stp,.STEP,.STP"; file.hidden = true;
      file.onchange = async () => {
        const f = file.files?.[0]; if (!f) return;
        if (f.size > 32 * 1048576) { info.textContent = "That STEP model is larger than 32 MB."; return; }
        const request = ++stepRequest;
        try {
          info.textContent = "Reading " + f.name + "…";
          const bytes = new Uint8Array(await f.arrayBuffer()), lazy = globalThis.AtriumLazy;
          const client = await lazy.need("AtriumTranslatorClient");
          const r = await client.import([{name:f.name, bytes}], {translator:"step"});
          const reader = await lazy.need("AtriumSTEPImport");
          if (!dlg.open || request !== stepRequest || fp().model3d !== m3) return;
          const text = new TextDecoder().decode(r.provenance.files[0].bytes);
          reader.remember(text, r.provenance.mechanical.mesh);
          stepTranslation = {text, result:r};
          change(() => { fp().model3d = {file:f.name, stepText:text, offset:m3?.offset || [0, 0, 0], rotation:m3?.rotation || [0, 0, 0]}; });
        } catch (e) { if (request === stepRequest) info.textContent = e.message; }
      };
      b.append(file, ui.button(m3 ? "Replace STEP…" : "Embed STEP model…", () => file.click(), "lib-mini"));
      if (m3) {
        b.append(ui.button("Remove model", () => change(() => { delete fp().model3d; }), "lib-mini"));
        const off = el("div", null, "fe-pair fe-triple"); b.append(off);
        ["X", "Y", "Z"].forEach((ax, i) => field(off, "Offset " + ax, m3.offset?.[i] ?? 0, v => change(() => { fp().model3d.offset = [...(fp().model3d.offset || [0, 0, 0])]; fp().model3d.offset[i] = v; }), {number: true}));
        const rot = el("div", null, "fe-pair fe-triple"); b.append(rot);
        ["X", "Y", "Z"].forEach((ax, i) => field(rot, "Rotate " + ax + "°", m3.rotation?.[i] ?? 0, v => change(() => { fp().model3d.rotation = [...(fp().model3d.rotation || [0, 0, 0])]; fp().model3d.rotation[i] = v; }), {number:true,unit:"deg"}));
      }
      quickAddSection();
    }
    // Stays below the shape properties too, so the shapes a quick add selects keep it in reach.
    function quickAddSection() {
      const q = section(props, "Quick add");
      const quick = (label, make) => { const b = ui.button(label, () => quickAdd(make), "lib-mini"); b.dataset.quickAdd = make.name; q.append(b); };
      quick("Courtyard from pads and body (+0.25)", function courtyard() { return addCourtyard(.25); });
      quick("Silk outline around pads", function silk() { return addSilk(); });
      quick(".Designator text on silk", function designator() { return addDesignator(); });
      if (fp().wizard && ctx.reopenWizard) q.append(ui.button("Re-open in IPC wizard…", () => { if (snapshot() !== saved && !confirmDiscard()) return; dlg.close(); ctx.reopenWizard(build()); }, "lib-mini"));
    }
    // Quick add: one undo step that adds shapes, selects them and brings them into view.
    function quickAdd(make) {
      let added = [];
      change(() => { added = make() || []; });
      if (!added.length) { hint.textContent = "Add pads first."; return; }
      selection = {pads: new Set(), shapes: new Set(added.map(x => fp().shapes.indexOf(x)).filter(i => i >= 0))};
      refresh();
      reveal(added);
    }
    // Brings new shapes into view: zooms out (about the whole footprint) only when they are off the canvas.
    // The renderer's fit leaves text out, so the footprint box comes from shapeBox here.
    function reveal(shapes) {
      const corners = list => list.flatMap(x => { const r = shapeBox(x); return r ? [[r[0], r[1]], [r[2], r[3]]] : []; });
      const r = canvas.getBoundingClientRect(), seen = b => { const a = stage.toScreen([b[0], b[1]]), z = stage.toScreen([b[2], b[3]]);
        return Math.min(a[0], z[0]) >= 0 && Math.min(a[1], z[1]) >= 0 && Math.max(a[0], z[0]) <= r.width && Math.max(a[1], z[1]) <= r.height; };
      const mine = A.bounds(corners(shapes));
      if (!mine || !r.width || seen(mine)) return;
      const pads = fp().pads.map(padRectOf).flatMap(b => [[b[0], b[1]], [b[2], b[3]]]);
      const all = A.bounds([...pads, ...corners(fp().shapes)]);
      const a = stage.toScreen([all[0], all[1]]), z = stage.toScreen([all[2], all[3]]);
      const f = Math.min(1, .85 * r.width / Math.max(1, Math.abs(z[0] - a[0])), .85 * r.height / Math.max(1, Math.abs(z[1] - a[1])));
      stage.zoom(f, [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2]);
      const p = stage.toScreen([(all[0] + all[2]) / 2, (all[1] + all[3]) / 2]);
      stage.pan(Math.round(r.width / 2 - p[0]), Math.round(r.height / 2 - p[1]));
    }
    function addDesignator() {
      const b = extents(), court = fp().shapes.filter(s => layerKey(s) === "courtyard").map(shapeBox).filter(Boolean);
      const top = Math.min(b[1], ...court.map(c => c[1])), size = r6(Math.max(.5, Math.min(1, (b[2] - b[0]) * .3)));
      const t = {kind: "text", text: ".Designator", x: r6((b[0] + b[2]) / 2), y: 0, size, align: "center", layer: "Silk"};
      // Its lowest ink (descenders included) 0.2 mm above the outline, courtyard included.
      let ink = null; try { ink = globalThis.AtriumPCBText?.paintBox(t); } catch {}
      t.y = r6(top - .2 - (ink?.length === 4 && Number.isFinite(ink[3]) ? ink[3] : shapeBox(t)[3]));
      fp().shapes.push(t);
      return [t];
    }
    function extents() {
      const pts = [];
      for (const p of fp().pads) { const r = padRectOf(p); pts.push([r[0], r[1]], [r[2], r[3]]); }
      for (const s of fp().shapes) { if (layerKey(s) === "courtyard") continue; const r = shapeBox(s); if (r) pts.push([r[0], r[1]], [r[2], r[3]]); }
      return A.bounds(pts) || [-1, -1, 1, 1];
    }
    function addCourtyard(excess) {
      fp().shapes = fp().shapes.filter(s => layerKey(s) !== "courtyard");
      const b = extents(), up = v => Math.ceil(v / .05 - 1e-9) * .05;
      const c = [-up(-b[0] + excess), -up(-b[1] + excess), up(b[2] + excess), up(b[3] + excess)].map(r6);
      const s = {kind: "path", closed: true, points: [[c[0], c[1]], [c[2], c[1]], [c[2], c[3]], [c[0], c[3]]], ...layerShape("courtyard")};
      fp().shapes.push(s);
      return [s];
    }
    function addSilk() {
      const pads = fp().pads;
      if (!pads.length) return [];
      const body = fp().shapes.filter(s => ["assembly", "body"].includes(layerKey(s)));
      let b = body.length ? A.bounds(body.flatMap(s => { const r = shapeBox(s); return r ? [[r[0], r[1]], [r[2], r[3]]] : []; })) : null;
      // Without a body outline the silk goes around the pads, clear of their mask clearance:
      // silkOutline() cuts each edge where it crosses a pad grown by the gap, so an outline drawn
      // only 0.2 mm out (inside that keep-out) was cut away entirely.
      const W = AtriumFootprintWizard, gap = W.SILK_GAP ?? .2, w = W.SILK_W ?? .18, grow = gap + w;
      if (!b) { const r = pads.map(padRectOf); b = [Math.min(...r.map(x => x[0])) - grow, Math.min(...r.map(x => x[1])) - grow, Math.max(...r.map(x => x[2])) + grow, Math.max(...r.map(x => x[3])) + grow].map(r6); }
      let out = W.silkOutline(b, pads, {});
      // A body that the pads cover entirely (a chip resistor's) leaves nothing: go around the pads.
      if (!out.length && body.length) { const r = pads.map(padRectOf); out = W.silkOutline([Math.min(...r.map(x => x[0])) - grow, Math.min(...r.map(x => x[1])) - grow, Math.max(...r.map(x => x[2])) + grow, Math.max(...r.map(x => x[3])) + grow].map(r6), pads, {}); }
      fp().shapes.push(...out);
      return out;
    }

    // ---------------- checks
    function renderChecks() {
      checks.replaceChildren();
      const k = globalThis.AtriumUIKit;
      const errs = issues.filter(x => x.level === "error").length, warns = issues.filter(x => x.level === "warning").length;
      const summary = errs || warns ? errs + " error" + (errs === 1 ? "" : "s") + " · " + warns + " warning" + (warns === 1 ? "" : "s") : "All clear";
      const tone = errs ? "danger" : warns ? "warning" : "success";
      const pads = fp().pads.filter(p => !p.thermalVia).length;
      const statsText = pads + " pads · " + fp().shapes.length + " shapes" + (fp().height ? " · " + fp().height + " mm tall" : "");
      if (k) {
        const toggle = k.button(showIssues ? "Hide markers" : "Show markers", {variant: "quiet", size: "sm", run: () => { showIssues = !showIssues; renderChecks(); stage.render(); }});
        const rows = issues.map(x => k.row({
          title: x.message,
          icon: k.dot(x.level === "error" ? "danger" : "warning"),
          run: () => {
            if (x.pads?.length) { selection = {pads: new Set(x.pads), shapes: new Set()}; renderProps(); }
            stage.render();
          }
        }));
        const listEl = rows.length ? k.list(rows, {role: "list", label: "Footprint checks"}) : null;
        const stats = k.statusLine(statsText);
        checks.append(k.section("Checks", {quiet: true, actions: [k.badge(summary, tone), toggle]}, ...(listEl ? [listEl, stats] : [stats])));
      } else {
        const ul = el("ul");
        for (const x of issues) {
          const li = el("li", null, "lvl-" + x.level), b = ui.button(x.message, () => {
            if (x.pads?.length) { selection = {pads: new Set(x.pads), shapes: new Set()}; renderProps(); }
            stage.render();
          });
          li.append(b); ul.append(li);
        }
        checks.append(ul);
      }
    }
    // Checks run at once for ordinary footprints and are debounced (120 ms) for large ones.
    let checkTimer = 0;
    function runChecks() { checkTimer = 0; issues = AtriumLibrary.checkFootprint(fp()); renderChecks(); stage.render(); }
    function heading() { return "Footprint Editor — " + (fp().name || draft.name); }
    function refresh() {
      clearTimeout(checkTimer);
      if (fp().pads.length < 300) issues = AtriumLibrary.checkFootprint(fp());
      else checkTimer = setTimeout(runChecks, 120);
      title.textContent = heading();
      saveButton.textContent = snapshot() === saved ? "Save" : "Save •";
      renderProps(); renderChecks(); stage.render();
    }
    function build() {
      const def = clone(draft);
      if (!def.footprint.name) def.footprint.name = def.name;
      def.footprint.pads = def.footprint.pads.map(p => { const q = {...p}; for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k]; q.number = String(q.number ?? ""); return q; });
      return def;
    }
    function save(place) {
      const def = build(), v = AtriumLibrary.validateDef(def, {footprintWarnings: false});
      if (!v.ok) { hint.textContent = v.errors[0]; hint.classList.add("bad"); return; }
      hint.classList.remove("bad");
      saved = snapshot();
      dlg.close();
      ctx.commit?.(def, place);
      if (stepTranslation && def.footprint.model3d?.stepText === stepTranslation.text)
        globalThis.AtriumNavHost?.showImportReport?.(stepTranslation.result, [], [def.footprint.model3d.file]);
    }
    function tryClose(force) {
      if (!force && !mayDiscard()) return;
      dlg.close();
    }
    function confirmDiscard() { return typeof confirm === "function" ? confirm("Discard the changes to this footprint?") : true; }
    // Closing the editor, or a project switch closing its tab (dlg.mayDiscard), asks about unsaved changes.
    // A switch may ask again before it commits; "Discard" holds for the same draft until keepDraft().
    let discarded = null;
    const unsaved = () => { const s = snapshot(); return s !== saved && s !== discarded; };
    function mayDiscard() { if (!unsaved()) return true; if (!confirmDiscard()) return false; discarded = snapshot(); return true; }
    dlg.requestClose = () => tryClose();
    Object.assign(dlg, {unsaved, mayDiscard, keepDraft: () => { discarded = null; }});
    ui.paletteSurface(dlg, "footprint", canvas, stage, {
      pins: () => fp().pads,
      select: i => { clearSelection(); selection.pads.add(i); refresh(); },
      hitAt: point => hit(point),
      insert(id, point) {
        if (!dlg.open) return;
        canvas.focus(); setTool(id);
        placeAt(snap(point).at, {});
        if (id === "pad") setTool("select");
      },
      commands: () => [
        ...(undo.length ? [{key: "cmd:footprint:undo", kind: "command", label: "Undo", detail: "Footprint Editor", run: () => doUndo()}] : []),
        ...(redo.length ? [{key: "cmd:footprint:redo", kind: "command", label: "Redo", detail: "Footprint Editor", run: () => doUndo(false)}] : [])
      ]
    });
    title.textContent = heading(); // the editor tab takes its title from the heading
    ui.showSurface(dlg);
    setTool("select");
    refresh();
    stage.observe();
    canvas.focus();
    return dlg.editor = {dialog: dlg, draft, stage, setTool, select: (pads = [], shapes = []) => { selection = {pads: new Set(pads), shapes: new Set(shapes)}; refresh(); }, change, save, issues: () => (issues = AtriumLibrary.checkFootprint(fp()))};
  }
  return Object.freeze({open, padArray, incrementNumber, nextNumber, renumber, layerShape, layerKey, padContains, shapeDistance, LAYERS});
})();
