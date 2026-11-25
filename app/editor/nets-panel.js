"use strict";
// Nets panel and net colours (Panels → Nets, View → Net Colour Override F5).
// The dock lists nets on the active board or schematic occurrence. Schematic node
// counts use the compiled membership across sheets. Click a net to highlight
// it, double-click (or Shift+Enter) to zoom to it. The swatch assigns a net colour that
// overrides the copper colour of that net's tracks and ratsnest on the board; colours
// are stored on the board (`doc.netColors`) and are undoable. F5 toggles the override.
//
// Headless API (pure):
//   AtriumNetsPanel.summary(doc, defs, {connections, lengths, classes, hierarchy, instanceId}) → rows
//   AtriumNetsPanel.classOf(classes) → net → class name
//   AtriumNetsPanel.classColours(rows, palette) → {net: colour} for "colour by class"
globalThis.AtriumNetsPanel = (() => {
  const C = globalThis.AtriumNavCommon;
  const A = () => globalThis.Atrium;
  // Distinct, saturated colours that read on the dark board and against copper.
  const PALETTE = ["#ff6b6b", "#ffd166", "#06d6a0", "#4cc9f0", "#b388ff", "#ff9f1c", "#f15bb5", "#9ef01a", "#00bbf9", "#e9c46a", "#ff70a6", "#70d6ff"];

  // ------------------------------------------------------------------ summary
  function classOf(classes) {
    const out = new Map();
    for (const [name, nets] of Object.entries(classes || {})) {
      if (/^all nets$/i.test(name)) continue;
      for (const n of nets || []) if (!out.has(n)) out.set(n, name);
    }
    return out;
  }
  function summary(doc, defs, {
    connections = null, lengths = null, classes = null, hierarchy = null,
    instanceId = /** @type {string | undefined} */ (undefined)
  } = {}) {
    const cls = classOf(classes), rows = [];
    if (doc.kind === "pcb") {
      const conn = connections || globalThis.AtriumConnectivity?.inspect(doc, defs);
      const seen = new Set();
      for (const n of conn?.nets || []) {
        seen.add(n.name);
        const len = lengths?.get?.(n.name);
        rows.push({name:n.name, cls:cls.get(n.name) || "", nodes:n.pads, tracks:n.tracks, vias:n.vias, length:len == null ? null : typeof len === "number" ? len : len.length ?? null,
          unrouted:n.missing, shorted:!!n.shorted});
      }
      // Nets named only on pins (no copper yet) still appear, fully unrouted.
      const pinOnly = new Map();
      for (const i of doc.items) if (i.kind === "part" && i.pinNets) for (const v of Object.values(i.pinNets)) if (v && !seen.has(v)) pinOnly.set(v, (pinOnly.get(v) || 0) + 1);
      for (const [name, count] of pinOnly) rows.push({name, cls:cls.get(name) || "", nodes:count, tracks:0, vias:0, length:null, unrouted:Math.max(0, count - 1), shorted:false});
    } else if (hierarchy) {
      const occurrence = hierarchy.byInstance.get(instanceId);
      const selected = occurrence?.instance.doc === doc ? occurrence : hierarchy.byDoc.get(doc.id);
      if (selected) for (const net of hierarchy.nets) {
        if (!net.local.some(({inst}) => inst === selected.instance)) continue;
        rows.push({name:net.name, cls:cls.get(net.name) || "", nodes:net.pins.length, tracks:0, vias:0,
          wires:net.wires, length:null, unrouted:null, conflict:net.conflict, compiled:net, instanceId:selected.instance.id});
      }
    } else {
      const n = A().connectivity(doc, defs);
      for (const x of n.nets) rows.push({name:x.name, cls:cls.get(x.name) || "", nodes:x.pins, tracks:0, vias:0, wires:x.wires, length:null, unrouted:null, conflict:!!x.conflict});
    }
    const natural = new Intl.Collator("en", {numeric:true});
    rows.sort((a, b) => natural.compare(a.name, b.name));
    return rows;
  }
  function classColours(rows, palette = PALETTE) {
    const byClass = new Map(), out = {};
    for (const r of rows) if (r.cls) {if (!byClass.has(r.cls)) byClass.set(r.cls, palette[byClass.size % palette.length]); out[r.name] = byClass.get(r.cls);}
    return out;
  }

  const pending = new WeakMap();
  function ensureSchematicProject(host) {
    const folder = host.folderProject?.(), purpose = "schematic-connections";
    if (!folder || folder.completeFor(purpose)) return null;
    let load = pending.get(folder);
    if (!load) {
      load = folder.requireClosure({purpose}).finally(() => pending.delete(folder));
      pending.set(folder, load);
    }
    return load;
  }

  let host = null, override = true;
  try {override = globalThis.localStorage?.getItem("atrium-net-colours") !== "0";} catch {}
  const colors = d => d?.netColors && typeof d.netColors === "object" ? d.netColors : {};
  function setOverride(on) {
    override = !!on;
    try {globalThis.localStorage?.setItem("atrium-net-colours", override ? "1" : "0");} catch {}
    C.setChecked("net-colours", override);
    globalThis.AtriumNetsTable?.syncOverride(override);
    host?.invalidate();
    const key = globalThis.AtriumKeymap?.hintFor("net-colours", "pcb");
    host?.info("Net colour override " + (override ? "on" : "off") + (key ? " (" + key + ")" : ""));
  }
  function withTable(use) {
    if (globalThis.AtriumNetsTable) return use(AtriumNetsTable);
    return globalThis.AtriumLazy?.need("AtriumNetsTable").then(use, e => host?.info(e.message));
  }
  function toggle(show) {return withTable(t => t.toggle(host, show));}
  function reveal(net) {return withTable(t => t.reveal(host, net));}

  function attach(h) {
    host = h;
    host.registerAction("nets-panel", () => toggle());
    host.registerAction("net-colours", () => setOverride(!override));
    host.addRenderer(d => {
      if (d.kind !== "pcb" || !override) return null;
      const map = colors(d), keys = Object.keys(map), previewing = globalThis.AtriumNetsTable?.preview();
      if (!keys.length && !previewing) return null;
      const m = new Map(keys.map(k => [k, map[k]]));
      if (previewing) m.set(previewing.net, previewing.value);
      return {netColors:m};
    });
    for (const event of ["change", "document", "folder-owner"]) host.on(event, () => globalThis.AtriumNetsTable?.schedule());
    host.on("highlight", () => globalThis.AtriumNetsTable?.highlight());
    if (typeof document === "undefined") return;
    C.setChecked("net-colours", override);
    const syncUnrouted = () => C.setChecked("unrouted", host.showUnrouted());
    host.on("unrouted", syncUnrouted); syncUnrouted();
  }
  C?.ready(attach);

  return {summary, ensureSchematicProject, classOf, classColours, PALETTE, colors, toggle, reveal, setOverride, override:() => override, attach,
    isOpen:() => globalThis.AtriumNetsTable?.isOpen() || false, rows:() => globalThis.AtriumNetsTable?.rows() || []};
})();
