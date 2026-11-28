"use strict";
// Graphical schematic symbol editor (modal work surface, like the footprint editor; see
// footprint-editor.js for why it is not a document tab). Pins carry number, name,
// electrical type, length, orientation, hidden, inverted and clock; the body is drawn
// with rectangles, lines, arcs, circles and text. Multi-part symbols (gates A, B, …) and
// an alternate De Morgan view use the pin.part / shape.part / shape.alt extension that
// AtriumLibrary documents. The Pins tab is a spreadsheet with CSV/TSV paste and a
// "generate from pin list" quick-create.
//
// Headless helpers: AtriumSymbolEditor.arcPoints(x, y, r, start, end), filterGate(symbol, part, alt).
globalThis.AtriumSymbolEditor = (() => {
  const A = globalThis.Atrium;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const clone = v => JSON.parse(JSON.stringify(v));
  const G = 2.54;
  const ORIENT = ["left", "up", "right", "down"];
  const DIR = {left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1]};
  function arcPoints(x, y, r, start, end) {
    let sweep = end - start; if (sweep <= 0) sweep += 360;
    const n = Math.max(6, Math.ceil(sweep / 10)), pts = [];
    for (let i = 0; i <= n; i++) { const a = (start + sweep * i / n) * Math.PI / 180; pts.push([r6(x + r * Math.cos(a)), r6(y + r * Math.sin(a))]); }
    return pts;
  }
  // The gate/view filter the canvas applies to placed parts (Atrium.gate), for previews.
  function filterGate(symbol, part = 1, alt = false) {
    if (!symbol || !((symbol.parts || 1) > 1 || symbol.alternate)) return symbol;
    const inGate = x => !(x.part > 0) || x.part === part, inView = x => x.alt == null || !!x.alt === !!alt;
    return {...symbol, pins: symbol.pins.filter(inGate), shapes: symbol.shapes.filter(s => inGate(s) && inView(s))};
  }
  const gateName = g => g > 0 ? String.fromCharCode(64 + g) : "All";

  function open(ctx = {}) {
    const L = AtriumLibrary, ui = L.ui, el = ui.el;
    if (!globalThis.AtriumCatalogue) globalThis.AtriumLazy?.need?.("AtriumCatalogue")?.catch?.(() => {}); // unique "Use footprint of" choices
    const source = ctx.def ? clone(ctx.def) : {id: A.id(), name: L.uniqueName({library: ctx.library || []}, "New component"), prefix: "U", value: "", category: "Project components"};
    // Edit on a part whose editor tab is open shows that tab, and builds no second editor.
    const tabId = "symbol-editor:" + source.id, openTab = ui.showOpenTab(tabId, !!ctx.asTab);
    if (openTab) return openTab;
    const model = source.symbol ? L.symbolModel(source.symbol) : {pins: [], shapes: [{kind: "path", style: "body", closed: true, fill: true, points: [[-5.08, -5.08], [5.08, -5.08], [5.08, 5.08], [-5.08, 5.08]]}], parts: 1, alternate: false};
    const meta = {name: source.name, prefix: source.prefix || "U", value: source.value || "", description: source.description || "", parameters: {...(source.parameters || {})}};
    const dlg = ui.editorSurface("Symbol Editor", "se-dialog", {tabId, icon: "schematic", hostTab: !!ctx.asTab}), title = dlg.heading.querySelector("h2");
    const shortcutText = text => AtriumNavCommon.shortcutParts(text, {enter:"Enter", escape:"Escape", rotate:"Space"});
    let tool = "select", gate = 1, alt = false, selection = {pins: new Set(), shapes: new Set()}, pointer = [0, 0], screenPointer = null, drag = null, drawing = null;
    let template = {number: "1", name: "", electrical: 4, length: 2 * G, orientation: "left"}, tab = "props";
    const undo = [], redo = [];
    // The chosen footprint is part of the edit state (undo, dirty mark, discard prompt);
    // footprint objects are kept by reference so STEP text is never serialised per step.
    const footprints = [source.footprint || null];
    const fpIndex = () => { let k = footprints.indexOf(source.footprint || null); if (k < 0) { footprints.push(source.footprint); k = footprints.length - 1; } return k; };
    const state = () => JSON.stringify({model, meta, fp: fpIndex()});
    let saved = state();
    function change(fn) { const before = state(); fn(); if (state() !== before) { undo.push(before); if (undo.length > 200) undo.shift(); redo.length = 0; } refresh(); }
    function restore(s) { const v = JSON.parse(s); Object.assign(model, v.model); Object.assign(meta, v.meta); if (footprints[v.fp]) source.footprint = footprints[v.fp]; else delete source.footprint; clearSel(); refresh(); }
    function doUndo(back = true) { const f = back ? undo : redo, t = back ? redo : undo; if (!f.length) return; t.push(state()); restore(f.pop()); }
    const clearSel = () => { selection = {pins: new Set(), shapes: new Set()}; };
    const selPins = () => [...selection.pins].map(i => model.pins[i]).filter(Boolean);
    const selShapes = () => [...selection.shapes].map(i => model.shapes[i]).filter(Boolean);
    const visibleItem = x => (model.parts <= 1 || !(x.part > 0) || x.part === gate) && (!model.alternate || x.alt == null || !!x.alt === alt);
    const tag = () => ({...(model.parts > 1 ? {part: gate} : {}), ...(model.alternate ? {alt} : {})});
    function built() { return L.buildSymbol(model); }
    function def() {
      const b = built();
      return {...source, name: meta.name, symbol: filterGate(b.symbol, gate, alt), schDrawing: b.schDrawing || undefined};
    }

    // ---------------- layout
    const bar = el("div", null, "fe-toolbar"); bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Symbol tools");
    const TOOLS = [["select", "Select", "V"], ["pin", "Pin", "P"], ["rect", "Rect", "R"], ["line", "Line", "L"], ["arc", "Arc", "A"], ["circle", "Circle", "C"], ["text", "Text", "T"]];
    const toolButtons = new Map();
    for (const [id, label, key] of TOOLS) {
      const b = ui.editorTool(label, key, () => setTool(id));
      toolButtons.set(id, b); bar.append(b);
    }
    bar.append(el("span", null, "fe-sep"));
    const gates = el("div", null, "se-gates"); bar.append(gates);
    const canvas = el("canvas", null, "fe-canvas se-canvas"); canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Symbol canvas");
    const statusLine = el("div", null, "fe-status"), coords = el("span", null, "fe-coords"), hint = el("span", null, "fe-hint"); statusLine.append(coords, hint);
    const centre = el("div", null, "fe-centre"); centre.append(canvas, statusLine);
    const side = el("aside", null, "fe-side se-side"), tabs = el("div", null, "se-tabs ui-tabs"), pane = el("div", null, "se-pane"), checks = el("div", null, "fe-checks");
    tabs.dataset.strip = "";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Symbol inspector");
    for (const [k, t] of [["props", "Properties"], ["pins", "Pin table"]]) {
      const b = el("button", t, "ui-tab"); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.tab = k;
      b.onclick = () => { tab = k; renderSide(); }; tabs.append(b);
    }
    side.append(tabs, pane, checks);
    const body = el("div", null, "fe-body"); body.append(bar, centre, side);
    const footer = el("div", null, "lib-actions"), saveButton = ui.button("Save", () => save(false), "lib-primary");
    ui.shortcut(saveButton, "Save", "Mod+S");
    footer.append(ui.editorKeys("Rotate pin"), ui.button("Cancel", () => tryClose()), ui.button("Save and place", () => save(true)), saveButton);
    dlg.append(body, footer);
    const stage = ui.stage(canvas, {kind: "schematic", def, overlay, item: () => ({part: gate, alt}), input:{
      tool:()=>tool, undo:doUndo, precision:{
        point:p=>drag?.aim || snapG(p),
        grips(p, consider) {
          for (const i of selection.pins) {
            const pin=model.pins[i], item={type:"pin",index:i,id:"pin-"+i};
            if (pin && visibleItem(pin)) {consider([pin.x,pin.y],item); consider(pinBase(pin),item);}
          }
          for (const i of selection.shapes) {
            const s=model.shapes[i];
            if (s && visibleItem(s)) for (const at of s.points || [[s.x,s.y]]) consider(at,{type:"shape",index:i,id:"shape-"+i});
          }
        }
      }, hit(q){
        const h=hit(q); if(!h)return null;
        const pin=h.type==="pin"&&model.pins[h.index];
        return {...h,id:h.type+"-"+h.index,box:pin?A.bounds([[pin.x,pin.y],pinBase(pin)]):shapeBox(model.shapes[h.index])};
      },selected:h=>!!selection[h.type==="pin"?"pins":"shapes"]?.has(h.index),inspect(h){clearSel();selection[h.type==="pin"?"pins":"shapes"].add(h.index);tab="props";renderSide();stage.render();}
    }});

    // ---------------- geometry
    const freeTouch = () => globalThis.AtriumCanvasInput?.ignoreSnap() || globalThis.AtriumTouchPrecision?.free(canvas);
    const snapG = q => freeTouch() ? q.map(r6) : [r6(A.snap(q[0], G / 2 >= .5 && tool !== "pin" && !(drag?.pins) ? G / 2 : G)), r6(A.snap(q[1], G / 2 >= .5 && tool !== "pin" && !(drag?.pins) ? G / 2 : G))];
    const pinBase = p => { const d = DIR[p.orientation] || [-1, 0], l = p.length ?? 2 * G; return [p.x - d[0] * l, p.y - d[1] * l]; };
    function hit(q) {
      const tol = 5 / stage.scale();
      for (let i = model.pins.length - 1; i >= 0; i--) { const p = model.pins[i]; if (!visibleItem(p)) continue; if (A.nearSegment(q, [p.x, p.y], pinBase(p)) <= tol) return {type: "pin", index: i}; }
      let best = null, bd = tol;
      model.shapes.forEach((s, i) => {
        if (!visibleItem(s)) return;
        let d;
        if (s.kind === "circle") d = Math.abs(Math.hypot(q[0] - s.x, q[1] - s.y) - s.r);
        else if (s.kind === "text") { const sz = s.size || 1.5, w = String(s.text).length * sz * .6; d = q[0] >= s.x - (s.align === "center" ? w / 2 : 0) && q[0] <= s.x + w && q[1] >= s.y - sz && q[1] <= s.y + .3 ? 0 : Infinity; }
        else { const pts = s.closed ? [...s.points, s.points[0]] : s.points; d = Infinity; for (let k = 1; k < pts.length; k++) d = Math.min(d, A.nearSegment(q, pts[k - 1], pts[k])); if (s.fill && s.closed && insidePoly(q, s.points)) d = Math.min(d, tol * .9); }
        if (d <= bd) { bd = d; best = {type: "shape", index: i}; }
      });
      return best;
    }
    function insidePoly(q, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > q[1]) !== (yj > q[1]) && q[0] < (xj - xi) * (q[1] - yi) / (yj - yi) + xi) c = !c; } return c; }
    const shapeBox = s => s.kind === "circle" ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : s.kind === "text" ? [s.x, s.y - (s.size || 1.5), s.x + String(s.text).length * (s.size || 1.5) * .6, s.y] : A.bounds(s.points);
    function move(s, dx, dy) {
      if (s.points) s.points = s.points.map(([x, y]) => [r6(x + dx), r6(y + dy)]); else { s.x = r6(s.x + dx); s.y = r6(s.y + dy); }
      if (s.arc) { s.arc.x = r6(s.arc.x + dx); s.arc.y = r6(s.arc.y + dy); }
    }

    // ---------------- overlay
    function overlay(c, s) {
      const S = s.toScreen;
      c.lineWidth = 1.5; c.strokeStyle = "#0a8f6a";
      for (const p of selPins()) { const a = S([p.x, p.y]), b = S(pinBase(p)); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineWidth = 5; c.globalAlpha = .35; c.stroke(); c.globalAlpha = 1; c.lineWidth = 1.5; c.strokeRect(a[0] - 4, a[1] - 4, 8, 8); }
      for (const sh of selShapes()) { const b = shapeBox(sh); if (!b) continue; const a = S([b[0], b[1]]), z = S([b[2], b[3]]); c.setLineDash([4, 3]); c.strokeRect(a[0] - 3, a[1] - 3, z[0] - a[0] + 6, z[1] - a[1] + 6); c.setLineDash([]); }
      // Hidden pins show as dashed ghosts so they can still be selected.
      c.strokeStyle = "rgba(60,60,160,.6)"; c.setLineDash([3, 3]);
      for (const p of model.pins) if (p.hidden && visibleItem(p)) { const a = S([p.x, p.y]), b = S(pinBase(p)); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.fillStyle = "rgba(60,60,160,.8)"; c.font = "10px " + ui.mono; c.fillText(p.name || p.number, b[0] + 3, b[1] - 3); }
      c.setLineDash([]);
      // Connection points (pin tips) as small crosses, like Altium's hot spots.
      c.strokeStyle = "#b04040"; c.lineWidth = 1;
      for (const p of model.pins) if (visibleItem(p)) { const a = S([p.x, p.y]); c.beginPath(); c.moveTo(a[0] - 3, a[1] - 3); c.lineTo(a[0] + 3, a[1] + 3); c.moveTo(a[0] + 3, a[1] - 3); c.lineTo(a[0] - 3, a[1] + 3); c.stroke(); }
      if (tool === "pin" && screenPointer) {
        const at = snapG(pointer), ghost = {...template, x: at[0], y: at[1]}, a = S(at), b = S(pinBase(ghost));
        c.strokeStyle = "#c08000"; c.lineWidth = 2; c.setLineDash([5, 3]); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
        c.fillStyle = "#c08000"; c.font = "11px " + ui.mono; c.fillText(template.number + (template.name ? " " + template.name : ""), b[0] + 4, b[1] - 4);
      }
      if (drawing) {
        const pts = [...drawing.points, snapG(pointer)];
        c.strokeStyle = "#c08000"; c.setLineDash([5, 3]); c.beginPath();
        if (drawing.kind === "rect") { const a = S(pts[0]), b = S(pts.at(-1)); c.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
        else if (drawing.kind === "circle" || drawing.kind === "arc" && pts.length === 2) { const a = S(pts[0]), b = S(pts.at(-1)); c.arc(a[0], a[1], Math.hypot(b[0] - a[0], b[1] - a[1]), 0, Math.PI * 2); }
        else if (drawing.kind === "arc") { const [cx, cy] = pts[0], r = Math.hypot(pts[1][0] - cx, pts[1][1] - cy), a0 = Math.atan2(pts[1][1] - cy, pts[1][0] - cx) * 180 / Math.PI, a1 = Math.atan2(pts[2][1] - cy, pts[2][0] - cx) * 180 / Math.PI; arcPoints(cx, cy, r, a0, a1).forEach((p, i) => { const q = S(p); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); }); }
        else pts.forEach((p, i) => { const q = S(p); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
        c.stroke(); c.setLineDash([]);
      }
      if (drag?.marquee) { const a = S(drag.from), b = S(drag.to); c.strokeStyle = "#0a8f6a"; c.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
    }

    // ---------------- tools and pointer
    function setTool(id) {
      globalThis.AtriumCamera.stopWheel(stage.view);
      if (drawing?.kind === "line" && drawing.points.length > 1) finishDrawing();
      tool = id; drawing = null;
      if (id === "pin") template.number = nextPinNumber();
      for (const [k, b] of toolButtons) b.setAttribute("aria-pressed", String(k === id));
      canvas.style.cursor = id === "select" ? "default" : "crosshair";
      const help = {select: "Click to select, drag to move on the 2.54 mm grid. Double-click a pin to rename it.", pin: ". {rotate} turns it. The next pin follows below.",
        rect: "Click two corners.", line: "Click points. Double-click or press {enter} to finish.", arc: "Click the centre, the start and the end (counter-clockwise).", circle: "Click the centre, then the radius.", text: "Click to place text."}[id];
      hint.replaceChildren(id === "pin" ? "Click to place pin " + template.number : "", ...shortcutText(help || ""));
      renderSide(); stage.render();
    }
    function nextPinNumber() {
      const nums = model.pins.map(p => String(p.number)), ints = nums.filter(n => /^\d+$/.test(n)).map(Number);
      if (!nums.length) return "1";
      if (ints.length === nums.length) return String(Math.max(...ints) + 1);
      let n = AtriumFootprintEditor.incrementNumber(nums.at(-1)); const used = new Set(nums); while (used.has(n)) n = AtriumFootprintEditor.incrementNumber(n); return n;
    }
    const localPoint = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener("pointermove", e => {
      screenPointer = localPoint(e); pointer = stage.toLocal(screenPointer);
      const at = snapG(pointer); coords.textContent = "X " + at[0].toFixed(2) + "  Y " + at[1].toFixed(2) + " mm  (" + (at[0] / .254).toFixed(0) + ", " + (at[1] / .254).toFixed(0) + " × 10 mil)";
      if (drag?.move) {
        const d = pointer.map((v,k) => freeTouch() ? v-drag.start[k] : A.snap(v-drag.start[k], drag.pins ? G : G/2));
        drag.aim = d.map((v,k)=>drag.start[k]+v);
        if (d[0] || d[1] || drag.moved) {
          if (drag.copy && !drag.moved) {
            const pins = [], shapes = [];
            for (const [i,x,y] of drag.origin.pins) {
              const pin = {...clone(model.pins[i]), nativeId:A.id(), nativeIdOwner:source.id, number:nextPinNumber()};
              delete pin.id;
              pins.push([model.pins.push(pin)-1,x,y]);
            }
            for (const [,s] of drag.origin.shapes) shapes.push([model.shapes.push(clone(s))-1,s]);
            drag.origin = {pins,shapes}; selection = {pins:new Set(pins.map(a=>a[0])),shapes:new Set(shapes.map(a=>a[0]))};
          }
          drag.moved = true;
          for (const [i, x, y] of drag.origin.pins) { model.pins[i].x = r6(x + d[0]); model.pins[i].y = r6(y + d[1]); }
          for (const [i, s0] of drag.origin.shapes) { const s = clone(s0); move(s, d[0], d[1]); model.shapes[i] = s; }
        }
      } else if (drag?.marquee) drag.to = pointer;
      stage.render();
    });
    canvas.addEventListener("pointerleave", () => { screenPointer = null; stage.render(); });
    canvas.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      canvas.focus(); screenPointer = localPoint(e); pointer = stage.toLocal(screenPointer);
      const at = snapG(pointer);
      if (tool === "select") {
        const h = hit(pointer);
        if (h) {
          const key = h.type === "pin" ? "pins" : "shapes";
          const copy=e.pointerType==="touch" && e.ctrlKey;
          if (e.shiftKey || e.metaKey || e.ctrlKey && !copy) { const set = selection[key]; if (set.has(h.index)) set.delete(h.index); else set.add(h.index); }
          else if (!selection[key].has(h.index)) { clearSel(); selection[key].add(h.index); }
          drag = {move: true, copy, start: pointer, before: state(), pins: selection.pins.size > 0, origin: {pins: [...selection.pins].map(i => [i, model.pins[i].x, model.pins[i].y]), shapes: [...selection.shapes].map(i => [i, clone(model.shapes[i])])}};
        } else { if (!e.shiftKey) clearSel(); drag = {marquee: true, from: pointer, to: pointer}; }
        if(!globalThis.AtriumCanvasInput?.isReplay(e))canvas.setPointerCapture?.(e.pointerId); renderSide(); stage.render(); return;
      }
      placeAt(at, e);
    });
    function placeAt(at, e) {
      if (tool === "pin") {
        change(() => { model.pins.push({...clone(template), nativeId:A.id(), nativeIdOwner:source.id, x: at[0], y: at[1], ...(model.parts > 1 ? {part: gate} : {})}); });
        template.number = AtriumFootprintEditor.incrementNumber(template.number);
        if (/\d+$/.test(template.name)) template.name = AtriumFootprintEditor.incrementNumber(template.name);
        hint.replaceChildren("Placed. Next pin " + template.number + ".", ...shortcutText(" Press {escape} to stop placing pins."));
        renderSide(); return;
      }
      if (tool === "text") { change(() => { model.shapes.push({kind: "text", text: "Text", x: at[0], y: at[1], size: 2.032, align: "left", ...tag()}); }); selection = {pins: new Set(), shapes: new Set([model.shapes.length - 1])}; setTool("select"); return; }
      if (!drawing) { drawing = {kind: tool, points: [at]}; stage.render(); return; }
      if (e.detail > 1 && tool === "line") { finishDrawing(); return; }
      drawing.points.push(at);
      if (tool === "rect" || tool === "circle" || (tool === "arc" && drawing.points.length === 3)) finishDrawing();
      stage.render();
    }
    canvas.addEventListener("pointercancel", () => {
      const before=drag?.moved && drag.before; drag=null;
      if(before)restore(before);else stage.render();
    });
    canvas.addEventListener("pointerup", () => {
      if (drag?.move && drag.moved) { undo.push(drag.before); redo.length = 0; refresh(); }
      else if (drag?.marquee) {
        const b = [Math.min(drag.from[0], drag.to[0]), Math.min(drag.from[1], drag.to[1]), Math.max(drag.from[0], drag.to[0]), Math.max(drag.from[1], drag.to[1])];
        if ((b[2] - b[0]) * stage.scale() > 3) {
          model.pins.forEach((p, i) => { if (visibleItem(p) && p.x >= b[0] && p.x <= b[2] && p.y >= b[1] && p.y <= b[3]) selection.pins.add(i); });
          model.shapes.forEach((s, i) => { const r = shapeBox(s); if (visibleItem(s) && r && r[0] >= b[0] && r[2] <= b[2] && r[1] >= b[1] && r[3] <= b[3]) selection.shapes.add(i); });
        }
        renderSide();
      }
      drag = null; stage.render();
    });
    canvas.addEventListener("dblclick", () => {
      if (drawing?.kind === "line") { finishDrawing(); return; }
      const h = hit(pointer);
      if (h?.type === "pin") { tab = "props"; renderSide(); pane.querySelector('input[aria-label="Name"]')?.focus(); }
    });
    function finishDrawing() {
      const d = drawing; drawing = null; if (!d) return;
      change(() => {
        const t = tag();
        if (d.kind === "rect") { const [a, b] = d.points; if (a[0] !== b[0] && a[1] !== b[1]) model.shapes.push({kind: "path", style: "body", closed: true, fill: true, points: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], ...t}); }
        if (d.kind === "line" && d.points.length > 1) model.shapes.push({kind: "path", style: "body", points: d.points, ...t});
        if (d.kind === "circle") { const [a, b] = d.points, r = r6(Math.hypot(b[0] - a[0], b[1] - a[1])); if (r) model.shapes.push({kind: "circle", style: "body", x: a[0], y: a[1], r, ...t}); }
        if (d.kind === "arc") {
          const [c, p, q] = d.points, r = r6(Math.hypot(p[0] - c[0], p[1] - c[1]));
          const start = r6(Math.atan2(p[1] - c[1], p[0] - c[0]) * 180 / Math.PI), end = r6(Math.atan2(q[1] - c[1], q[0] - c[0]) * 180 / Math.PI);
          if (r) model.shapes.push({kind: "path", style: "body", points: arcPoints(c[0], c[1], r, start, end), arc: {x: c[0], y: c[1], r, start, end}, ...t});
        }
      });
    }
    // ---------------- keyboard
    dlg.addEventListener("keydown", e => {
      if (ui.activationKey(e)) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName), mod = e.metaKey || e.ctrlKey, k = e.key;
      if (mod && k.toLowerCase() === "s") { e.preventDefault(); save(false); return; }
      if (typing) { if (k === "Escape") { e.preventDefault(); e.target.blur(); canvas.focus(); } return; }
      if (mod && k.toLowerCase() === "z") { e.preventDefault(); doUndo(!e.shiftKey); return; }
      if (mod && k.toLowerCase() === "y") { e.preventDefault(); doUndo(false); return; }
      if (k === "Escape") { e.preventDefault(); if (drawing) { drawing = null; stage.render(); } else if (tool !== "select") setTool("select"); else if (selection.pins.size || selection.shapes.size) { clearSel(); renderSide(); stage.render(); } else tryClose(); return; }
      if (k === " ") { e.preventDefault(); if (tool === "pin") { template.orientation = ORIENT[(ORIENT.indexOf(template.orientation) + 1) % 4]; stage.render(); } else if (selection.pins.size) change(() => selPins().forEach(p => { p.orientation = ORIENT[(ORIENT.indexOf(p.orientation) + 1) % 4]; })); return; }
      if (k === "Enter" && drawing) { e.preventDefault(); finishDrawing(); return; }
      if (k === "Delete" || k === "Backspace") { e.preventDefault(); change(() => { model.pins = model.pins.filter((_, i) => !selection.pins.has(i)); model.shapes = model.shapes.filter((_, i) => !selection.shapes.has(i)); clearSel(); }); return; }
      if (mod && k.toLowerCase() === "a") { e.preventDefault(); selection = {pins: new Set([...model.pins.keys()].filter(i => visibleItem(model.pins[i]))), shapes: new Set([...model.shapes.keys()].filter(i => visibleItem(model.shapes[i])))}; renderSide(); stage.render(); return; }
      if (k.startsWith("Arrow")) { e.preventDefault(); const st = e.shiftKey ? 5 * G : G, d = {ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st]}[k]; change(() => { for (const p of selPins()) { p.x = r6(p.x + d[0]); p.y = r6(p.y + d[1]); } for (const s of selShapes()) move(s, d[0], d[1]); }); return; }
      if (mod || e.altKey) return;
      const t = TOOLS.find(([, , key]) => key === k.toUpperCase())?.[0];
      if (t) { e.preventDefault(); setTool(t); return; }
      if (k === "f" || k === "F") { e.preventDefault(); stage.fit(); return; }
      if (k === "+" || k === "=") stage.zoom(1.25); if (k === "-") stage.zoom(.8);
    });

    // ---------------- side panel
    const field = ui.propertyFields(), section = ui.editorSection;
    const ELEC = L.ELECTRICAL.map((t, i) => [String(i), t]);
    function pinFields(s, pins, apply) {
      const same = k => pins.every(p => JSON.stringify(p[k]) === JSON.stringify(pins[0][k])) ? pins[0][k] : undefined;
      const set = (k, v) => apply(p => { if (v === undefined || v === false) delete p[k]; else p[k] = v; });
      if (pins.length === 1) { const pr = el("div", null, "fe-pair"); s.append(pr); field(pr, "Number", pins[0].number, v => set("number", String(v).trim())); field(pr, "Name", pins[0].name, v => set("name", String(v))); }
      field(s, "Electrical type", same("electrical") != null ? String(same("electrical")) : "", v => v !== "" && set("electrical", +v), {values: [["", "—"], ...ELEC]});
      const pr = el("div", null, "fe-pair"); s.append(pr);
      field(pr, "Length", same("length") ?? "", v => set("length", v), {number: true, min: 0});
      field(pr, "Orientation", same("orientation") || "", v => v && set("orientation", v), {values: [["", "—"], ["left", "← Left"], ["right", "→ Right"], ["up", "↑ Up"], ["down", "↓ Down"]]});
      const flags = el("div", null, "se-flags"); s.append(flags);
      for (const [k, t, title] of [["hidden", "Hidden", "Hidden pins keep their connection point; use for implicit power pins"], ["inverted", "Inverted (dot)", ""], ["clock", "Clock", ""], ["hideName", "Hide name", ""], ["hideNumber", "Hide number", ""]]) field(flags, t, pins.every(p => p[k]), v => set(k, v || undefined), {check: true, title});
      if (model.parts > 1) field(s, "Gate", same("part") != null ? String(same("part")) : "", v => v !== "" && set("part", +v || undefined), {values: [["", "—"], ["0", "All gates (shared)"], ...Array.from({length: model.parts}, (_, i) => [String(i + 1), "Gate " + gateName(i + 1)])]});
      if (pins.length === 1) { const pq = el("div", null, "fe-pair"); s.append(pq); field(pq, "X", pins[0].x, v => set("x", v), {number: true}); field(pq, "Y", pins[0].y, v => set("y", v), {number: true}); }
    }
    function renderSide() {
      for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
      pane.replaceChildren();
      if (tab === "pins") { pinTable(); return; }
      if (tool === "pin") { const s = section(pane, "New pin"); const pr = el("div", null, "fe-pair"); s.append(pr); field(pr, "Number", template.number, v => { template.number = String(v); }); field(pr, "Name", template.name, v => { template.name = String(v); }); pinFields(s, [template], fn => { fn(template); stage.render(); }); return; }
      const pins = selPins(), shapes = selShapes();
      if (pins.length) { const s = section(pane, pins.length === 1 ? "Pin " + pins[0].number : pins.length + " pins"); pinFields(s, pins, fn => change(() => pins.forEach(fn))); }
      if (shapes.length === 1) {
        const sh = shapes[0], s = section(pane, sh.arc ? "Arc" : sh.kind === "path" ? (sh.closed ? "Rectangle / polygon" : "Line") : sh.kind === "circle" ? "Circle" : "Text");
        if (sh.kind === "text") { field(s, "Text", sh.text, v => change(() => { sh.text = v; })); const pr = el("div", null, "fe-pair"); s.append(pr); field(pr, "Size", sh.size ?? 2.032, v => change(() => { sh.size = v; }), {number: true, min: .1}); field(pr, "Rotation °", sh.angle ?? 0, v => change(() => { sh.angle = v; }), {number: true}); field(s, "Align", sh.align || "left", v => change(() => { sh.align = v; }), {values: ["left", "center", "right"]}); }
        if (sh.arc) { const pr = el("div", null, "fe-pair"); s.append(pr); field(pr, "Radius", sh.arc.r, v => change(() => { sh.arc.r = v; sh.points = arcPoints(sh.arc.x, sh.arc.y, v, sh.arc.start, sh.arc.end); }), {number: true, min: .01});
          const pq = el("div", null, "fe-pair"); s.append(pq); field(pq, "Start °", sh.arc.start, v => change(() => { sh.arc.start = v; sh.points = arcPoints(sh.arc.x, sh.arc.y, sh.arc.r, v, sh.arc.end); }), {number: true}); field(pq, "End °", sh.arc.end, v => change(() => { sh.arc.end = v; sh.points = arcPoints(sh.arc.x, sh.arc.y, sh.arc.r, sh.arc.start, v); }), {number: true}); }
        if (sh.kind === "circle") field(s, "Radius", sh.r, v => change(() => { sh.r = v; }), {number: true, min: .01});
        if (sh.kind !== "text") { field(s, "Line width", sh.width ?? "", v => change(() => { sh.width = v || undefined; }), {number: true, min: 0, placeholder: "0.254"}); field(s, "Filled", sh.fill, v => change(() => { sh.fill = v || undefined; if (v && sh.kind === "path") sh.closed = true; }), {check: true}); }
        if (model.parts > 1) field(s, "Gate", String(sh.part ?? 0), v => change(() => { if (+v) sh.part = +v; else delete sh.part; }), {values: [["0", "All gates"], ...Array.from({length: model.parts}, (_, i) => [String(i + 1), "Gate " + gateName(i + 1)])]});
        if (model.alternate) field(s, "View", sh.alt == null ? "both" : sh.alt ? "alt" : "normal", v => change(() => { if (v === "both") delete sh.alt; else sh.alt = v === "alt"; }), {values: [["both", "Both views"], ["normal", "Normal only"], ["alt", "De Morgan only"]]});
      }
      if (!pins.length && !shapes.length) componentProps();
    }
    function componentProps() {
      const s = section(pane, "Component");
      field(s, "Name", meta.name, v => change(() => { meta.name = String(v).trim(); }));
      const pr = el("div", null, "fe-pair"); s.append(pr);
      field(pr, "Prefix", meta.prefix, v => change(() => { meta.prefix = String(v).trim(); })); field(pr, "Default value", meta.value, v => change(() => { meta.value = v; }));
      field(s, "Description", meta.description, v => change(() => { meta.description = v; }));
      const g = section(pane, "Gates and views");
      const row = el("div", null, "fe-pair"); g.append(row);
      field(row, "Gates", model.parts, v => change(() => { const n = Math.max(1, Math.min(26, Math.round(v))); if (n > 1 && model.parts <= 1) { model.pins.forEach(p => { if (p.part == null) p.part = 1; }); model.shapes.forEach(s => { if (s.part == null && s.style !== "pin") s.part = 1; }); } model.parts = n; if (n <= 1) { model.pins.forEach(p => delete p.part); model.shapes.forEach(s => delete s.part); } gate = Math.min(gate, n); }), {number: true, min: 1});
      field(row, "De Morgan view", model.alternate, v => change(() => { model.alternate = !!v; if (v) model.shapes.forEach(s => { if (s.alt == null && s.style !== "pin") s.alt = false; }); else { model.shapes = model.shapes.filter(s => !s.alt); model.shapes.forEach(s => delete s.alt); alt = false; } }), {check: true});
      if (model.parts > 1) g.append(ui.button("Copy gate " + gateName(gate) + " drawing to every gate", () => change(() => copyGate()), "lib-mini"));
      g.append(el("p", "Pins in gate 0 (\"All gates\") — usually power — appear on every gate. Placed parts pick their gate in the Library panel.", "fe-note"));
      const fpS = section(pane, "Footprint");
      const fps = footprintChoices(ctx.library || []);
      field(fpS, "Use footprint of", "", v => { const d = fps.find(x => x.id === v); if (d) change(() => { source.footprint = clone(d.footprint); }); }, {values: [["", source.footprint ? "Keep " + (source.footprint.name || "current") : "— none —"], ...fps.map(d => [d.id, d.label])]});
      // The current footprint, drawn by the board renderer (AtriumCanvas.preview).
      if (source.footprint && globalThis.AtriumCanvas?.preview) {
        const c = el("canvas", null, "se-fp-preview"); c.setAttribute("role", "img"); c.setAttribute("aria-label", "Footprint " + (source.footprint.name || "") + ", " + (source.footprint.pads || []).length + " pads");
        fpS.append(c, el("p", (source.footprint.name || "Footprint") + " · " + ((n => n + (n === 1 ? " pad" : " pads"))((source.footprint.pads || []).filter(p => !p.thermalVia).length)), "fe-note"));
        requestAnimationFrame(() => { if (c.isConnected) try { AtriumCanvas.preview(c, {footprint: source.footprint}, "pcb"); } catch {} });
      }
      const pm = section(pane, "Parameters");
      for (const [k, v] of Object.entries(meta.parameters)) { const r = el("div", null, "fe-pair se-param"); pm.append(r); field(r, "Name", k, nk => change(() => { const val = meta.parameters[k]; delete meta.parameters[k]; if (String(nk).trim()) meta.parameters[String(nk).trim()] = val; })); field(r, "Value", v, nv => change(() => { meta.parameters[k] = nv; })); }
      pm.append(ui.button("Add parameter", () => change(() => { let k = "Parameter", n = 1; while (k in meta.parameters) k = "Parameter " + ++n; meta.parameters[k] = ""; }), "lib-mini"));
    }
    // "Use footprint of" choices: one entry per distinct footprint (name and pad geometry), built-in
    // duplicates of starter parts left out, sorted by name; a shared name gets its pad count or part name.
    function footprintChoices(library) {
      const C = globalThis.AtriumCatalogue, ids = new Set(library.map(d => d.id));
      let defs = library.filter(d => d.footprint && !d.mirrorOf && d.id !== source.id && !(C && C.hidden(d, ids)));
      if (C) defs = C.uniqueFootprints(defs);
      else { const seen = new Set(); defs = defs.filter(d => { const k = (d.footprint.name || d.name) + "|" + JSON.stringify((d.footprint.pads || []).map(A.terminalGeometry)); if (seen.has(k)) return false; seen.add(k); return true; }); }
      const out = defs.map(d => ({id: d.id, footprint: d.footprint, name: d.footprint.name || d.name, pads: (d.footprint.pads || []).filter(p => !p.thermalVia).length, part: d.name}));
      const byName = new Map(); for (const o of out) byName.set(o.name, (byName.get(o.name) || 0) + 1);
      for (const o of out) { const n = o.pads + (o.pads === 1 ? " pad" : " pads"); o.label = byName.get(o.name) > 1 ? o.name + " (" + n + ", " + o.part + ")" : o.name + " · " + n; }
      return out.sort((a, b) => a.label.localeCompare(b.label, "en", {numeric: true, sensitivity: "base"}));
    }
    function copyGate() {
      const mine = model.shapes.filter(s => s.part === gate);
      model.shapes = model.shapes.filter(s => !(s.part > 0 && s.part !== gate));
      for (let g = 1; g <= model.parts; g++) if (g !== gate) for (const s of mine) model.shapes.push({...clone(s), part: g});
    }
    // ---------------- pin table
    function pinTable() {
      const s = el("div", null, "se-table-wrap");
      const table = el("table", null, "se-table ui-sheet-fields"), head = el("tr");
      table.dataset.checkboxCells = "";
      const cols = [["number", "#"], ["name", "Name"], ["electrical", "Type"], ["orientation", "Side"], ["length", "Len"], ...(model.parts > 1 ? [["part", "Gate"]] : []), ["swapGroup", "Swap"], ["hidden", "Hid"], ["", ""]];
      for (const [, t] of cols) head.append(el("th", t));
      const thead = el("thead"); thead.append(head); table.append(thead);
      const tbody = el("tbody");
      model.pins.forEach((p, i) => {
        const tr = el("tr"); if (selection.pins.has(i)) tr.className = "sel";
        for (const [k] of cols) {
          const td = el("td");
          if (!k) {
            const b = globalThis.AtriumUIKit
              ? AtriumUIKit.iconButton("minus", "Delete pin " + p.number, {size: "sm", run: () => change(() => { model.pins.splice(i, 1); clearSel(); })})
              : ui.button("−", () => change(() => { model.pins.splice(i, 1); clearSel(); }), null, "quiet");
            if (!b.getAttribute("aria-label")) b.setAttribute("aria-label", "Delete pin " + p.number);
            td.append(b);
          }
          else if (k === "electrical") { const sel = el("select"); for (const [v, t] of ELEC) sel.add(new Option(t, v)); sel.value = String(p.electrical ?? 4); sel.onchange = () => change(() => { p.electrical = +sel.value; }); sel.setAttribute("aria-label", "Type of pin " + p.number); td.append(sel); }
          else if (k === "orientation") { const sel = el("select"); for (const [v, t] of [["left", "Left"], ["right", "Right"], ["up", "Top"], ["down", "Bottom"]]) sel.add(new Option(t, v)); sel.value = p.orientation; sel.onchange = () => change(() => { p.orientation = sel.value; }); sel.setAttribute("aria-label", "Side of pin " + p.number); td.append(sel); }
          else if (k === "hidden") { const c = el("input"); c.type = "checkbox"; c.checked = !!p.hidden; c.onchange = () => change(() => { if (c.checked) p.hidden = true; else delete p.hidden; }); c.setAttribute("aria-label", "Hide pin " + p.number); td.append(c); }
          else { const inp = el("input"); inp.value = p[k] ?? ""; inp.setAttribute("aria-label", (k === "number" ? "Number" : k === "name" ? "Name" : k) + " of pin " + (i + 1)); inp.dataset.row = i; inp.dataset.col = k;
            inp.onchange = () => change(() => { if (k === "length") { const v = Number(inp.value); if (v >= 0) p.length = v; } else if (k === "part") { const v = parseInt(inp.value, 10); if (v >= 0) p.part = v; } else if (k === "swapGroup") { const v = inp.value.trim(); if (v) p.swapGroup = v; else delete p.swapGroup; } else p[k] = inp.value; });
            inp.onkeydown = e => { if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); inp.onchange(); const next = table.querySelector('input[data-row="' + (i + (e.key === "ArrowUp" ? -1 : 1)) + '"][data-col="' + k + '"]'); next?.focus(); next?.select(); } };
            inp.onfocus = () => { selection = {pins: new Set([i]), shapes: new Set()}; stage.render(); };
            td.append(inp); }
          tr.append(td);
        }
        tbody.append(tr);
      });
      table.append(tbody); s.append(table);
      // Paste handler: a multi-line paste into any cell replaces from that row down.
      table.addEventListener("paste", e => {
        const text = e.clipboardData?.getData("text/plain") || "";
        if (!/\n|\t/.test(text.trim())) return;
        e.preventDefault();
        const rows = L.pinsFromTable(text), at = +(e.target.dataset?.row ?? model.pins.length);
        change(() => applyRows(rows, at, false));
      });
      pane.append(s);
      const actions = el("div", null, "se-table-actions");
      actions.append(ui.button("Add pin", () => change(() => { const last = model.pins.at(-1); model.pins.push({nativeId:A.id(), nativeIdOwner:source.id, number: nextPinNumber(), name: "", electrical: 4, length: last?.length ?? 2 * G, orientation: last?.orientation || "left", x: last ? last.x : -5.08 - 2 * G, y: last ? r6(last.y + G) : 0, ...(model.parts > 1 ? {part: gate} : {})}); }), "lib-mini"));
      actions.append(ui.button("Copy as TSV", () => globalThis.navigator?.clipboard?.writeText(L.tableFromPins(model.pins, model.parts)), "lib-mini"));
      pane.append(actions);
      const box = section(pane, "Paste or generate from a pin list");
      const ta = el("textarea", null, "se-paste"); ta.rows = 6; ta.placeholder = "Number, Name, Type, Side — paste CSV or TSV from a datasheet or spreadsheet.\n1\tVDD\tpower\n2\tPA0\tio\n3\tGND\tpower";
      ta.setAttribute("aria-label", "Pin list"); ta.spellcheck = false; box.append(ta);
      const parsed = el("p", null, "fe-note"); box.append(parsed);
      ta.oninput = () => { const rows = L.pinsFromTable(ta.value); parsed.textContent = rows.length ? rows.length + " pins: " + rows.slice(0, 6).map(r => r.number + " " + r.name).join(", ") + (rows.length > 6 ? "…" : "") : ""; };
      const acts = el("div", null, "se-table-actions"); box.append(acts);
      acts.append(ui.button("Generate symbol", () => { const rows = L.pinsFromTable(ta.value); if (!rows.length) { parsed.textContent = "Paste at least one pin."; return; } change(() => generate(rows)); stage.fit(); }, "lib-primary"),
        ui.button("Update pins by number", () => { const rows = L.pinsFromTable(ta.value); change(() => applyRows(rows, 0, true)); }, "lib-mini"));
      acts.append(ui.button("Symbol Wizard…", () => { globalThis.AtriumLazy?.need("AtriumSymbolWizard").then(W => W.open({...ctx, library: ctx.library || [], text: ta.value, name: meta.name, prefix: meta.prefix, apply: m => { change(() => { model.pins = m.pins; model.shapes = m.shapes; model.parts = m.parts; model.alternate = false; gate = 1; clearSel(); }); stage.fit(); }}), e => { hint.textContent = e.message; }); }, "lib-mini")); // symwiz: open the wizard on this table
      box.append(el("p", "Generate lays the pins out around a fresh body: power on top, ground at the bottom, inputs left, outputs right, buses together in order. Update keeps positions and changes names and types of matching numbers, adding new pins below.", "fe-note"));
    }
    function applyRows(rows, at, byNumber) {
      if (byNumber) {
        const map = new Map(model.pins.map(p => [String(p.number), p]));
        let y = Math.max(0, ...model.pins.map(p => p.y)) + G;
        for (const r of rows) { const p = map.get(String(r.number)); if (p) { p.name = r.name; p.electrical = r.electrical; if (r.hidden) p.hidden = true; } else { model.pins.push({nativeId:A.id(), nativeIdOwner:source.id, number: r.number, name: r.name, electrical: r.electrical, length: 2 * G, orientation: "left", x: -5.08 - 2 * G, y: r6(y)}); y += G; } }
        return;
      }
      rows.forEach((r, k) => {
        const p = model.pins[at + k];
        if (p) Object.assign(p, {number: r.number, name: r.name, electrical: r.electrical}, r.hidden ? {hidden: true} : {});
        else { const last = model.pins.at(-1); model.pins.push({nativeId:A.id(), nativeIdOwner:source.id, number: r.number, name: r.name, electrical: r.electrical, length: last?.length ?? 2 * G, orientation: last?.orientation || "left", x: last?.x ?? -5.08 - 2 * G, y: r6((last?.y ?? -G) + G)}); }
      });
    }
    function generate(rows) {
      const g = L.symbolFromGates(rows, model.parts > 1 && rows.some(r => r.part > 0) ? model.parts : 1);
      model.pins = g.pins; model.shapes = g.shapes;
      clearSel();
    }
    // ---------------- gates toolbar
    function renderGates() {
      gates.replaceChildren();
      if (model.parts > 1) for (let g = 1; g <= model.parts; g++) { const b = ui.button(gateName(g), () => { gate = g; clearSel(); refresh(); }, "lib-chip"); b.title = "Show gate " + gateName(g); b.setAttribute("aria-pressed", String(g === gate)); gates.append(b); }
      if (model.alternate) { const b = ui.button(alt ? "De Morgan" : "Normal", () => { alt = !alt; clearSel(); refresh(); }, "lib-chip"); b.title = "Switch between the normal and De Morgan views"; b.setAttribute("aria-pressed", String(alt)); gates.append(b); }
    }
    function renderChecks() {
      checks.replaceChildren();
      const k = globalThis.AtriumUIKit;
      const d = {...source, ...meta, symbol: built().symbol}, v = L.validateDef(d);
      const off = model.pins.filter(p => Math.abs(p.x / G - Math.round(p.x / G)) > 1e-6 || Math.abs(p.y / G - Math.round(p.y / G)) > 1e-6);
      const summary = v.errors.length ? v.errors.length + " error(s)" : v.warnings.length || off.length ? (v.warnings.length + (off.length ? 1 : 0)) + " warning(s)" : "All clear";
      const tone = v.errors.length ? "danger" : (v.warnings.length || off.length) ? "warning" : "success";
      const rows = [];
      if (k) {
        for (const e of v.errors) rows.push(k.row({title: e, icon: k.dot("danger"), role: "listitem"}));
        for (const w of v.warnings) rows.push(k.row({title: w, icon: k.dot("warning"), role: "listitem"}));
        if (off.length) rows.push(k.row({title: off.length + " pin tip(s) are off the 2.54 mm grid; wires may not connect.", icon: k.dot("warning"), role: "listitem"}));
        const listEl = rows.length ? k.list(rows, {role: "list", label: "Symbol checks"}) : null;
        const stats = k.statusLine(model.pins.length + " pins" + (model.parts > 1 ? " · " + model.parts + " gates" : "") + (model.alternate ? " · De Morgan" : ""));
        checks.append(k.section("Checks", {quiet: true, actions: [k.badge(summary, tone)]}, ...(listEl ? [listEl, stats] : [stats])));
      } else {
        const ul = el("ul");
        for (const e of v.errors) ul.append(el("li", e, "lvl-error"));
        for (const w of v.warnings) ul.append(el("li", w, "lvl-warning"));
        if (off.length) ul.append(el("li", off.length + " pin tip(s) are off the 2.54 mm grid; wires may not connect.", "lvl-warning"));
        checks.append(ul);
      }
    }
    function heading() { return "Symbol Editor — " + meta.name; }
    function refresh() {
      title.textContent = heading();
      saveButton.textContent = state() === saved ? "Save" : "Save •";
      renderGates(); renderSide(); renderChecks(); stage.render();
    }
    function build() {
      const b = built(), d = {...source, name: meta.name, prefix: meta.prefix, value: meta.value, symbol: b.symbol};
      b.symbol.pins.forEach((p, i) => { const m = model.pins[i]; if (m?.noConnect) p.noConnect = true; if (m?.alternates?.length) p.alternates = m.alternates.slice(); }); // symwiz: keep no-connect and alternate functions
      if (meta.description) d.description = meta.description; else delete d.description;
      if (Object.keys(meta.parameters).length) d.parameters = {...meta.parameters}; else delete d.parameters;
      if (b.schDrawing) d.schDrawing = b.schDrawing; else delete d.schDrawing;
      delete d.sourceSymbolShapes;
      return d;
    }
    function save(place) {
      const d = build(), v = L.validateDef(d, {footprintWarnings: false});
      if (!v.ok) { hint.textContent = v.errors[0]; hint.classList.add("bad"); return; }
      saved = state(); dlg.close(); ctx.commit?.(d, place);
    }
    // Unsaved changes ask first: closing the editor, or a project switch closing its tab (dlg.mayDiscard).
    const mayDiscard = () => state() === saved || typeof confirm !== "function" || confirm("Discard the changes to this symbol?");
    function tryClose() { if (mayDiscard()) dlg.close(); }
    dlg.requestClose = () => tryClose();
    dlg.unsaved = () => state() !== saved;
    dlg.mayDiscard = mayDiscard;
    ui.paletteSurface(dlg, "symbol", canvas, stage, {
      pins: () => model.pins,
      select: i => { clearSel(); gate = model.pins[i].part || gate; selection.pins.add(i); refresh(); },
      hitAt: point => hit(point),
      insert(id, point) {
        if (!dlg.open) return;
        canvas.focus(); setTool(id);
        placeAt(snapG(point), {});
        if (id === "pin") { clearSel(); selection.pins.add(model.pins.length - 1); setTool("select"); }
      },
      commands: () => [
        ...(undo.length ? [{key: "cmd:symbol:undo", kind: "command", label: "Undo", detail: "Symbol Editor", run: () => doUndo()}] : []),
        ...(redo.length ? [{key: "cmd:symbol:redo", kind: "command", label: "Redo", detail: "Symbol Editor", run: () => doUndo(false)}] : [])
      ]
    });
    title.textContent = heading(); // the editor tab takes its title from the heading
    ui.showSurface(dlg);
    setTool("select"); refresh(); stage.observe(); canvas.focus();
    return dlg.editor = {dialog: dlg, model, meta, stage, setTool, build, change, generate: rows => change(() => generate(rows)), setTab: t => { tab = t; renderSide(); }, setGate: g => { gate = g; refresh(); }};
  }
  return Object.freeze({open, arcPoints, filterGate});
})();
