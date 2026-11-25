"use strict";

// Interactive placement of the schematic objects in sch-objects.js (Place › Power Port, Port, Off
// Sheet Connector, Sheet Symbol / Entry, Bus, Bus Entry, No ERC, Text, Text Frame, Note, Line,
// Rectangle, Arc, Polygon, Image) and the hierarchy commands. Lazy: sch-objects.js forwards
// command(), click(), preview(), finish(), rotate() and cancel() here once it has loaded.
globalThis.AtriumSchObjectTools = (() => {
  const A = Atrium, S = AtriumSchObjects;
  const {POWER, COMMANDS, make, layoutEntries, portsOf, fitSymbol, busEntryEnd, syncEntries} = S;
  const {el, button} = S.toolHost;
  let state = null, ctx = null;
  let formRequest = 0;
  function withForms(show) {
    const request = ++formRequest, owner = ctx, doc = owner.doc();
    const run = forms => show(forms, {...owner, el, button});
    if (globalThis.AtriumSchObjectForms) return run(globalThis.AtriumSchObjectForms);
    return globalThis.AtriumLazy?.need("AtriumSchObjectForms").then(forms => {
      if (request === formRequest && owner.doc() === doc) return run(forms);
      return null;
    });
  }
  const ask = (title, fields, options = {}) => withForms((forms, host) => forms.ask(host, title, fields, options));
  const snapTo = (p, g) => p.map(v => A.snap(v, g));
  function begin(mode, opts = {}, prompt) {
    ctx.setTool("sch-place");
    state = {mode, opts, points:[], angle:opts.angle || 0, direction:opts.direction};
    // The status bar's tool name (editor toolName) was set before this state existed: name it now.
    {const tv = typeof document !== "undefined" && document.getElementById("tool-value"); if (tv) tv.textContent = "Place " + (COMMANDS["sch-" + mode] || {sheetsymbol:"sheet symbol", busentry:"bus entry", entry:"sheet entry", textframe:"text frame"}[mode] || mode).toLowerCase();}
    ctx.info((prompt || "Click to place " + (COMMANDS["sch-" + mode] || mode).toLowerCase() + ".") + (mode === "frame" ? " Escape cancels." : " Space rotates. Escape or right-click ends."));
    ctx.draw();
  }
  async function editNotebookObject(owner, item) {
    if(globalThis.AtriumLabs?.notebookEnabled()===false)return;
    const doc = owner.doc(), project = owner.project(), lazy = globalThis.AtriumLazy;
    /** @type {[string, (ui: any, live: any) => any]} */
    const tasks = item.kind==="image" && item.asset ? ["AtriumNotebookImageUI",(ui,live)=>ui.edit(live)] :
      item.widget ? ["AtriumSheetWidgetEditor",(ui,live)=>ui.open(live.id)] :
      item.calculation ? ["AtriumCalculationSheet",(ui,live)=>ui.compose(globalThis.AtriumNavHost,live)] :
      item.richText ? ["AtriumRichText",(ui,live)=>ui.edit(live)] :
      ["AtriumMathEditor",(ui,live)=>ui.open({context:{host:owner,docId:doc.id},itemId:live.id})];
    const [module,open] = tasks, ui = await lazy.need(module);
    if (owner.doc() !== doc || owner.project() !== project) return;
    const live = doc.items.find(row=>row.id===item.id);
    if (live && globalThis.AtriumLabs?.notebookEnabled()!==false) return open(ui,live);
  }
  async function command(a, c, target) {
    if (a === "edit-notebook-object") return editNotebookObject(c,target);
    ++formRequest; ctx = c;
    const doc = c.doc(), project = c.project();
    if (doc.kind !== "schematic" && a !== "sch-hierarchy-up") {c.info("Open a schematic sheet first."); return;}
    switch (a) {
      // Repeat placement (sch-place.js): no dialog. The tool stays armed after each click;
      // Tab on the cursor edits the net, name and style (with power presets).
      case "sch-power": {
        const r = globalThis.AtriumSchPlace?.power?.() || {text:"GND", style:"gnd"};
        begin("power", {text:r.text, style:Object.hasOwn(POWER, r.style) ? r.style : "gnd", ...(r.styleChosen ? {styleChosen:true} : {})}, "Click to place " + r.text + ". Tab edits the net and style;");
        return;
      }
      case "sch-port": case "sch-offsheet": {
        const port = a === "sch-port", text = globalThis.AtriumSchPlace?.lastName?.(port ? "port" : "offsheet") || (port ? "PORT1" : "NET1");
        begin(port ? "port" : "offsheet", {text, io:"unspecified"}, "Click to place " + text + ". Tab edits the name and I/O type;");
        return;
      }
      case "sch-sheet-symbol": return withForms((forms, host) => forms.sheetSymbol(host, begin));
      case "sch-sheet-entry": begin("entry", {}, "Click the border of a sheet symbol to add an entry."); return;
      case "sch-bus": begin("bus", {}, "Click to start the bus. Click adds a corner; double-click, Escape or right-click finishes."); return;
      case "sch-bus-entry": begin("busentry", {}, "Click to place a bus entry."); return;
      case "sch-noerc": begin("noerc", {}, "Click a pin or wire end to place a No ERC marker."); return;
      case "sch-text": {
        const r = await ask("Place text", [{key:"text", label:"Text", value:"Text"}]);
        if (r?.text) begin("text", {text:r.text}); return;
      }
      case "sch-frame": begin("frame", {}, "Click the first corner, then the opposite corner."); return;
      case "sch-textframe": case "sch-note": begin(a === "sch-note" ? "note" : "textframe", {}, "Click the first corner, then the opposite corner."); return;
      case "sch-line": begin("line", {}, "Click to start the line. Click adds a vertex; Escape or right-click finishes."); return;
      case "sch-polygon": begin("polygon", {}, "Click the polygon's vertices. Escape or right-click closes it."); return;
      case "sch-rect": begin("rect", {}, "Click the first corner, then the opposite corner."); return;
      case "sch-arc": begin("arc", {}, "Click the arc centre, then its start, then its end."); return;
      case "sch-image": {
        const host=globalThis.AtriumNavHost;
        if (host?.folderProject?.() && globalThis.AtriumLabs?.notebookEnabled() !== false) {
          const scope=globalThis.AtriumNotebookImageDrop.capture(host);
          try {
            const ui=await AtriumLazy.need("AtriumNotebookImageUI");
            return scope.current()&&await ui.insert({host,signal:scope.signal});
          } finally {scope.close();}
        }
        const file = await c.pickFile?.([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > 4e6) {c.info("Images larger than 4 MB are not embedded."); return;}
        let bin = ""; for (let n = 0; n < bytes.length; n += 32768) bin += String.fromCharCode(...bytes.subarray(n, n + 32768));
        const ext = (/\.(\w+)$/.exec(file.name)?.[1] || "png").toLowerCase(), type = {jpg:"jpeg", jpeg:"jpeg", svg:"svg+xml", gif:"gif", webp:"webp"}[ext] || "png";
        begin("image", {src:"data:image/" + type + ";base64," + btoa(bin)}, "Click the first corner, then the opposite corner.");
        return;
      }
      case "sch-hierarchy-up": {
        const H = globalThis.AtriumHierarchy, parent = target?.parent || H?.parentOf(project, doc.id);
        if (!parent) {c.info("This sheet is at the top of the hierarchy."); return;}
        c.selectDocument(parent.doc.id); c.choose?.(parent.symbol.id, true);
        const port = target?.port;
        c.info("Up to " + parent.doc.name + (port ? (parent.symbol.entries.some(e => e.name === port.text) ? " · entry " : " · no entry named ") + port.text : ""));
        return;
      }
      case "sch-hierarchy-down": {
        const s = target?.symbol || c.selected?.();
        if (s?.kind !== "sheetsymbol") {c.info("Select a sheet symbol, or double-click one."); return;}
        const child = project.documents.find(d => d.id === s.sheet);
        if (!child) {c.info("The child sheet of " + s.name + " is missing. Choose it in Properties."); return;}
        c.selectDocument(child.id);
        if (target?.entry) {
          const port = child.items.find(i => (i.kind === "port" || i.kind === "netlabel" && i.schPaint?.type === "port") && i.text === target.entry.name);
          if (port) c.choose?.(port.id, true);
        }
        c.info("Down to " + child.name + (S.repeatOf(s) ? " (channel 1 of " + s.name + ")" : "")); return;
      }
      case "sch-sync-entries": {
        const s = c.selected?.(), child = s?.kind === "sheetsymbol" && project.documents.find(d => d.id === s.sheet);
        if (!child) {c.info("Select a sheet symbol whose child sheet exists."); return;}
        let r; c.edit(() => {r = syncEntries(s, child);});
        c.info((r.added.length ? "Added " + r.added.join(", ") + ". " : "Entries match the child's ports. ") + (r.unmatched.length ? "No port for " + r.unmatched.join(", ") + "." : ""));
        return;
      }
      case "sch-hop-overs": c.edit(() => {if (doc.hopOvers) delete doc.hopOvers; else doc.hopOvers = true;}); c.info(doc.hopOvers ? "Hop-overs on" : "Hop-overs off"); return;
    }
  }
  // A bus entry meets the nearest bus: the cursor's end turns (keeping the user's angle when it
  // fits) so the far end lands on a bus; a click on the bus itself puts the bus end there.
  function fitEntry(p, angle = 0) {
    const buses = ctx?.doc?.()?.items.filter(i => i.kind === "bus" && i.points?.length > 1) || [];
    if (!buses.length) return {at:p, angle};
    const onBus = q => buses.some(b => b.points.some((v, n) => n && A.nearSegment(q, b.points[n - 1], v) < 1e-3));
    const order = [angle, ...[0, 90, 180, 270].filter(a => a !== angle)];
    for (const a of order) if (onBus(busEntryEnd({x:p[0], y:p[1], angle:a}))) return {at:p, angle:a};
    if (onBus(p)) for (const a of order) {
      const e = busEntryEnd({x:p[0], y:p[1], angle:a}), at = [2 * p[0] - e[0], 2 * p[1] - e[1]];
      if (!onBus(at)) return {at, angle:a};
    }
    return {at:p, angle};
  }
  function rect(a, b) {return {x:Math.min(a[0], b[0]), y:Math.min(a[1], b[1]), w:Math.abs(b[0] - a[0]), h:Math.abs(b[1] - a[1])};}
  function arcPoints(c, s, e) {
    const r = Math.hypot(s[0] - c[0], s[1] - c[1]), a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
    let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
    // Counterclockwise on screen (Altium arcs run from start to end anticlockwise).
    if (a1 >= a0) a1 -= Math.PI * 2;
    if (Math.abs(a1 - a0) < 1e-6) a1 = a0 - Math.PI * 2;
    const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
    return Array.from({length:n + 1}, (_, k) => {const t = a0 + (a1 - a0) * k / n; return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)].map(v => Math.round(v * 1e4) / 1e4);});
  }
  function preview(p) {
    if (!state || !p) return null;
    const s = state, o = s.opts, P = s.points;
    switch (s.mode) {
      case "power": return make("power", p, {...o, direction:s.direction});
      case "port": case "offsheet": return make(s.mode, p, {...o, angle:s.angle});
      case "sheetsymbol": return {...make("sheetsymbol", p, o), id:"preview"};
      case "busentry": {const f = fitEntry(p, s.angle); return make("busentry", f.at, {angle:f.angle});}
      case "noerc": return make("noerc", p);
      case "text": return {id:"preview", kind:"label", x:p[0], y:p[1], text:o.text, angle:s.angle};
      case "bus": return P.length ? make("bus", p, {points:[...P, ...A.pathBetween(P.at(-1), p).slice(1)]}) : null;
      case "line": case "polygon": return P.length ? {id:"preview", kind:"graphic", points:[...P, p], ...(s.mode === "polygon" ? {closed:true} : {})} : null;
      case "frame": case "rect": case "textframe": case "note": case "image": {
        if (!P.length) return null;
        const r = rect(P[0], p);
        if (s.mode === "frame") return make("frame", [r.x, r.y], r);
        if (s.mode === "rect") return {id:"preview", kind:"graphic", points:[[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y]], closed:true};
        return s.mode === "image" ? make("image", [r.x, r.y], {w:r.w, h:r.h, src:o.src}) : make("textframe", [r.x, r.y], {w:r.w, h:r.h, text:"", note:s.mode === "note"});
      }
      case "arc":
        if (P.length === 1) return {id:"preview", kind:"graphic", points:[P[0], p]};
        if (P.length === 2) return {id:"preview", kind:"graphic", points:arcPoints(P[0], P[1], p)};
        return null;
    }
    return null;
  }
  function push(item) {ctx.edit(() => ctx.doc().items.push(item)); return item;}
  async function click(p) {
    if (!state) return;
    const s = state, o = s.opts, P = s.points, doc = ctx.doc();
    switch (s.mode) {
      case "power": {
        const item = push(make("power", p, {...o, direction:s.direction}));
        const macros = globalThis.AtriumMacros;
        if (macros && doc.items.includes(item)) {
          const defs = ctx.defs(), matches = [];
          for (const part of doc.items) if (part.kind === "part") {
            for (const pin of A.pins(part, defs.get(part.def), "schematic"))
              if (A.same(p, pin.at)) matches.push({part, pin});
          }
          if (matches.length === 1) {
            const [{part, pin}] = matches;
            macros.recordCurrent("butter.macros.place-power-port", {ids:[part.id], pin:String(pin.number),
              net:item.text, style:item.style, direction:item.direction, showName:item.showName}, {id:item.id}, "write");
          }
        }
        s.last = o;
        globalThis.AtriumSchPlace?.placed(s.mode, o);
        break;
      }
      case "port": case "offsheet": push(make(s.mode, p, {...o, angle:s.angle})); globalThis.AtriumSchPlace?.placed(s.mode, o); ctx.info(o.text + " next. Tab edits; Escape or right-click ends."); break;
      case "busentry": {const f = fitEntry(p, s.angle); push(make("busentry", f.at, {angle:f.angle})); break;}
      case "noerc": push(make("noerc", p)); break;
      case "text": push({id:A.id(), kind:"label", x:p[0], y:p[1], text:o.text, ...(s.angle ? {angle:s.angle} : {})}); break;
      case "sheetsymbol": {
        const child = ctx.project().documents.find(d => d.id === o.sheet), item = make("sheetsymbol", p, {name:o.name, sheet:o.sheet});
        item.entries = layoutEntries(portsOf(child)); fitSymbol(item, {snug:true});
        push(item); ctx.setTool("select"); ctx.choose?.(item.id); ctx.info(item.name + " placed" + (item.entries.length ? " with " + item.entries.length + " entries" : "") + ".");
        break;
      }
      case "entry": return withForms((forms, host) => forms.sheetEntry(host, p));
      case "bus": case "line": case "polygon":
        if (P.length && A.same(P.at(-1), p)) {finish(); return;}
        if (s.mode === "bus" && P.length) P.push(...A.pathBetween(P.at(-1), p).slice(1)); else P.push(p);
        ctx.draw(); break;
      case "frame": case "rect": case "textframe": case "note": case "image": {
        if (!P.length) {P.push(p); ctx.draw(); return;}
        const r = rect(P[0], p); s.points = [];
        if (r.w < 1e-6 || r.h < 1e-6) {ctx.info("Click a different opposite corner."); return;}
        if (s.mode === "frame") {
          const answer = await ask("Place frame", [{key:"name", label:"Name", value:"Frame", required:true, maxLength:300}]);
          if (!answer?.name || ctx.doc() !== doc || state !== s) return;
          const item = make("frame", [r.x, r.y], {...r, text:answer.name});
          ctx.edit(() => doc.items.push(item), "Place frame", [item]);
          ctx.setTool("select"); ctx.choose?.(item.id); break;
        }
        if (s.mode === "rect") {push({id:A.id(), kind:"graphic", points:[[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y]], closed:true}); break;}
        if (s.mode === "image") {push(make("image", [r.x, r.y], {w:r.w, h:r.h, src:o.src})); ctx.setTool("select"); break;}
        const t = await ask(s.mode === "note" ? "Note" : "Text frame", [{key:"text", label:"Text", value:"", type:"textarea"}]);
        if (t) push(make("textframe", [r.x, r.y], {w:r.w, h:r.h, text:t.text, note:s.mode === "note"}));
        break;
      }
      case "arc":
        P.push(p);
        if (P.length === 3) {
          if (A.same(P[0], P[1])) {s.points = []; ctx.info("The start must differ from the centre."); return;}
          push({id:A.id(), kind:"graphic", points:arcPoints(...P)}); s.points = [];
        } else ctx.draw();
        break;
    }
  }
  // Escape / right-click: finish a multi-click object. True when something was finished.
  function finish() {
    if (!state || !state.points.length) return false;
    const s = state, P = s.points;
    s.points = [];
    if (s.mode === "bus" && P.length > 1) push(make("bus", P[0], {points:P}));
    else if (s.mode === "line" && P.length > 1) push({id:A.id(), kind:"graphic", points:P});
    else if (s.mode === "polygon" && P.length > 2) push({id:A.id(), kind:"graphic", points:[...P, P[0]], closed:true, fill:true});
    else ctx.draw();
    return true;
  }
  function rotate(step) {
    if (!state) return false;
    if (state.mode === "power") state.direction = (((state.direction ?? (["gnd", "signal", "earth"].includes(state.opts.style) ? 3 : 1)) + (step < 0 ? 1 : 3)) % 4);
    else state.angle = ((state.angle || 0) + (step < 0 ? 270 : 90)) % 360;
    return true;
  }
  const cancel = () => {++formRequest; state = null;};
  const active = () => !!state;
  return {command, click, preview, finish, rotate, cancel, active, floating: () => state, arcPoints};
})();
