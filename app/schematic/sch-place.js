"use strict";
// Schematic placement (Altium-style, clean-room): repeat placement with auto-increment,
// the Tab properties popover for the object on the cursor, net label placement without a
// prompt per click, and Mirror X / Mirror Y for parts, wires and graphics.
//
// The editor calls in while a tool is active:
//   beginPart(def)                      a new Place Component session (resets the template)
//   ghostPart(def, project)             {ref, value, mirror} for the floating part
//   decorate(part, def, project)        applies the template to a part about to be placed
//   mirrorGhost(axis, angle)            X/Y while placing a part -> the new ghost angle
//   mirrorFloating(axis)                X/Y while placing a power port, port, off sheet or bus entry
//   placeLabel(p, ctx) / labelGhost(p)  net label tool on schematics
//   placed(mode, opts)                  sch-objects.js after each power port, port or off sheet
//   popover(ctx)                        Tab: the non-modal properties popover
//   mirrorItems(doc, defs, ids, axis, pivot?)  mirror objects in place; returns the count
// A part stores mirroring as `mirror: true` (a flip of the symbol's local X before its
// rotation), which model.js honours in Atrium.world(), so pins, wires and nets follow.
globalThis.AtriumSchPlace = (() => {
  const KEY = "atrium-sch-place";
  let memory = {};
  function readPrefs() {
    try {const raw = globalThis.localStorage?.getItem(KEY); if (raw) return JSON.parse(raw) || {};} catch {}
    return memory;
  }
  function prefs() {
    const p = readPrefs();
    return {autoIncrement:(globalThis.AtriumPref ? AtriumPref.get("general.autoIncrement", p.autoIncrement !== false) : p.autoIncrement) !== false, step:Number.isInteger(p.step) && p.step !== 0 && Math.abs(p.step) < 1000 ? p.step : 1};
  }
  function setPrefs(change) {
    const next = {...readPrefs(), ...change}; memory = next;
    try {globalThis.localStorage?.setItem(KEY, JSON.stringify(next));} catch {}
    return prefs();
  }
  const toggleAutoIncrement = () => { const v = !prefs().autoIncrement; if (!globalThis.AtriumPref) return setPrefs({autoIncrement:v}).autoIncrement; AtriumPref.set("general.autoIncrement", v); return prefs().autoIncrement; };

  // ------------------------------------------------------------------ names
  // The trailing number steps: R1 -> R2, D0 -> D1, NET_A1 -> NET_A2, D09 -> D10. Names
  // without a trailing number, and bus names such as D[0..7], are returned unchanged.
  function increment(text, step = 1) {
    const s = String(text ?? ""), m = /^(.*?)(\d+)$/.exec(s);
    if (!m || /\]$/.test(s)) return s;
    const n = Math.max(0, +m[2] + step), digits = String(n);
    return m[1] + (m[2].length > 1 && m[2][0] === "0" ? digits.padStart(m[2].length, "0") : digits);
  }
  const refsIn = project => new Set((project?.documents || []).flatMap(d => d.items.filter(i => i.kind === "part" && i.ref).map(i => i.ref.toUpperCase())));
  // The first free name from `name`, stepping its trailing number (or appending 1).
  function nextFree(name, used, step = 1) {
    let n = String(name || "U1");
    if (!/\d$/.test(n)) n += "1";
    for (let guard = 0; used.has(n.toUpperCase()) && guard < 100000; guard++) n = increment(n, step > 0 ? step : 1);
    return n;
  }
  const prefixOf = ref => /^(.*?)\d+$/.exec(String(ref || ""))?.[1] ?? String(ref || "").replace(/\?$/, "");

  // ------------------------------------------------------------------ parts
  let part = {def:null, ref:"", value:null, mirror:false};
  function beginPart(def) {part = {def:def?.id || null, ref:"", value:null, mirror:false};}
  const sameDef = def => part.def === (def?.id || null);
  function previewRef(def, project) {
    const used = refsIn(project);
    if (part.ref) return prefs().autoIncrement ? nextFree(part.ref, used, prefs().step) : part.ref;
    const prefix = def?.prefix || "U";
    return prefs().autoIncrement ? (globalThis.Atrium?.nextRef ? Atrium.nextRef(project, prefix) : nextFree(prefix + "1", used)) : prefix + "?";
  }
  function ghostPart(def, project) {
    if (!sameDef(def)) beginPart(def);
    const out = {ref:previewRef(def, project), mirror:part.mirror};
    if (part.value != null) out.value = part.value;
    return out;
  }
  function decorate(item, def, project) {
    if (!sameDef(def)) beginPart(def);
    item.ref = previewRef(def, project);
    if (part.value != null) item.value = part.value;
    // Generic parts (generic-parts-ui.js): the per-part ratings and description go with the value.
    if (part.parameters) item.parameters = JSON.parse(JSON.stringify(part.parameters));
    if (part.mirror) item.mirror = true;
    // The next copy continues from this one (R10 -> R11) once a designator was typed.
    if (part.ref) part.ref = prefs().autoIncrement ? increment(item.ref, prefs().step) : item.ref;
    return item;
  }
  // The popover's template: {ref, value, mirror}; ref "" means the next free designator.
  function setTemplate(change) {for (const k of ["ref", "value", "mirror", "parameters"]) if (change && k in change) part[k] = k === "ref" ? String(change.ref || "").trim() : change[k];}
  function mirrorGhost(axis, angle = 0) {
    part.mirror = !part.mirror;
    return axis === "x" ? (360 - angle) % 360 : (540 - angle) % 360;
  }

  // ------------------------------------------------------------------ power, ports, labels
  const POWER_PRESETS = [["GND", "gnd"], ["VCC", "bar"], ["+3V3", "bar"], ["+5V", "bar"], ["+12V", "bar"], ["AGND", "signal"], ["EARTH", "earth"]];
  // The power-port glyph a net name implies (Altium's convention, and the MCP add_power_port
  // default): returns -> ground styles, negative rails -> arrow, other supplies -> bar.
  // null when the name says nothing, so the current style stays.
  function powerStyleFor(name) {
    const n = String(name ?? "").trim().toUpperCase().replace(/\u2212/g, "-").replace(/[\s_]+/g, "");
    if (!n) return null;
    if (/^(EARTH|PE|FG|PROTECTIVEEARTH)$|^(CHASSIS|CHGND|SHIELD|FRAME)/.test(n)) return "earth";
    if (/^(AGND|GNDA|SGND|GNDS|ANALOGGROUND|SIGNALGROUND)$/.test(n)) return "signal";
    if (/^(GND|VSS|0V$|COM$|GROUND|DGND|PGND)/.test(n)) return "gnd";
    if (/^-|^VEE|^VNEG|^VBB/.test(n)) return "arrow";
    if (/^\+|^\d+(\.\d+)?V|^\d+V\d|^V(CC|DD|BAT|BUS|IN|OUT|REF|SYS|IO|PP|CORE|MOT|AUX|\d)/.test(n)) return "bar";
    return null;
  }

  let lastPower = {text:"GND", style:"gnd"}, names = {port:"PORT1", offsheet:"NET1"}, label = "NetLabel1";
  const power = () => ({...lastPower});
  const lastName = kind => names[kind] || "NET1";
  // After each placement: power ports remember the net; ports and off sheet connectors step.
  function placed(mode, o) {
    if (mode === "power") {lastPower = {text:o.text, style:o.style, ...(o.styleChosen ? {styleChosen:true} : {})}; return o;}
    if (mode === "port" || mode === "offsheet") {
      if (prefs().autoIncrement) o.text = increment(o.text, prefs().step);
      names[mode] = o.text;
    }
    return o;
  }
  function labelGhost(p) {return {id:"preview", kind:"netlabel", x:p[0], y:p[1], text:label};}
  function placeLabel(p, ctx) {
    const item = {id:Atrium.id(), kind:"netlabel", x:p[0], y:p[1], text:label};
    ctx.edit(() => ctx.doc().items.push(item));
    const was = label;
    if (prefs().autoIncrement) label = increment(label, prefs().step);
    ctx.info(was + " placed. Click to place " + label + ". Tab edits the name; Escape or right-click ends.");
    return item;
  }

  // ------------------------------------------------------------------ mirror
  const norm = a => ((Math.round(a) % 360) + 360) % 360;
  function mirrorable(i, kind) {
    if (kind !== "schematic") return false;
    return i.kind === "part" || !!i.points || ["netlabel", "label", "junction", "power", "port", "offsheet", "busentry", "noerc", "sheetsymbol", "textframe", "image"].includes(i.kind);
  }
  function refPoint(i) {return i.points ? i.points[0] : [i.x, i.y];}
  function pivotOf(doc, defs, items) {
    if (items.length === 1 && !items[0].points) return refPoint(items[0]).slice();
    const pts = [];
    for (const i of items) {const b = Atrium.bounds(Atrium.itemPoints(i, defs.get?.(i.def), "schematic")); if (b) pts.push([b[0], b[1]], [b[2], b[3]]);}
    const b = Atrium.bounds(pts) || [0, 0, 0, 0], g = (doc.grid || 1.27) / 2;
    return [Atrium.snap((b[0] + b[2]) / 2, g), Atrium.snap((b[1] + b[3]) / 2, g)];
  }
  // A power port placed directly on a pin follows it only while it serves that pin alone.
  function pinPowerPorts(doc, defs, part, keys, selected) {
    const A = Atrium;
    return doc.items.filter(port => {
      if (port.kind !== "power" || port.locked || selected.has(port.id)) return false;
      const at = [port.x, port.y];
      if (!keys.has(A.pointKey(at))) return false;
      return !doc.items.some(item => {
        if (item === port || item === part) return false;
        if (item.kind === "wire") return item.points.some((p, n) => n && A.nearSegment(at, item.points[n - 1], p) < .00011);
        if (item.kind === "part") return A.pins(item, defs.get(item.def), "schematic").some(pin => A.same(at, pin.at));
        if (item.kind === "junction" || item.kind === "netlabel") return A.same(at, [item.x, item.y]);
        return globalThis.AtriumSchObjects?.netSources(item).some(([point]) => A.same(at, point));
      });
    });
  }
  // Mirror the objects among `ids` about a vertical (axis "x") or horizontal ("y") line
  // through `pivot` (default: a single object's origin, or the selection's centre). Wires
  // that are not mirrored themselves keep their ends on the moved pins.
  function mirrorItems(doc, defs, ids, axis, pivot, touched, {avoidPinShorts = false} = {}) {
    const A = Atrium, set = ids instanceof Set ? ids : new Set(ids);
    const items = doc.items.filter(i => set.has(i.id) && mirrorable(i, doc.kind || "schematic") && !(globalThis.AtriumLabs?.notebookEnabled()===false && A.notebookItemKind(i)));
    if (!items.length) return 0;
    if (touched) for (const item of items) touched.add(item);
    const c = pivot || pivotOf(doc, defs, items), fx = axis === "x";
    const m = v => +(2 * (fx ? c[0] : c[1]) - v).toFixed(6);
    const P = ([x, y]) => fx ? [m(x), y] : [x, m(y)];
    const wires = doc.items.filter(i => i.kind === "wire" && !set.has(i.id));
    for (const i of items) {
      if (i.kind === "part") {
        const a = i.angle || 0, at = P([i.x, i.y]), def = defs.get(i.def);
        const old = A.pins(i, def, "schematic").map(q => q.at), keys = new Set(old.map(A.pointKey));
        const attached = wires.filter(w => keys.has(A.pointKey(w.points[0])) || keys.has(A.pointKey(w.points.at(-1))));
        const saved = attached.map(w => w.points.map(q => q.slice()));
        const power = avoidPinShorts ? pinPowerPorts(doc, defs, i, keys, set) : [];
        const before = attached.length > 1 || power.length ? pinNets(doc, defs, i) : null;
        const moved = A.transformPart({kind:"schematic", items:doc.items, grid:doc.grid}, i, def, {x:at[0], y:at[1], angle:fx ? norm(360 - a) : norm(540 - a), mirror:!i.mirror}, wires, {avoidPinShorts});
        if (touched) for (const obj of moved) touched.add(obj);
        if (!i.mirror) delete i.mirror;
        for (const port of power) {
          const target = P([port.x, port.y]);
          if (!A.same(target, [port.x, port.y])) {
            [port.x, port.y] = target;
            touched?.add(port);
          }
        }
        // Pins that swapped sides drag their wires across each other; when that would join
        // nets that were apart, each wire leaves its pin outward and loops around instead.
        if (before && shorted(before, pinNets(doc, defs, i))) {
          attached.forEach((w, n) => {w.points = saved[n];});
          detour(doc, i, def, old, attached);
          if (touched) for (const wire of attached) touched.add(wire);
        }
        continue;
      }
      if (i.points) {i.points = i.points.map(P); continue;}
      switch (i.kind) {
        case "sheetsymbol": {
          if (fx) i.x = m(i.x + i.w); else i.y = m(i.y + i.h);
          for (const e of i.entries || []) {
            if (fx) {if (e.side === "left" || e.side === "right") e.side = e.side === "left" ? "right" : "left"; else e.offset = +(i.w - e.offset).toFixed(6);}
            else if (e.side === "top" || e.side === "bottom") e.side = e.side === "top" ? "bottom" : "top"; else e.offset = +(i.h - e.offset).toFixed(6);
          }
          break;
        }
        case "textframe": case "image": {
          const x0 = Math.min(i.x, i.x + i.w), y0 = Math.min(i.y, i.y + i.h), w = Math.abs(i.w), h = Math.abs(i.h);
          i.x = fx ? m(x0 + w) : x0; i.y = fx ? y0 : m(y0 + h); i.w = w; i.h = h;
          break;
        }
        default: {
          const at = P([i.x, i.y]); i.x = at[0]; i.y = at[1];
          if (i.kind === "power") {
            const d = i.direction || 0;
            if (fx && (d === 0 || d === 2)) i.direction = 2 - d;
            if (!fx && (d === 1 || d === 3)) i.direction = 4 - d;
          } else if (i.kind === "port" || i.kind === "offsheet") i.angle = fx ? norm(180 - (i.angle || 0)) : norm(-(i.angle || 0));
          else if (i.kind === "busentry") i.angle = fx ? norm(270 - (i.angle || 0)) : norm(90 - (i.angle || 0));
        }
      }
    }
    return items.length;
  }
  function pinNets(doc, defs, part) {
    const c = Atrium.connectivity({kind:"schematic", items:doc.items}, defs);
    return Atrium.pins(part, defs.get(part.def), "schematic").map(q => c.byPin.get(part.id + "/" + q.number) || "");
  }
  // True when two pins on different nets (or unconnected) now share one.
  function shorted(before, after) {
    for (let x = 0; x < after.length; x++) for (let y = x + 1; y < after.length; y++)
      if (after[x] && after[x] === after[y] && before[x] !== before[y]) return true;
    return false;
  }
  // Re-route each wire end from its old pin position to the pin's new one. The wire is cut
  // back one step from the old pin (which the other pin now occupies), keeping any T-joins
  // further along it, and reconnected with a side step (alternating sides, widening).
  function detour(doc, part, def, old, attached) {
    const A = Atrium, now = A.pins(part, def, "schematic").map(q => q.at), g = Math.max(doc.grid || 1.27, 1.27) * 2;
    const moved = new Map(old.map((q, n) => [A.pointKey(q), now[n]]));
    const r6 = q => q.map(c => +c.toFixed(6));
    let k = 0;
    for (const w of attached) for (const end of [0, 1]) {
      const pts = end ? w.points.slice().reverse() : w.points.slice(), O = pts[0], T = moved.get(A.pointKey(O));
      if (!T || A.same(T, O) || pts.length < 2) continue;
      const v = [T[0] - part.x, T[1] - part.y], horizontal = Math.abs(v[0]) >= Math.abs(v[1]);
      const side = k % 2 ? -1 : 1, h = g * (1 + (k >> 1)); k++;
      const adj = pts[1], len = Math.hypot(adj[0] - O[0], adj[1] - O[1]);
      const rest = len > g ? [r6([O[0] + (adj[0] - O[0]) / len * g, O[1] + (adj[1] - O[1]) / len * g]), ...pts.slice(1)] : pts.slice(1);
      const Q = horizontal ? [T[0], T[1] + side * h] : [T[0] + side * h, T[1]], R0 = rest[0];
      const route = [T, Q, horizontal ? [R0[0], Q[1]] : [Q[0], R0[1]], ...rest].map(r6);
      const clean = route.filter((q, n) => !n || !A.same(q, route[n - 1]));
      w.points = end ? clean.reverse() : clean;
    }
  }
  // X / Y on a power port, port, off sheet connector or bus entry on the cursor.
  function mirrorFloating(axis) {
    const s = globalThis.AtriumSchObjects?.floating?.(), fx = axis === "x";
    if (!s) return false;
    if (s.mode === "power") {
      const d = s.direction ?? (["gnd", "signal", "earth"].includes(s.opts.style || "gnd") ? 3 : 1);
      if (fx && (d === 0 || d === 2)) s.direction = 2 - d; else if (!fx && (d === 1 || d === 3)) s.direction = 4 - d; else s.direction = d;
      return true;
    }
    if (s.mode === "port" || s.mode === "offsheet") {s.angle = fx ? norm(180 - (s.angle || 0)) : norm(-(s.angle || 0)); return true;}
    if (s.mode === "busentry") {s.angle = fx ? norm(270 - (s.angle || 0)) : norm(90 - (s.angle || 0)); return true;}
    return false;
  }

  // ------------------------------------------------------------------ No ERC on unused pins
  // Pins ERC would report as unconnected or floating (visible, not No Connect, on no net and
  // not on a sheet entry) on `doc`, limited to the parts in `ids` when given. Uses ERC's own
  // connectivity graph when erc.js is loaded, so the two always agree.
  function unusedPins(doc, defs, ids) {
    const E = globalThis.AtriumERC, only = ids ? new Set(ids) : null, out = [];
    if (E?.graph) {
      const g = E.graph(doc, defs);
      for (const c of g.contacts) {
        if ((only && !only.has(c.i.id)) || c.pin.hidden || c.pin.noConnect || g.noErc.has(c.key)) continue;
        if (g.netOf(c.key)?.name || g.entryGroups.has(g.physicalOf(c.key))) continue;
        out.push({part:c.i, pin:c.pin, at:c.pin.at});
      }
      return out;
    }
    const nets = Atrium.connectivity(doc, defs), marked = new Set(doc.items.filter(i => i.kind === "noerc").map(i => Atrium.pointKey([i.x, i.y])));
    for (const i of doc.items) {
      if (i.kind !== "part" || (only && !only.has(i.id))) continue;
      for (const q of Atrium.pins(i, defs.get(i.def), "schematic"))
        if (!q.hidden && !q.noConnect && !nets.byPin.get(i.id + "/" + q.number) && !marked.has(Atrium.pointKey(q.at))) out.push({part:i, pin:q, at:q.at});
    }
    return out;
  }
  // Place a Generic No ERC marker on each unused pin: returns the new items (already in doc).
  function noErcUnused(doc, defs, ids) {
    const seen = new Set(), items = [];
    for (const u of unusedPins(doc, defs, ids)) {
      const k = Atrium.pointKey(u.at);
      if (seen.has(k)) continue;
      seen.add(k); items.push({id:Atrium.id(), kind:"noerc", x:u.at[0], y:u.at[1]});
    }
    doc.items.push(...items);
    return items;
  }
  // Place › Directives › No ERC on Unused Pins: the selected parts, or the whole sheet.
  function noErcCommand(h) {
    const doc = h.doc();
    if (doc?.kind !== "schematic") {h.info("Open a schematic sheet first."); return 0;}
    const sel = new Set(h.selection?.() || []), parts = doc.items.filter(i => i.kind === "part" && sel.has(i.id));
    const ids = parts.length ? parts.map(i => i.id) : null;
    let added = [];
    if (unusedPins(doc, h.defs(), ids).length) h.edit(() => {added = noErcUnused(doc, h.defs(), ids);});
    const where = parts.length ? (parts.length === 1 ? parts[0].ref || "the selected part" : parts.length + " selected parts") : doc.name;
    h.info(added.length ? "Placed " + added.length + " No ERC marker" + (added.length === 1 ? "" : "s") + " on unused pins of " + where + ". Undo removes them." : "No unused pins on " + where + ".");
    h.redraw?.();
    return added.length;
  }

  // ------------------------------------------------------------------ Tab popover
  let pop = null;
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function closePopover(ctx, focus = true, instant = false) {
    if (!pop) return;
    const box = pop, surface = globalThis.AtriumSurfaceMotion;
    pop = null;
    if (surface && box.classList.contains("ui-popover")) surface.popover(box, false, {instant, done:() => box.remove()});
    else box.remove();
    if (focus) ctx?.canvas?.focus?.();
  }
  // ctx: {tool(), pending(), project(), doc(), draw(), info(), canvas}
  function popover(ctx) {
    const switching = !!pop;
    closePopover(ctx, false, true);
    const tool = ctx.tool(), floating = globalThis.AtriumSchObjects?.floating?.();
    const kind = tool === "place" ? "part" : tool === "label" ? "label" : tool === "sch-place" ? floating?.mode : null;
    if (!kind) return false;
    const box = el("div", null, "sp-pop"); box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Placement properties");
    const form = el("form", null, "ui-dialog-body"); box.append(form);
    const redraw = () => ctx.draw();
    const row = (labelText, input) => {const l = el("label", null, "sp-row ui-field-row"); l.append(el("span", labelText), input); input.setAttribute("aria-label", labelText); form.append(l); return input;};
    const text = (labelText, value, set, placeholder) => {
      const i = el("input", null, "ui-field"); i.type = "text"; i.value = value ?? ""; i.autocomplete = "off"; i.spellcheck = false; if (placeholder) i.placeholder = placeholder;
      i.oninput = () => {set(i.value); redraw();}; return row(labelText, i);
    };
    const select = (labelText, value, options, set) => {
      const s = el("select", null, "ui-field"); for (const [v, t] of options) s.add(new Option(t, v)); s.value = value; s.onchange = () => {set(s.value); redraw();}; return row(labelText, s);
    };
    const check = (labelText, value, set) => {const i = el("input", null, "ui-checkbox"); i.type = "checkbox"; i.checked = !!value; i.onchange = () => {set(i.checked); redraw();}; return row(labelText, i);};
    const S = globalThis.AtriumSchObjects;
    let title = "Placement";
    switch (kind) {
      case "part": {
        const def = ctx.pending(); if (!sameDef(def)) beginPart(def);
        title = "Component · " + (def?.name || "");
        text("Designator", part.ref, v => {part.ref = v.trim();}, ghostPart(def, ctx.project()).ref);
        text("Comment", part.value ?? def?.value ?? def?.name ?? "", v => {part.value = v;});
        check("Mirrored", part.mirror, v => {part.mirror = v;});
        break;
      }
      case "label": title = "Net label"; text("Net name", label, v => {if (v.trim()) label = v.trim();}); break;
      case "power": {
        title = "Power port";
        const quick = el("div", null, "sp-quick");
        let net;
        for (const [t, style] of POWER_PRESETS) {
          const b = el("button", t, "ui-button sp-quick-button"); b.type = "button"; b.dataset.size = "sm";
          b.onclick = () => {floating.opts.text = t; floating.opts.style = style; floating.direction = undefined; lastPower = {text:t, style}; chosen = false; delete floating.opts.styleChosen; net.value = t; styleSel.value = style; ctx.info("Click to place " + t + ". Enter continues."); redraw();};
          quick.append(b);
        }
        form.append(quick);
        // Typing a net name picks the matching glyph (GND -> ground, +3V3 -> bar) until the
        // user chooses a style here; a preset button sets both and re-arms following.
        let chosen = !!floating.opts.styleChosen;
        net = text("Net", floating.opts.text, v => {
          if (!v.trim()) return;
          floating.opts.text = v.trim(); lastPower.text = v.trim();
          const auto = chosen ? null : powerStyleFor(v);
          if (auto && auto !== floating.opts.style) {floating.opts.style = auto; floating.direction = undefined; lastPower.style = auto; styleSel.value = auto;}
        });
        const styleSel = select("Style", floating.opts.style || "gnd", Object.entries(S?.POWER_TITLES || {gnd:"Power ground"}), v => {floating.opts.style = v; floating.direction = undefined; lastPower.style = v; chosen = floating.opts.styleChosen = lastPower.styleChosen = true;});
        check("Show net name", floating.opts.showName !== false, v => {floating.opts.showName = v;});
        break;
      }
      case "port": case "offsheet": {
        title = kind === "port" ? "Port" : "Off sheet connector";
        text("Name", floating.opts.text, v => {if (v.trim()) {floating.opts.text = v.trim(); names[kind] = v.trim();}});
        select("I/O type", Atrium.offsheetIO(floating.opts.io), (S?.IO || ["unspecified"]).map(v => [v, v[0].toUpperCase() + v.slice(1)]), v => {floating.opts.io = v;});
        break;
      }
      case "text": title = "Text string"; text("Text", floating.opts.text, v => {if (v) floating.opts.text = v;}); break;
      default: return false;
    }
    // Net names complete as they are typed, in the project's style: Tab takes the faint suggestion (naming.js).
    const named = {label:"netlabel", power:"power", port:"port", offsheet:"offsheet"}[kind], nameField = named && form.querySelector("input[type=text]");
    if (nameField) globalThis.AtriumLazy?.need?.("AtriumNaming").then(N => N.attach(nameField, {kind:named, project:ctx.project}), () => {});
    form.prepend(el("h3", title, "ui-dialog-title"));
    check("Auto-increment", prefs().autoIncrement, v => {setPrefs({autoIncrement:v});});
    const go = el("button", "Continue placing", "ui-button"); go.type = "submit"; go.dataset.variant = "primary";
    const actions = el("div", null, "ui-dialog-actions sp-actions"); actions.append(go); form.append(actions);
    form.append(el("p", "Enter continues · Space rotates · X/Y mirror", "sp-note"));
    form.onsubmit = e => {e.preventDefault(); closePopover(ctx); ctx.info("Click to place. Escape or right-click ends.");};
    box.addEventListener("keydown", e => {if (e.key === "Escape") {e.preventDefault(); e.stopPropagation(); closePopover(ctx);}});
    // Tab while placing shows the floating object's properties in the Properties pane, as Tab while
    // routing does on boards (no popover over the canvas). Without the pane (headless), it floats.
    // The next Properties refresh (a placement click, a selection) replaces it, as it ends the popover.
    const pane = document.getElementById("inspector");
    if (pane) {
      box.classList.add("sp-docked", "inspect-section"); box.setAttribute("role", "region");
      const D = globalThis.AtriumDock, at = D?.locate?.(D.current?.(), "properties");
      if (at && (at.group.active !== "properties" || document.body.classList.contains("hide-" + at.where))) D.toggle?.("properties");
      else if (!at && document.body.classList.contains("hide-right")) globalThis.AtriumNavHost?.act?.("toggle-right");
      // Settle deferred Properties before adding the temporary placement controls.
      globalThis.AtriumNavHost?.revealInspector?.();
      pane.prepend(box); pane.scrollTop = 0;
    } else {
      const r = ctx.canvas?.getBoundingClientRect?.() || {left:0, top:0};
      box.classList.add("ui-popover");
      box.style.left = Math.round(r.left + 14) + "px"; box.style.top = Math.round(r.top + 14) + "px";
      document.body.append(box);
      globalThis.AtriumSurfaceMotion?.popover(box, true, {instant:switching});
    }
    pop = box;
    // Placing again (a click on the canvas) closes the popover; the click still places.
    ctx.canvas?.addEventListener?.("pointerdown", () => closePopover(ctx, false), {once:true});
    const first = form.querySelector("input[type=text],select"); first?.focus(); first?.select?.();
    return true;
  }

  function mirrorCommand(action,{doc,defs,pcb,tool,pending,paste,drag,movingObject,pointer,selection,ghostAngle,
    setGhostAngle,edit,invalidateViews,makeTranslation,draw,info}) {
    const axis = action === "mirror-x" ? "x" : "y", word = axis === "x" ? "horizontally" : "vertically";
    if (pcb()) {info("Mirror X/Y is for schematics. On boards, L flips a component to the other side."); return;}
    if (tool === "place" && pending) {setGhostAngle(mirrorGhost(axis,ghostAngle)); info("Mirrored " + word + "."); draw(); return;}
    if (tool === "sch-place") {info(mirrorFloating(axis) ? "Mirrored " + word + "." : "This object does not mirror."); draw(); return;}
    if (tool === "paste" && paste) {
      mirrorItems({kind:"schematic",grid:doc().grid,items:paste.items},paste.defs,new Set(paste.items.map(item => item.id)),axis,[0,0]);
      paste.bounds = Atrium.docBounds({...doc(),outline:[],items:paste.items},paste.defs);
      draw();
      return;
    }
    if (drag?.kind === "move" && drag.before && !drag.segment) {
      const touched = drag.mirrorItems ??= new Set();
      for (const item of drag.translation.affected) touched.add(item);
      drag.translation.apply(0,0);
      drag.translation.finish();
      mirrorItems(doc(),defs(),selection,axis,drag.anchor,touched,{avoidPinShorts:true});
      invalidateViews(doc());
      drag.lastDelta = null;
      drag.translation = makeTranslation(drag.frameOnly);
      if (pointer) drag.translation.apply(...drag.anchor.map((v,k) => Atrium.snap(v+pointer[k]-drag.origin[k],doc().grid)-v));
      invalidateViews(doc());
      info("Mirrored " + word + ".");
      draw();
      return;
    }
    const ids = tool === "move-object" && movingObject ? new Set([movingObject.item.id]) : selection;
    if (!ids.size) {info("Select parts, wires or graphics to mirror. While placing or dragging, press X or Y."); return;}
    const touched = new Set();
    let count = 0;
    edit(() => {count = mirrorItems(doc(),defs(),ids,axis,undefined,touched,{avoidPinShorts:true});},undefined,touched);
    info(count ? count + (count === 1 ? " object" : " objects") + " mirrored " + word + "." : "Nothing in the selection mirrors.");
  }

  return Object.freeze({prefs, setPrefs, toggleAutoIncrement, increment, nextFree, prefixOf, refsIn, beginPart, ghostPart, decorate, setTemplate, mirrorGhost,
    power, powerStyleFor, unusedPins, noErcUnused, noErcCommand, lastName, placed, labelGhost, placeLabel, label:() => label, setLabel:t => {label = String(t);}, POWER_PRESETS,
    mirrorItems, mirrorFloating, mirrorCommand, popover, closePopover:() => closePopover(null, false), isOpen:() => !!pop?.isConnected});
})();
// Edit › Auto-increment toggle, registered once the navigation host exists.
globalThis.AtriumNavHost?.registerAction?.("sch-auto-increment", () => {
  const on = AtriumSchPlace.toggleAutoIncrement();
  AtriumNavHost.info("Auto-increment on placement " + (on ? "on: designators and labels step after each click." : "off: each copy keeps the same name."));
});
