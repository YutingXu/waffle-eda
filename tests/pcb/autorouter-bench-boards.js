"use strict";
// Benchmark boards for the autorouter (tests/pcb/autorouter-bench.cjs). Not a test suite on its
// own (a .js file, so scripts/test-jsc.sh does not run it): it defines
// globalThis.AtriumBenchBoards, also used by the dense routing test generator.
//
// Every board comes back unrouted ({d, defs, project, scope?, layers?, name, kind}) and is
// deterministic. Synthetic boards stand for the dense cases a real board has:
//   bga256-4L / bga256-6L  a 16x16 BGA at 0.8 mm with four fine-pitch edge connectors,
//                          power balls on the planes (fanned out, not routed)
//   qfn48                  a QFN-48 at 0.5 mm with an exposed pad, passives and a header, 2 layers
//   membus                 a QFP-64 controller to a TSOP-II-54 SDRAM: 16 data and 12 address
//                          lines in two matched-length groups, 4 layers
//   pairs                  USB and two Ethernet pairs from connectors to a PHY, plus RMII, 4 layers
// Imported fixtures (routing stripped): the sample, the eco-e2e board, the Altium PiDP-11 I/O
// expander, the KiCad and Eagle demo boards, and (when a directory of real downloads is given)
// cached KiCad and Eagle designs.
(() => {
  const A = () => globalThis.Atrium;
  const pad = (number, x, y, w, h, shape = "rect", drill = 0) => ({number: String(number), x, y, w, h, drill, shape, angle: 0});
  const body = (w, h) => ({kind: "path", points: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], style: "package", closed: true, fill: true});
  const court = (w, h) => ({kind: "path", layer: "Top Courtyard", points: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], closed: true, width: 0.05});
  function fp(id, name, prefix, value, pads, w, h, profile) {
    const shapes = w === undefined ? [] : [body(w, h)];
    if (profile !== "dense") shapes.push(court(w + 0.5, h + 0.5));
    return {id, name, prefix, value, footprint: {name, shapes, pads}};
  }

  function bga(n, pitch, profile) {
    const pads = [], off = (n - 1) / 2 * pitch, rows = "ABCDEFGHJKLMNPRTUVWY";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) pads.push(pad(rows[r] + (c + 1), -off + c * pitch, -off + r * pitch, pitch * 0.5, pitch * 0.5, "round"));
    const dense = profile === "dense", size = n * pitch + (dense ? 1 : 0.8);
    return fp("bga" + (dense ? n : n * n), "BGA-" + n * n, "U", dense ? "FPGA" : "SoC", pads, size, size, profile);
  }
  // Single-row fine-pitch connector (FPC style) along x.
  function fpc(n, pitch) {
    const pads = [], off = (n - 1) / 2 * pitch;
    for (let i = 0; i < n; i++) pads.push(pad(i + 1, -off + i * pitch, 0, pitch * 0.5, 1.2));
    return fp("fpc" + n, "FPC-" + n, "J", "FPC", pads, n * pitch + 1.5, 2.2);
  }
  function qfn(n, pitch, size, ep) {
    const per = n / 4, pads = [], off = (per - 1) / 2 * pitch, s = size / 2 - 0.3;
    let k = 1;
    for (let i = 0; i < per; i++) pads.push(pad(k++, -s, -off + i * pitch, 0.6, pitch * 0.5, "roundrect"));
    for (let i = 0; i < per; i++) pads.push(pad(k++, -off + i * pitch, s, pitch * 0.5, 0.6, "roundrect"));
    for (let i = 0; i < per; i++) pads.push(pad(k++, s, off - i * pitch, 0.6, pitch * 0.5, "roundrect"));
    for (let i = 0; i < per; i++) pads.push(pad(k++, off - i * pitch, -s, pitch * 0.5, 0.6, "roundrect"));
    if (ep) pads.push(pad(k, 0, 0, ep, ep));
    return fp("qfn" + n, "QFN-" + n, "U", "QFN", pads, size, size);
  }
  function qfp(n, pitch, span, profile) {
    const per = n / 4, pads = [], off = (per - 1) / 2 * pitch;
    let k = 1;
    for (let i = 0; i < per; i++) pads.push(pad(k++, -span, -off + i * pitch, 1.4, 0.28));
    for (let i = 0; i < per; i++) pads.push(pad(k++, -off + i * pitch, span, 0.28, 1.4));
    for (let i = 0; i < per; i++) pads.push(pad(k++, span, off - i * pitch, 1.4, 0.28));
    for (let i = 0; i < per; i++) pads.push(pad(k++, off - i * pitch, -span, 0.28, 1.4));
    return fp("qfp" + n, "QFP-" + n, "U", "MCU", pads, 2 * span - 2, 2 * span - 2, profile);
  }
  function tsop(n, pitch, span) {
    const per = n / 2, pads = [], off = (per - 1) / 2 * pitch;
    for (let i = 0; i < per; i++) pads.push(pad(i + 1, -span, -off + i * pitch, 1.6, 0.45));
    for (let i = 0; i < per; i++) pads.push(pad(per + i + 1, span, off - i * pitch, 1.6, 0.45));
    return fp("tsop" + n, "TSOP-II-" + n, "U", "SDRAM", pads, 2 * span - 2.4, per * pitch + 0.6);
  }
  function header(n, pitch = 2.54, profile) {
    const pads = [], dense = profile === "dense", land = dense ? 1.7 : 1.6;
    for (let i = 0; i < n; i++) pads.push(pad(i + 1, 0, (i - (n - 1) / 2) * pitch, land, land, i ? "round" : "rect", 1));
    return fp("hdr" + n, "Header-" + n, "J", "Header", pads, dense ? undefined : 2.6, n * pitch + 0.5, profile);
  }
  const r0402 = fp("r0402", "R0402", "R", "10k", [pad(1, -0.5, 0, 0.6, 0.6, "roundrect"), pad(2, 0.5, 0, 0.6, 0.6, "roundrect")], 1.6, 0.8);
  const usb = fp("usbc", "USB-micro", "J", "USB", [0, 1, 2, 3, 4].map(i => pad(i + 1, (i - 2) * 0.65, 0, 0.4, 1.35)), 7.5, 5);

  function denseFootprints() {
    const profile = "dense";
    function soic(n) {
      const per = n / 2, pads = [], off = (per - 1) / 2 * 1.27;
      for (let i = 0; i < per; i++) pads.push(pad(i + 1, -2.7, -off + i * 1.27, 1.55, 0.6));
      for (let i = 0; i < per; i++) pads.push(pad(per + i + 1, 2.7, off - i * 1.27, 1.55, 0.6));
      return fp("soic" + n, "SOIC-" + n, "U", "IC", pads, 3.9, per * 1.27 + 0.6, profile);
    }
    const passive = {id: "r0603", name: "R0603", prefix: "R", value: "10k", footprint: {name: "0603", shapes: [body(1.1, 0.8)], pads: [pad(1, -0.8, 0, 0.9, 0.95, "roundrect"), pad(2, 0.8, 0, 0.9, 0.95, "roundrect")]}};
    return [qfp(64, 0.5, 5.75, profile), qfp(48, 0.5, 4.75, profile), soic(8), soic(14), bga(8, 0.8, profile), header(10, 2.54, profile), passive];
  }

  // Rules: fine tracks for the BGA and fine-pitch cases.
  function fineRules({clearance = 0.1, width = 0.1, via = 0.45, drill = 0.2} = {}) {
    const set = AtriumRules.create();
    for (const r of set.list) {
      if (r.type === "clearance") r.gap = clearance;
      if (r.type === "width") { r.min = width; r.preferred = width; }
      if (r.type === "viaStyle") { r.holeMin = drill; r.holePreferred = drill; r.diameterPreferred = via; }
      if (r.type === "annularRing") r.min = Math.min(r.min, (via - drill) / 2);
      if (r.type === "holeToHole") r.gap = Math.min(r.gap, 0.2);
    }
    return set;
  }
  function board(name, w, h, lib) {
    const d = A().sheet("pcb", name);
    d.outline = [[0, 0], [w, 0], [w, h], [0, h]];
    const defs = new Map(lib.map(x => [x.id, x]));
    let id = 0;
    const place = (def, x, y, angle = 0, ref) => {
      const p = {id: "b" + (++id), kind: "part", def, ref: ref || defs.get(def).prefix + id, value: defs.get(def).value, x, y, angle, pinNets: {}, layer: "Top"};
      d.items.push(p);
      return p;
    };
    const pins = part => A().pins(part, defs.get(part.def), "pcb");
    return {d, defs, place, pins};
  }
  const stack = (d, layers, planes = []) => {
    // A stored layer stack so plane layers are known to the router (planes are not routed).
    try {
      const S = globalThis.AtriumStackup;
      if (!S?.get) return;
      const st = JSON.parse(JSON.stringify(S.get(d, new Map())));
      const copper = (st.layers || []).filter(l => l.key && /^(Top|Bottom|Inner \d+)$/.test(l.key));
      if (copper.length !== layers.length) return;
      for (const l of copper) if (planes.includes(l.key)) l.type = "Plane";
      d.stackup = S.normalize ? S.normalize(st) : st;
    } catch { /* stack is optional */ }
  };

  // ---------------------------------------------------------------- BGA-256
  function bga256(layerCount) {
    const lib = [bga(16, 0.8), fpc(50, 0.5)];
    const {d, defs, place, pins} = board("BGA-256 " + layerCount + "L", 50, 50, lib);
    d.rules = fineRules();
    const u = place("bga256", 25, 25, 0, "U1");
    const conn = [place("fpc50", 25, 6, 0, "J1"), place("fpc50", 44, 25, 90, "J2"), place("fpc50", 25, 44, 180, "J3"), place("fpc50", 6, 25, 270, "J4")];
    const balls = pins(u), c = [25, 25];
    const ringOf = p => { const k = Math.round((p.at[0] - c[0]) / 0.8 + 7.5), r = Math.round((p.at[1] - c[1]) / 0.8 + 7.5); return {col: k, row: r, ring: Math.min(k, r, 15 - k, 15 - r)}; };
    const power = new Set(), sig = [];
    for (const b of balls) {
      const {col, row, ring} = ringOf(b);
      if (ring >= 5) { u.pinNets[b.number] = (col + row) % 2 ? "VCC" : "GND"; power.add(b.number); continue; }
      if (ring >= 1 && (col * 7 + row * 3) % 11 === 0) { u.pinNets[b.number] = ring % 2 ? "GND" : "VCC"; power.add(b.number); continue; }
      sig.push(b);
    }
    // Each signal ball goes to the connector on its side, in order along the side.
    const sides = [[], [], [], []];
    for (const b of sig) {
      const dx = b.at[0] - c[0], dy = b.at[1] - c[1];
      const s = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 0 : 2) : (dx > 0 ? 1 : 3);
      sides[s].push(b);
    }
    let n = 0;
    sides.forEach((list, s) => {
      const along = s === 0 || s === 2 ? b => b.at[0] : b => b.at[1];
      list.sort((a, b) => along(a) - along(b) || ringOf(a).ring - ringOf(b).ring);
      const cp = pins(conn[s]).sort((a, b) => (s === 0 || s === 2 ? a.at[0] - b.at[0] : a.at[1] - b.at[1]));
      const k = Math.min(list.length, cp.length);
      // Spread the balls over the connector's pins, keeping the order.
      for (let i = 0; i < k; i++) {
        const pin = cp[Math.round(i * (cp.length - 1) / Math.max(1, k - 1))];
        const name = "S" + (++n);
        u.pinNets[list[i].number] = name;
        conn[s].pinNets[pin.number] = name;
      }
    });
    const layers = layerCount === 4 ? ["Top", "Inner 1", "Inner 2", "Bottom"] : ["Top", "Inner 1", "Inner 2", "Inner 3", "Inner 4", "Bottom"];
    const nets = [...new Set(Object.values(u.pinNets).filter(v => /^S\d+$/.test(v)))];
    return {d, defs, layers, scope: {nets}, power: ["GND", "VCC"], fanout: true};
  }

  // ---------------------------------------------------------------- QFN-48
  function qfn48() {
    const lib = [qfn(48, 0.5, 7, 5.1), r0402, header(10)];
    const {d, defs, place, pins} = board("QFN-48", 32, 32, lib);
    d.rules = fineRules({clearance: 0.127, width: 0.15, via: 0.5, drill: 0.25});
    const u = place("qfn48", 16, 16, 0, "U1");
    const h1 = place("hdr10", 3, 16, 0, "J1"), h2 = place("hdr10", 29, 16, 0, "J2");
    const up = pins(u), rs = [];
    // A ring of 0402s around the QFN, one per side position.
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2, x = 16 + Math.cos(a) * 9, y = 16 + Math.sin(a) * 9;
      rs.push(place("r0402", Math.round(x * 4) / 4, Math.round(y * 4) / 4, (i % 4) * 45 >= 90 ? 90 : 0));
    }
    let n = 0;
    const name = () => "Q" + (++n);
    u.pinNets["49"] = "GND";
    const pinAt = (part, k) => pins(part)[k];
    up.filter(p => p.number !== "49").forEach((p, i) => {
      if (i % 8 === 3) { u.pinNets[p.number] = "GND"; return; }
      if (i % 8 === 7) { u.pinNets[p.number] = "3V3"; return; }
      // Nearest free resistor, else a header pin on the near side.
      const free = rs.filter(r => !r.pinNets["1"]).sort((a, b) => Math.hypot(a.x - p.at[0], a.y - p.at[1]) - Math.hypot(b.x - p.at[0], b.y - p.at[1]));
      if (free.length && i % 3 !== 2) {
        const r = free[0], nm = name();
        u.pinNets[p.number] = nm; r.pinNets["1"] = nm;
        const hdr = r.x < 16 ? h1 : h2, hp = pins(hdr).find(q => !hdr.pinNets[q.number]);
        if (hp) { const n2 = name(); r.pinNets["2"] = n2; hdr.pinNets[hp.number] = n2; } else r.pinNets["2"] = "GND";
        return;
      }
      const hdr = p.at[0] < 16 ? h1 : h2, hp = pins(hdr).find(q => !hdr.pinNets[q.number]);
      if (hp) { const nm = name(); u.pinNets[p.number] = nm; hdr.pinNets[hp.number] = nm; }
    });
    for (const r of rs) if (!r.pinNets["1"]) { r.pinNets["1"] = "3V3"; r.pinNets["2"] = "GND"; }
    pinAt(h1, 0) && (h1.pinNets[pins(h1).find(q => !h1.pinNets[q.number])?.number ?? "10"] ||= "GND");
    pinAt(h2, 0) && (h2.pinNets[pins(h2).find(q => !h2.pinNets[q.number])?.number ?? "10"] ||= "3V3");
    return {d, defs, layers: ["Top", "Bottom"], fanout: false};
  }

  // ---------------------------------------------------------------- memory bus
  function membus() {
    const lib = [qfp(64, 0.5, 5.75), tsop(54, 0.8, 5.7), r0402];
    const {d, defs, place, pins} = board("Memory bus", 50, 36, lib);
    d.rules = fineRules({clearance: 0.127, width: 0.127, via: 0.5, drill: 0.25});
    const mcu = place("qfp64", 13, 18, 0, "U1"), ram = place("tsop54", 37, 18, 0, "U2");
    const mp = pins(mcu), rp = pins(ram);
    // Controller pins on the side facing the SDRAM (right side: pins 33-48), plus top and bottom.
    const facing = mp.filter(p => p.at[0] > 13 + 4).sort((a, b) => a.at[1] - b.at[1]);
    const upper = mp.filter(p => p.at[1] < 18 - 4).sort((a, b) => b.at[0] - a.at[0]);
    const lower = mp.filter(p => p.at[1] > 18 + 4).sort((a, b) => b.at[0] - a.at[0]);
    const ramL = rp.filter(p => p.at[0] < 37).sort((a, b) => a.at[1] - b.at[1]), ramR = rp.filter(p => p.at[0] > 37).sort((a, b) => a.at[1] - b.at[1]);
    const dq = [], addr = [];
    // 16 data lines: controller right side to the SDRAM's left row (DQ pins), in order.
    for (let i = 0; i < 16; i++) { const nm = "DQ" + i; mcu.pinNets[facing[i].number] = nm; ram.pinNets[ramL[2 + i].number] = nm; dq.push(nm); }
    // 12 address lines: controller top and bottom rows to the SDRAM's right row.
    for (let i = 0; i < 12; i++) { const src = i < 6 ? upper[i] : lower[i - 6]; const nm = "A" + i; mcu.pinNets[src.number] = nm; ram.pinNets[ramR[4 + i * 2 - (i >= 6 ? 0 : 0)].number] = nm; addr.push(nm); }
    for (const [k, nm] of [[6, "CLK"], [7, "CKE"], [8, "CS"], [9, "RAS"], [10, "CAS"], [11, "WE"]]) {
      const src = upper[k], dst = ramL[20 + (k - 6)];
      if (src && dst) { mcu.pinNets[src.number] = nm; ram.pinNets[dst.number] = nm; }
    }
    for (const p of [ramL[0], ramL[1], ramR[0], ramR[1]]) ram.pinNets[p.number] = ram.pinNets[p.number] || (p === ramL[0] || p === ramR[1] ? "3V3" : "GND");
    d.lengthTuning = {version: 1, groups: [{name: "DQ", members: dq, tolerance: 0.5}, {name: "ADDR", members: addr, tolerance: 1}], targets: {}};
    return {d, defs, layers: ["Top", "Inner 1", "Inner 2", "Bottom"], fanout: false, groups: ["group:DQ", "group:ADDR"]};
  }

  // ---------------------------------------------------------------- differential pairs
  function pairs() {
    const lib = [qfn(48, 0.5, 7, 5.1), qfp(64, 0.5, 5.75), usb, header(10, 1.27), r0402];
    const {d, defs, place, pins} = board("USB and Ethernet pairs", 60, 40, lib);
    const rules = fineRules({clearance: 0.127, width: 0.15, via: 0.5, drill: 0.25});
    rules.diffPairs = [{name: "USB", positive: "USB_P", negative: "USB_N"}, {name: "TX", positive: "TX_P", negative: "TX_N"}, {name: "RX", positive: "RX_P", negative: "RX_N"}];
    for (const r of rules.list) if (r.type === "diffPairsRouting") { r.widthPreferred = 0.18; r.gapPreferred = 0.15; }
    d.rules = rules;
    const j1 = place("usbc", 6, 8, 90, "J1"), j2 = place("hdr10", 5, 28, 0, "J2"), phy = place("qfn48", 24, 26, 0, "U1"), mcu = place("qfp64", 46, 18, 0, "U2");
    const pj1 = pins(j1), pj2 = pins(j2), pphy = pins(phy), pmcu = pins(mcu);
    j1.pinNets[pj1[1].number] = "USB_N"; j1.pinNets[pj1[2].number] = "USB_P"; j1.pinNets[pj1[4].number] = "GND"; j1.pinNets[pj1[0].number] = "VBUS";
    // USB to the controller's left side.
    const mL = pmcu.filter(p => p.at[0] < 46 - 4).sort((a, b) => a.at[1] - b.at[1]);
    mcu.pinNets[mL[2].number] = "USB_P"; mcu.pinNets[mL[3].number] = "USB_N";
    // Ethernet: header pins 1/2 TX, 3/6-style RX (adjacent here), to the PHY's left side.
    const sorted = pj2.sort((a, b) => a.at[1] - b.at[1]);
    j2.pinNets[sorted[2].number] = "TX_P"; j2.pinNets[sorted[3].number] = "TX_N"; j2.pinNets[sorted[5].number] = "RX_P"; j2.pinNets[sorted[6].number] = "RX_N";
    j2.pinNets[sorted[9].number] = "GND";
    const pL = pphy.filter(p => p.at[0] < 24 - 3 && p.number !== "49").sort((a, b) => a.at[1] - b.at[1]);
    phy.pinNets[pL[3].number] = "TX_P"; phy.pinNets[pL[4].number] = "TX_N"; phy.pinNets[pL[7].number] = "RX_P"; phy.pinNets[pL[8].number] = "RX_N";
    phy.pinNets["49"] = "GND";
    // RMII between the PHY's right side and the controller's left side.
    const pR = pphy.filter(p => p.at[0] > 24 + 3 && p.number !== "49").sort((a, b) => a.at[1] - b.at[1]);
    ["REFCLK", "CRS_DV", "RXD0", "RXD1", "TXEN", "TXD0", "TXD1", "MDIO", "MDC"].forEach((nm, i) => { phy.pinNets[pR[i + 1].number] = nm; mcu.pinNets[mL[6 + i].number] = nm; });
    return {d, defs, layers: ["Top", "Inner 1", "Inner 2", "Bottom"], fanout: false, pairs: 3};
  }

  // ---------------------------------------------------------------- fixtures
  // Removes routed copper (tracks, arcs, vias, pours) so the board needs routing again.
  function strip(d) { d.items = d.items.filter(i => !["track", "via", "arc", "polygon"].includes(i.kind) && !(i.kind === "graphic" && i.net)); delete d.pcbDrawing; return d; }
  const projectDefs = p => new Map(p.library.map(x => [x.id, x]));
  function importFiles(files, name) {
    const IO = globalThis.AtriumIO;
    const p = A().project(name); p.documents = []; p.library = [];
    for (const [fname, bytes] of files) {
      const F = globalThis.AtriumImportFormats, r = /\.(kicad_pcb|kicad_sch|brd|sch|json|epro)$/i.test(fname) && F?.read ? F.read(fname, bytes) : IO.read(fname, bytes);
      p.documents.push(...(r.documents || [])); p.library.push(...(r.library || []));
    }
    try { globalThis.AtriumImportLink?.reconcile(p, p.documents); } catch { /* optional */ }
    return p;
  }
  function fromProject(p, name, extra = {}) {
    const d = p.documents.find(x => x.kind === "pcb");
    if (!d) return null;
    strip(d);
    return {d, defs: projectDefs(p), project: p, name, ...extra};
  }

  const synthetic = {
    "bga256-4L": () => bga256(4), "bga256-6L": () => bga256(6), qfn48, membus, pairs
  };
  globalThis.AtriumBenchBoards = {synthetic, strip, importFiles, fromProject, fineRules, denseFootprints, lib: {bga, fpc, qfn, qfp, tsop, header, r0402, usb}, stack};
})();
