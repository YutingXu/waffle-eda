"use strict";
// Starter library: about forty generic parts with symbols and footprints, so a new project
// can be drawn and laid out without importing anything first.
//
//   AtriumStarterLibrary.defs()          -> fresh copies of every definition
//   AtriumStarterLibrary.templates()     -> shared read-only definitions for lookup and preview
//   AtriumStarterLibrary.ids()           -> their ids (stable: "starter-…")
//   AtriumStarterLibrary.addTo(project)  -> number of definitions added (ids already present are skipped)
//
// Clean-room. Every part is generic, with no manufacturer part numbers. The symbols are drawn
// here. Footprints are generated when the library loads, either from IPC-7351B wizard specs
// (AtriumFootprintWizard) or, for parts the wizard has no family for (crystal, switch, USB-C,
// holes, fiducial, net tie), from a few lines of geometry below. No pads are stored, which keeps
// the file small. Parameters are Value, Tolerance, Voltage and Power, plus an "LCSC #" left blank
// for the user to fill in. Pinouts follow common generic conventions; check the datasheet of the
// part you buy before ordering.
//
// Sourcing: these parts are generic and need sourcing. Waffle never invents part numbers. Fill
// "LCSC #" by hand, or let the BOM optimiser's opt-in supplier lookup (Reports › Bill of Materials
// › Optimise › Suppliers: an imported JLC parts CSV, or a network supplier you enable) assign the
// part it found ("Assign part numbers"). The JLC BOM output job warns about every line without one.
globalThis.AtriumStarterLibrary = (() => {
  const G = 2.54, r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const clone = v => JSON.parse(JSON.stringify(v));
  const L = () => globalThis.AtriumLibrary, W = () => globalThis.AtriumFootprintWizard;

  // ---------------------------------------------------------------- symbol helpers
  const line = (pts, extra) => ({kind: "path", style: "body", points: pts.map(p => p.map(r6)), ...extra});
  const poly = (pts, fill = true) => ({kind: "path", style: "body", closed: true, fill, points: pts.map(p => p.map(r6))});
  const circle = (x, y, r, fill = false) => ({kind: "circle", style: "body", x, y, r, ...(fill ? {fill: true} : {})});
  const text = (t, x, y, size = 1.5) => ({kind: "text", text: t, x, y, size, align: "center", style: "body"});
  const arc = (cx, cy, r, a0, a1, n = 8) => Array.from({length: n + 1}, (_, i) => { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  // [number, name, x, y, orientation, electrical, length?]: x, y is the pin tip.
  const pin = (number, name, x, y, orientation, electrical = 4, length = G) => ({number: String(number), name, x, y, orientation, electrical, length, hideName: true});
  function symbol(pins, shapes, parts) { return L().buildSymbol({pins, shapes, parts: parts || 1, alternate: false}); }
  const two = (shapes, n1 = "1", n2 = "2") => symbol([pin(1, n1, -2 * G, 0, "left"), pin(2, n2, 2 * G, 0, "right")], shapes);

  const RES = () => two([poly([[-G, -.76], [G, -.76], [G, .76], [-G, .76]], false)]);
  const CAP = () => two([line([[-G, 0], [-.4, 0]]), line([[G, 0], [.4, 0]]), line([[-.4, -1.6], [-.4, 1.6]], {width: .38}), line([[.4, -1.6], [.4, 1.6]], {width: .38})]);
  const POLCAP = () => two([line([[-G, 0], [-.4, 0]]), line([[G, 0], [.55, 0]]), line([[-.4, -1.6], [-.4, 1.6]], {width: .38}),
    line(arc(2.4, 0, 1.9, 145, 215), {width: .38}), text("+", -1.5, -1.3, 1.6)], "+", "−");
  const IND = () => two([...[0, 1, 2, 3].map(k => line(arc(-1.905 + 1.27 * k, 0, .635, 180, 360)))]);
  const BEAD = () => two([line([[-G, 0], [-1.6, 0]]), line([[G, 0], [1.6, 0]]), poly([[-1.6, -.8], [1.6, -.8], [1.6, .8], [-1.6, .8]])]);
  // Diodes: pad 1 is the cathode (IPC-7351 pin 1 marking), drawn on the right.
  function diode(kind) {
    const body = [line([[-G, 0], [-1.1, 0]]), line([[1.1, 0], [G, 0]]), poly([[-1.1, -1.27], [-1.1, 1.27], [1.1, 0]])];
    if (kind === "schottky") body.push(line([[1.6, -1.6], [1.6, -1.27], [1.1, -1.27], [1.1, 1.27], [.6, 1.27], [.6, 1.6]]));
    else if (kind === "zener") body.push(line([[1.6, -1.6], [1.1, -1.27], [1.1, 1.27], [.6, 1.6]]));
    else body.push(line([[1.1, -1.27], [1.1, 1.27]]));
    if (kind === "led") for (const dx of [0, .9]) body.push(line([[-.2 + dx, -1.6], [.7 + dx, -2.5]]), poly([[.7 + dx, -2.5], [.25 + dx, -2.35], [.55 + dx, -2.05]]));
    return symbol([pin(2, "A", -2 * G, 0, "left"), pin(1, "K", 2 * G, 0, "right")], body);
  }
  // SOT-23 transistors. BJT pads: 1 B, 2 E, 3 C. MOSFET pads: 1 G, 2 S, 3 D.
  function bjt(pnp) {
    const shapes = [circle(1.2, 0, 2.8), line([[-G, 0], [0, 0]]), line([[0, -1.8], [0, 1.8]], {width: .3}), line([[0, -.8], [G, -G]]), line([[0, .8], [G, G]])];
    // Arrow on the emitter: out of the base for NPN, into it for PNP.
    const tip = pnp ? [.55, 1.15] : [2.1, 2.15], back = pnp ? [1.4, 1.2] : [1.25, 2.0], side = pnp ? [.9, 2.0] : [1.75, 1.35];
    shapes.push(poly([tip, back, side]));
    return symbol([pin(1, "B", -2 * G, 0, "left", 0), pin(3, "C", G, -2 * G, "up"), pin(2, "E", G, 2 * G, "down")], shapes);
  }
  function mosfet(p) {
    const shapes = [circle(1.2, 0, 2.8), line([[-G, 0], [-.7, 0]]), line([[-.7, -1.5], [-.7, 1.5]]),
      line([[0, -1.9], [0, -.9]]), line([[0, -.45], [0, .45]]), line([[0, .9], [0, 1.9]]),
      line([[0, -1.27], [G, -1.27], [G, -G]]), line([[0, 1.27], [G, 1.27], [G, G]]), line([[0, 0], [G, 0], [G, 1.27]])];
    shapes.push(poly(p ? [[1.3, 0], [.6, -.45], [.6, .45]] : [[.1, 0], [.8, -.45], [.8, .45]]));
    return symbol([pin(1, "G", -2 * G, 0, "left", 0), pin(3, "D", G, -2 * G, "up"), pin(2, "S", G, 2 * G, "down")], shapes);
  }
  function crystal() {
    const shapes = [line([[-G, 0], [-1.5, 0]]), line([[G, 0], [1.5, 0]]), line([[-1.5, -1.9], [-1.5, 1.9]]), line([[1.5, -1.9], [1.5, 1.9]]),
      poly([[-.8, -1.6], [.8, -1.6], [.8, 1.6], [-.8, 1.6]], false), line([[-3.3, G], [3.3, G], [3.3, -G], [-3.3, -G], [-3.3, G]], {width: .1})];
    return symbol([pin(1, "1", -2 * G, 0, "left"), pin(3, "3", 2 * G, 0, "right"), pin(2, "GND", -G, 2 * G, "down", 7), pin(4, "GND", G, 2 * G, "down", 7)], shapes);
  }
  const SWITCH = () => two([line([[-G, 0], [-1.7, 0]]), line([[1.7, 0], [G, 0]]), circle(-1.3, 0, .4), circle(1.3, 0, .4), line([[-1.0, -.4], [1.6, -1.4]]),
    line([[0, -.9], [0, -2.3]]), line([[-1.27, -2.3], [1.27, -2.3]])]);
  const TIE = () => two([line([[-G, 0], [G, 0]], {width: .6})]);
  const TP = () => symbol([pin(1, "1", 0, G, "down")], [circle(0, -.8, .8)]);
  // Box symbols from typed pin rows ([number, name, electrical, side?]).
  const boxed = (rows, title) => L().buildSymbol(L().symbolFromPins(rows.map(([number, name, electrical, side]) => ({number: String(number), name, electrical, ...(side ? {side} : {})})), title ? {title} : {}));
  // Dual op amp, two gates (A: 1-3, B: 5-7) sharing the supply pins 4 and 8.
  function dualOpamp() {
    const pins = [], shapes = [];
    for (const [g, out, inm, inp] of [[1, 1, 2, 3], [2, 7, 6, 5]]) {
      pins.push({...pin(inm, "−IN" + "AB"[g - 1], -3 * G, -G, "left", 0), part: g}, {...pin(inp, "+IN" + "AB"[g - 1], -3 * G, G, "left", 0), part: g},
        {...pin(out, "OUT" + "AB"[g - 1], 3 * G, 0, "right", 2), part: g});
      shapes.push({...poly([[-2 * G, -2 * G], [2 * G, 0], [-2 * G, 2 * G]]), part: g}, {...text("−", -3.9, -G + .55, 2), part: g}, {...text("+", -3.9, G + .55, 2), part: g});
    }
    pins.push(pin(8, "V+", 0, -2 * G, "up", 7), pin(4, "V−", 0, 2 * G, "down", 7));
    return symbol(pins, shapes, 2);
  }

  // ---------------------------------------------------------------- footprint helpers
  const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => p.map(r6));
  const courtyard = (x, y) => ({kind: "path", points: box(-x, -y, x, y), closed: true, layer: "Mechanical 15", style: "courtyard", width: .05});
  const silk = (pts, closed = false) => ({kind: "path", style: "silk", width: .12, points: pts.map(p => p.map(r6)), ...(closed ? {closed: true} : {})});
  const silkCircle = r => ({kind: "circle", style: "silk", x: 0, y: 0, r, width: .12});
  const smd = (number, x, y, w, h, shape = "roundrect") => ({number: String(number), x: r6(x), y: r6(y), w, h, shape, angle: 0, drill: 0});
  const tht = (number, x, y, w, h, drill, shape = "round") => ({number: String(number), x: r6(x), y: r6(y), w, h, drill, shape, angle: 0, layer: "Multi", plated: true});
  function wizard(spec) {
    const d = W().generate(spec), fp = d.footprint;
    delete fp.ipc; // Derivation details are regenerated by the wizard on demand.
    return fp;
  }
  // Silk clears every mask opening by the default Silk To Solder Mask rule (0.1 mm) over the default
  // mask expansion (0.1016 mm): segments are clipped around each pad, rings around round pads grow.
  const MASK = .1016, GAP = .1, SAFE = .02;
  function inside(a, b, r) { // Parameter interval of segment a->b inside rect r = [x0, y0, x1, y1], or null.
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - r[0]], [dx, r[2] - a[0]], [-dy, a[1] - r[1]], [dy, r[3] - a[1]]]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
      const t = q / p; if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
    return [t0, t1];
  }
  function clearSilk(f) {
    const keep = f.pads.map(p => ({p, m: (Number.isFinite(p.maskExpansion) ? p.maskExpansion : MASK) + GAP + SAFE}));
    const rects = w => keep.map(({p, m}) => [p.x - p.w / 2 - m - w / 2, p.y - p.h / 2 - m - w / 2, p.x + p.w / 2 + m + w / 2, p.y + p.h / 2 + m + w / 2]);
    const out = [];
    for (const s of f.shapes) {
      if (s.style !== "silk") { out.push(s); continue; }
      const w = s.width || .12;
      if (s.kind === "circle") {
        const own = keep.find(({p}) => Math.hypot(p.x - s.x, p.y - s.y) < 1e-6);
        if (own) { out.push({...s, r: r6(Math.max(s.r, (Math.max(own.p.w, own.p.h) / 2 + own.m + w / 2) * 1.03))}); continue; }
        if (!rects(w).some(r => s.x + s.r > r[0] && s.x - s.r < r[2] && s.y + s.r > r[1] && s.y - s.r < r[3])) out.push(s);
        continue;
      }
      const pts = s.closed ? [...s.points, s.points[0]] : s.points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], cut = rects(w).map(r => inside(a, b, r)).filter(Boolean).sort((x, y) => x[0] - y[0]);
        let t = 0; const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const piece = (u, v) => { if ((v - u) * len > .1) out.push({kind: "path", style: "silk", width: w, points: [u, v].map(k => [r6(a[0] + (b[0] - a[0]) * k), r6(a[1] + (b[1] - a[1]) * k)])}); };
        for (const [u, v] of cut) { if (u > t) piece(t, u); t = Math.max(t, v); }
        if (t < 1) piece(t, 1);
      }
    }
    f.shapes = out;
    return f;
  }
  const fp = (name, pads, shapes, height, extra) => ({name, pads, shapes, ...(height ? {height} : {}), ...extra});
  const FP = {
    crystal3225: () => fp("Crystal_SMD_3225-4Pin_3.2x2.5mm", [smd(1, -1.1, .8, 1.4, 1.15), smd(2, 1.1, .8, 1.4, 1.15), smd(3, 1.1, -.8, 1.4, 1.15), smd(4, -1.1, -.8, 1.4, 1.15)],
      [silk([[-2.0, 1.75], [-2.0, -1.75]]), silk([[-2.0, 1.75], [2.0, 1.75]]), courtyard(2.1, 1.85)], .8),
    tactile: () => fp("SW_Tactile_THT_6x6mm", [tht(1, -3.25, -2.25, 1.8, 1.8, 1), tht(1, 3.25, -2.25, 1.8, 1.8, 1), tht(2, -3.25, 2.25, 1.8, 1.8, 1), tht(2, 3.25, 2.25, 1.8, 1.8, 1)],
      [silk(box(-3, -3, 3, 3), true), silkCircle(1.75), courtyard(4.4, 3.4)], 5),
    usbc: () => {
      const pads = [], row = [["A1B12", -3.2, .6], ["A4B9", -2.4, .6], ["B8", -1.75, .3], ["A5", -1.25, .3], ["B7", -.75, .3], ["A6", -.25, .3],
        ["A7", .25, .3], ["B6", .75, .3], ["A8", 1.25, .3], ["B5", 1.75, .3], ["B4A9", 2.4, .6], ["B1A12", 3.2, .6]];
      for (const [n, x, w] of row) pads.push(smd(n, x, -3.6, w, 1.15, "rect"));
      for (const s of [-1, 1]) pads.push(tht("S1", s * 4.32, -3.1, 1, 2.1, .6, "oval"), tht("S1", s * 4.32, 1.1, 1, 1.6, .6, "oval"));
      for (const s of [-1, 1]) pads.push({number: "", x: r6(s * 2.89), y: -2.6, w: .65, h: .65, drill: .65, shape: "round", angle: 0, layer: "Multi", plated: false});
      return fp("USB_C_Receptacle_16P_Generic", pads, [silk([[-4.47, 2.2], [4.47, 2.2]]), courtyard(5.1, 4.6)], 3.3);
    },
    testpoint: () => fp("TestPoint_Pad_D1.0mm", [smd(1, 0, 0, 1, 1, "round")], [silkCircle(.75), courtyard(.85, .85)]),
    hole: (m, drill, pad) => fp("MountingHole_" + m + "_Plated", [{...tht(1, 0, 0, pad, pad, drill)}], [silkCircle(r6(pad / 2 + .15)), courtyard(r6(pad / 2 + .25), r6(pad / 2 + .25))]),
    fiducial: () => fp("Fiducial_1mm_Mask3mm", [{...smd(1, 0, 0, 1, 1, "round"), maskExpansion: 1}], [courtyard(1.6, 1.6)]),
    netTie: () => fp("NetTie_2Pad_0.6mm", [smd(1, -.5, 0, .6, .6, "rect"), smd(2, .5, 0, .6, .6, "rect")],
      [{kind: "path", layer: "Top", width: .3, points: [[-.5, 0], [.5, 0]]}, courtyard(1, .5)], 0, {netTie: true, netTieGroups: [["1", "2"]]})
  };

  // ---------------------------------------------------------------- parts
  const params = (Value, Tolerance = "", Voltage = "", Power = "") => ({Value, Tolerance, Voltage, Power, "LCSC #": ""});
  const chip = (preset, kind) => ({family: "chip", preset, kind});
  // Package names for the catalogue's parametric filter (Place › Component, Library panel).
  const PKG = {"starter-cpol-d5": "Radial D5", "starter-cpol-d8": "Radial D8", "starter-ds-sma": "SMA", "starter-ldo-sot223": "SOT-223", "starter-mcu-qfn32": "QFN-32",
    "starter-usbc-16": "USB-C 16-pin", "starter-xtal-3225": "3225", "starter-sw-tact": "6×6 mm THT", "starter-tp-1mm": "1.0 mm pad", "starter-mh-m2": "M2", "starter-mh-m3": "M3",
    "starter-fid-1mm": "1 mm", "starter-nettie-2": "0.6 mm pads"};
  const packageOf = p => PKG[p.id] || (p.foot?.family === "header" ? p.foot.rows + "×" + p.foot.cols + " 2.54 mm" : p.foot?.preset || "");
  const SIZE = {"0402": [.0625, "50 V"], "0603": [.1, "75 V"], "0805": [.125, "150 V"]};
  const watts = w => w === .0625 ? "1/16 W" : w === .1 ? "1/10 W" : "1/8 W";
  const mcu32 = [["VDD", 7], ["PA0", 1], ["PA1", 1], ["PA2", 1], ["PA3", 1], ["PA4", 1], ["PA5", 1], ["PA6", 1], ["PA7", 1], ["PB0", 1], ["PB1", 1], ["GND", 7],
    ["VDD", 7], ["PA8", 1], ["PA9", 1], ["PA10", 1], ["PA11", 1], ["PA12", 1], ["SWDIO", 1], ["SWCLK", 0], ["PA15", 1], ["PB3", 1], ["PB4", 1], ["PB5", 1],
    ["PB6", 1], ["PB7", 1], ["BOOT0", 0], ["XIN", 0], ["XOUT", 2], ["NRST", 0], ["VDDA", 7], ["GND", 7]];
  const mcu48 = [["VBAT", 7], ["PC13", 1], ["PC14", 1], ["PC15", 1], ["XIN", 0], ["XOUT", 2], ["NRST", 0], ["VSSA", 7], ["VDDA", 7], ["PA0", 1], ["PA1", 1], ["PA2", 1],
    ["PA3", 1], ["PA4", 1], ["PA5", 1], ["PA6", 1], ["PA7", 1], ["PB0", 1], ["PB1", 1], ["PB2", 1], ["PB10", 1], ["PB11", 1], ["VSS", 7], ["VDD", 7],
    ["PB12", 1], ["PB13", 1], ["PB14", 1], ["PB15", 1], ["PA8", 1], ["PA9", 1], ["PA10", 1], ["PA11", 1], ["PA12", 1], ["SWDIO", 1], ["VSS", 7], ["VDD", 7],
    ["SWCLK", 0], ["PA15", 1], ["PB3", 1], ["PB4", 1], ["PB5", 1], ["PB6", 1], ["PB7", 1], ["BOOT0", 0], ["PB8", 1], ["PB9", 1], ["VSS", 7], ["VDD", 7]];
  const header = (rows, cols) => ({id: "starter-hdr-" + rows + "x" + cols, name: "Pin header " + rows + "×" + cols + ", 2.54 mm", category: "Connectors", prefix: "J", value: rows + "×" + cols,
    params: params(rows + "×" + cols), sym: () => boxed(Array.from({length: rows * cols}, (_, i) => [i + 1, String(i + 1), 4, rows === 1 || i % 2 === 0 ? "left" : "right"])),
    foot: {family: "header", preset: "1×6 2.54", rows, cols, pitch: 2.54, lead: .64}});
  const PARTS = [
    ...["0402", "0603", "0805"].map(s => ({id: "starter-r-" + s, name: "Resistor " + s, category: "Resistors", prefix: "R", value: "10 kΩ",
      params: params("10 kΩ", "1%", SIZE[s][1], watts(SIZE[s][0])), sym: RES, foot: chip(s, "RES")})),
    ...["0402", "0603", "0805"].map(s => ({id: "starter-c-" + s, name: "Capacitor " + s, category: "Capacitors", prefix: "C", value: "100 nF",
      params: params("100 nF", "10%", s === "0402" ? "16 V" : s === "0603" ? "25 V" : "50 V"), sym: CAP, foot: chip(s, "CAP")})),
    ...["0603", "0805"].map(s => ({id: "starter-l-" + s, name: "Inductor " + s, category: "Inductors", prefix: "L", value: s === "0603" ? "1 µH" : "4.7 µH",
      params: params(s === "0603" ? "1 µH" : "4.7 µH", "20%"), sym: IND, foot: chip(s, "IND")})),
    {id: "starter-fb-0603", name: "Ferrite bead 0603", category: "Inductors", prefix: "FB", value: "600 Ω @ 100 MHz", params: params("600 Ω @ 100 MHz", "25%"), sym: BEAD, foot: chip("0603", "IND")},
    {id: "starter-cpol-d5", name: "Electrolytic capacitor, radial D5 mm", category: "Capacitors", prefix: "C", value: "100 µF", params: params("100 µF", "20%", "16 V"), sym: POLCAP,
      foot: {family: "header", preset: "1×6 2.54", rows: 1, cols: 2, pitch: 2, lead: .5, H: 11}, art: [silkCircle(2.6)], fpName: "CP_Radial_D5.0mm_P2.00mm"},
    {id: "starter-cpol-d8", name: "Electrolytic capacitor, radial D8 mm", category: "Capacitors", prefix: "C", value: "470 µF", params: params("470 µF", "20%", "25 V"), sym: POLCAP,
      foot: {family: "header", preset: "1×6 2.54", rows: 1, cols: 2, pitch: 3.5, lead: .6, H: 12}, art: [silkCircle(4.15)], fpName: "CP_Radial_D8.0mm_P3.50mm"},
    {id: "starter-d-sod123", name: "Diode, SOD-123", category: "Diodes", prefix: "D", value: "1 A 100 V", params: params("Rectifier 1 A", "", "100 V"), sym: () => diode(""), foot: {family: "sod", preset: "SOD-123"}},
    {id: "starter-dz-sod123", name: "Zener diode, SOD-123", category: "Diodes", prefix: "D", value: "5.1 V", params: params("5.1 V", "5%", "5.1 V", "500 mW"), sym: () => diode("zener"), foot: {family: "sod", preset: "SOD-123"}},
    // SMA (DO-214AC) through the SOD equations with SMA body sizes; the bent terminals are close enough to the gull-wing goals.
    {id: "starter-ds-sma", name: "Schottky diode, SMA", category: "Diodes", prefix: "D", value: "3 A 40 V", params: params("Schottky 3 A", "", "40 V"), sym: () => diode("schottky"),
      foot: {family: "sod", preset: "SOD-123", L: {min: 4.8, max: 5.3}, T: {min: .75, max: 1.6}, W: {min: 1.25, max: 1.65}, D: {min: 4, max: 4.6}, E: {min: 2.29, max: 2.92}, H: 2.3}, fpName: "D_SMA"},
    {id: "starter-led-0603", name: "LED 0603", category: "Optoelectronics", prefix: "D", value: "Red", params: params("Red", "", "2.0 V", "20 mA"), sym: () => diode("led"), foot: chip("0603", "LED")},
    {id: "starter-led-0805", name: "LED 0805", category: "Optoelectronics", prefix: "D", value: "Green", params: params("Green", "", "3.0 V", "20 mA"), sym: () => diode("led"), foot: chip("0805", "LED")},
    {id: "starter-q-npn", name: "NPN transistor, SOT-23", category: "Transistors", prefix: "Q", value: "NPN", params: params("NPN 40 V 200 mA", "", "40 V", "250 mW"), sym: () => bjt(false), foot: {family: "sot23", preset: "SOT-23-3"}},
    {id: "starter-q-pnp", name: "PNP transistor, SOT-23", category: "Transistors", prefix: "Q", value: "PNP", params: params("PNP 40 V 200 mA", "", "40 V", "250 mW"), sym: () => bjt(true), foot: {family: "sot23", preset: "SOT-23-3"}},
    {id: "starter-q-nmos", name: "N-channel MOSFET, SOT-23", category: "Transistors", prefix: "Q", value: "N-MOSFET", params: params("N-MOSFET 30 V 3 A", "", "30 V", "1 W"), sym: () => mosfet(false), foot: {family: "sot23", preset: "SOT-23-3"}},
    {id: "starter-q-pmos", name: "P-channel MOSFET, SOT-23", category: "Transistors", prefix: "Q", value: "P-MOSFET", params: params("P-MOSFET 30 V 3 A", "", "30 V", "1 W"), sym: () => mosfet(true), foot: {family: "sot23", preset: "SOT-23-3"}},
    {id: "starter-ldo-sot235", name: "LDO regulator, SOT-23-5", category: "Regulators", prefix: "U", value: "3.3 V 300 mA", params: params("3.3 V 300 mA", "2%", "6 V"),
      sym: () => boxed([[1, "IN", 7, "left"], [3, "EN", 0, "left"], [5, "OUT", 7, "right"], [4, "NC", 4, "right"], [2, "GND", 7, "bottom"]]), foot: {family: "sot23", preset: "SOT-23-5"}},
    {id: "starter-ldo-sot223", name: "LDO regulator, SOT-223", category: "Regulators", prefix: "U", value: "3.3 V 1 A", params: params("3.3 V 1 A", "2%", "15 V"),
      sym: () => boxed([[3, "IN", 7, "left"], [2, "OUT", 7, "right"], [4, "OUT", 7, "right"], [1, "GND", 7, "bottom"]]), foot: {family: "sot223"}},
    {id: "starter-buck-sot236", name: "Buck regulator, SOT-23-6", category: "Regulators", prefix: "U", value: "Buck 2 A", params: params("Buck 2 A", "", "17 V"),
      sym: () => boxed([[5, "VIN", 7, "left"], [4, "EN", 0, "left"], [1, "BST", 4, "right"], [6, "SW", 2, "right"], [3, "FB", 0, "right"], [2, "GND", 7, "bottom"]]), foot: {family: "sot23", preset: "SOT-23-6"}},
    {id: "starter-opamp-dual", name: "Dual op amp, SOIC-8", category: "Amplifiers", prefix: "U", value: "Dual op amp", params: params("Dual op amp", "", "36 V"), sym: dualOpamp, foot: {family: "gullwing", preset: "SOIC-8"}},
    {id: "starter-mcu-qfn32", name: "Microcontroller, QFN-32", category: "Microcontrollers", prefix: "U", value: "MCU 32-pin", params: params("MCU QFN-32", "", "3.6 V"),
      sym: () => boxed([...mcu32.map(([n, e], i) => [i + 1, n, e]), [33, "EP", 7]], "MCU"), foot: {family: "nolead", preset: "QFN-32 5×5"}},
    {id: "starter-mcu-qfp48", name: "Microcontroller, LQFP-48", category: "Microcontrollers", prefix: "U", value: "MCU 48-pin", params: params("MCU LQFP-48", "", "3.6 V"),
      sym: () => boxed(mcu48.map(([n, e], i) => [i + 1, n, e]), "MCU"), foot: {family: "gullwing", preset: "LQFP-48"}},
    {id: "starter-usbc-16", name: "USB-C receptacle, 16-pin (USB 2.0)", category: "Connectors", prefix: "J", value: "USB-C", params: params("USB-C 2.0", "", "20 V", "3 A"),
      sym: () => boxed([["A4B9", "VBUS", 7, "top"], ["B4A9", "VBUS", 7, "top"], ["A5", "CC1", 1, "right"], ["B5", "CC2", 1, "right"], ["A6", "D+", 1, "right"], ["A7", "D−", 1, "right"],
        ["B6", "D+", 1, "right"], ["B7", "D−", 1, "right"], ["A8", "SBU1", 1, "right"], ["B8", "SBU2", 1, "right"], ["A1B12", "GND", 7, "bottom"], ["B1A12", "GND", 7, "bottom"], ["S1", "SHIELD", 4, "bottom"]]),
      foot: FP.usbc, note: "Generic land pattern. Check it against the drawing of the connector you buy."},
    ...[[1, 2], [1, 3], [1, 4], [1, 6], [1, 8], [2, 3], [2, 5], [2, 10]].map(([r, c]) => header(r, c)),
    {id: "starter-xtal-3225", name: "Crystal 3225, 4-pad", category: "Frequency control", prefix: "Y", value: "16 MHz", params: params("16 MHz", "20 ppm"), sym: crystal, foot: FP.crystal3225},
    {id: "starter-sw-tact", name: "Tactile switch 6×6 mm", category: "Switches", prefix: "SW", value: "Tactile", params: params("Tactile 6×6", "", "12 V", "50 mA"), sym: SWITCH, foot: FP.tactile},
    {id: "starter-tp-1mm", name: "Test point, 1.0 mm pad", category: "Test points", prefix: "TP", value: "TP", params: params("TP"), sym: TP, foot: FP.testpoint},
    {id: "starter-mh-m2", name: "Mounting hole M2", category: "Mounting holes", prefix: "H", value: "M2", params: params("M2"), foot: () => FP.hole("M2", 2.2, 4)},
    {id: "starter-mh-m3", name: "Mounting hole M3", category: "Mounting holes", prefix: "H", value: "M3", params: params("M3"), foot: () => FP.hole("M3", 3.2, 6)},
    {id: "starter-fid-1mm", name: "Fiducial 1 mm", category: "Fiducials", prefix: "FID", value: "Fiducial", params: params("Fiducial"), foot: FP.fiducial},
    {id: "starter-nettie-2", name: "Net tie, 2-pad", category: "Net ties", prefix: "NT", value: "Net tie", params: params("Net tie"), sym: TIE, foot: FP.netTie}
  ];

  let serialized, readOnly;
  function build() {
    if (!L()?.buildSymbol || !W()?.generate) throw Error("The starter library needs the library editor modules.");
    return PARTS.map(p => {
      const def = {id: p.id, name: p.name, category: p.category, prefix: p.prefix, value: p.value, parameters: {...p.params}, source: "atrium-starter"};
      const pkg = packageOf(p);
      if (pkg) def.package = pkg;
      // Generic on purpose: no manufacturer or supplier part numbers are invented here.
      // Lower-case the first letter only for ordinary words ("Resistor" -> "resistor"), not acronyms ("LED", "MOSFET").
      const lead = /^[A-Z][a-z]/.test(p.name) ? p.name.charAt(0).toLowerCase() + p.name.slice(1) : p.name;
      def.description = "Generic " + lead + (p.value ? ", " + p.value : "") + ". Not a specific part: choose one and fill in its LCSC # (or MPN) before ordering." + (p.note ? " " + p.note : "");
      if (p.sym) { const s = p.sym(); def.symbol = s.symbol; if (s.schDrawing) def.schDrawing = s.schDrawing; }
      if (p.foot) {
        const f = typeof p.foot === "function" ? p.foot() : wizard(p.foot);
        if (p.fpName) f.name = p.fpName;
        if (p.art) f.shapes.push(...p.art.map(clone));
        def.footprint = clearSilk(f);
      }
      return def;
    });
  }
  function defs() {
    serialized ??= JSON.stringify(build());
    return JSON.parse(serialized);
  }
  function freeze(value) {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  function templates() { return readOnly ??= freeze(defs()); }
  const ids = () => PARTS.map(p => p.id);
  function addTo(project) {
    const have = new Set(project.library.map(d => d.id));
    const add = defs().filter(d => !have.has(d.id));
    project.library.push(...add);
    return add.length;
  }
  return Object.freeze({defs, templates, ids, addTo, count: PARTS.length});
})();
