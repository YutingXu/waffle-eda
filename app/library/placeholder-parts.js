"use strict";
// Placeholder components (docs/design/library-management.md §14): draw the circuit now, choose the chip
// later. Each placeholder is a generic part (generic-parts.js) whose symbol is generated from its
// parameters by the Symbol Wizard's layout core; nothing draws a symbol of its own.
//
//   families: opamp, comparator, bjt, mosfet, ldo, logic, memory, mcu, switch (diodes, LEDs and the
//   passives are the existing generic families)
//   def.generic = {v, family, role: "placeholder", params, package, fields, digest}; the id is a hash of
//   those, so two dual op-amps share one definition and regenerating is identical byte for byte.
//   pin.fn: a function tag from a small vocabulary (IN+, IN-, OUT, V+, V-, GND, VIN, VOUT, EN, PG, FB,
//   NR, B/C/E, G/D/S, A<n>, DQ<n>, IO<n>, CS#, WE#, OE#, CLK, MOSI, MISO, WP#, HOLD#, SDA, SCL, TX, RX,
//   USB_D+, USB_D-, SWDIO, SWCLK, RESET#, GPIO<n>, IN<n>, COM, NO, NC, A, B).
//   footprint: none (symbol only; layout waits) or a provisional wizard package (footprint.provisional).
//
//   infer(name, family)                 -> {fn, unit} | null   a library pin's function from its name
//   mapping(project, part, def)         -> {map, missing, unused, inferred, connected}  by function, units in order
//   candidates(project, part, o)        -> ranked existing library components that cover every connected function
//   resolve(project, part, defId, o)    -> report; the placeholder becomes defId through the generic retarget
//                                         path (wires follow pins, net labels where they cannot); part.resolvedFrom
//   revert(project, part)               -> back to the placeholder (from part.resolvedFrom)
//   unresolved(project)                 -> [{ref, family, part, doc}]  (BOM status, Design Insights)
// Never writes a manufacturer part number: candidates are only components the library already has.
globalThis.AtriumPlaceholders = (() => {
  const GP = () => globalThis.AtriumGenericParts, SW = () => globalThis.AtriumSymbolWizard, L = () => globalThis.AtriumLibrary;
  const A = () => globalThis.Atrium, W = () => globalThis.AtriumFootprintWizard;
  const fail = m => { throw Error(m); };
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const clone = v => JSON.parse(JSON.stringify(v));
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const bool = v => v === true || v === "true" || v === 1;
  const pick = (v, list, d) => list.includes(v) ? v : d;
  const LETTER = "ABCDEF";
  const P = {IN: 0, IO: 1, OUT: 2, OC: 3, PAS: 4, HIZ: 5, PWR: 7};

  // ------------------------------------------------------------------ pin tables
  // row: [fn, name, electrical, unit (0 = shared), side?]
  const row = (fn, name, type, unit = 0, side) => ({fn, name, type, unit, ...(side ? {side} : {})});
  const analogUnit = (u, out = P.OUT) => [row("IN+", "IN+", P.IN, u), row("IN-", "IN-", P.IN, u), row("OUT", "OUT", out, u)];
  const supplies = (pos = "V+", neg = "V-") => [row(pos, pos === "V+" ? "V+" : pos, P.PWR), row(neg, neg === "V-" ? "V-" : neg, P.PWR)];
  const PACKAGES = {"SOT-23-3": ["sot23", "SOT-23-3"], "SOT-23-5": ["sot23", "SOT-23-5"], "SOT-23-6": ["sot23", "SOT-23-6"], "SOT-223": ["sot223", "SOT-223"],
    "SOIC-8": ["gullwing", "SOIC-8"], "SOIC-14": ["gullwing", "SOIC-14"], "TSSOP-14": ["gullwing", "TSSOP-14"]};
  // Pinouts: fn|unit -> pad number. NC fills the rest. These are the common industry pinouts of each
  // package (LMV321, LM358, LM324, LMV331, LM393, LM339, 74LVC1G08/04/125, 74HC08/04, 25-series SPI flash).
  const OPAMP_PIN = {
    "1|SOT-23-5": {"OUT|1": 1, "V-|0": 2, "IN+|1": 3, "IN-|1": 4, "V+|0": 5}, "1|SOT-23-6": {"OUT|1": 1, "V-|0": 2, "IN+|1": 3, "IN-|1": 4, "EN|0": 5, "V+|0": 6},
    "1|SOIC-8": {"IN-|1": 2, "IN+|1": 3, "V-|0": 4, "OUT|1": 6, "V+|0": 7, "EN|0": 8},
    "2|SOIC-8": {"OUT|1": 1, "IN-|1": 2, "IN+|1": 3, "V-|0": 4, "IN+|2": 5, "IN-|2": 6, "OUT|2": 7, "V+|0": 8},
    "4|SOIC-14": {"OUT|1": 1, "IN-|1": 2, "IN+|1": 3, "V+|0": 4, "IN+|2": 5, "IN-|2": 6, "OUT|2": 7, "OUT|3": 8, "IN-|3": 9, "IN+|3": 10, "V-|0": 11, "IN+|4": 12, "IN-|4": 13, "OUT|4": 14}};
  OPAMP_PIN["4|TSSOP-14"] = OPAMP_PIN["4|SOIC-14"];
  const COMP_PIN = {"1|SOT-23-5": {"IN+|1": 1, "V-|0": 2, "IN-|1": 3, "OUT|1": 4, "V+|0": 5}, "2|SOIC-8": OPAMP_PIN["2|SOIC-8"],
    "4|SOIC-14": {"OUT|2": 1, "OUT|1": 2, "V+|0": 3, "IN-|1": 4, "IN+|1": 5, "IN-|2": 6, "IN+|2": 7, "IN-|3": 8, "IN+|3": 9, "IN-|4": 10, "IN+|4": 11, "V-|0": 12, "OUT|4": 13, "OUT|3": 14}};
  const LOGIC_PIN = {"1|2|SOT-23-5": {"IN1|1": 1, "IN2|1": 2, "GND|0": 3, "OUT|1": 4, "V+|0": 5}, "1|1|SOT-23-5": {"IN1|1": 2, "GND|0": 3, "OUT|1": 4, "V+|0": 5},
    "t|1|1|SOT-23-5": {"OE#|1": 1, "IN1|1": 2, "GND|0": 3, "OUT|1": 4, "V+|0": 5},
    "4|2|SOIC-14": {"IN1|1": 1, "IN2|1": 2, "OUT|1": 3, "IN1|2": 4, "IN2|2": 5, "OUT|2": 6, "GND|0": 7, "OUT|3": 8, "IN1|3": 9, "IN2|3": 10, "OUT|4": 11, "IN1|4": 12, "IN2|4": 13, "V+|0": 14},
    "6|1|SOIC-14": {"IN1|1": 1, "OUT|1": 2, "IN1|2": 3, "OUT|2": 4, "IN1|3": 5, "OUT|3": 6, "GND|0": 7, "OUT|4": 8, "IN1|4": 9, "OUT|5": 10, "IN1|5": 11, "OUT|6": 12, "IN1|6": 13, "V+|0": 14}};
  const SPI_PIN = {"CS#|0": 1, "MISO|0": 2, "WP#|0": 3, "GND|0": 4, "MOSI|0": 5, "CLK|0": 6, "HOLD#|0": 7, "V+|0": 8};
  const QSPI_PIN = {"CS#|0": 1, "IO1|0": 2, "IO2|0": 3, "GND|0": 4, "IO0|0": 5, "CLK|0": 6, "IO3|0": 7, "V+|0": 8};

  const opamp = (p, out) => { const rows = []; for (let u = 1; u <= p.units; u++) rows.push(...analogUnit(p.units > 1 ? u : 1, out)); rows.push(...supplies()); if (p.shutdown) rows.push(row("EN", "SHDN#", P.IN)); return rows; };
  const FAMILIES = {
    opamp: {title: "Op-amp", prefix: "U", category: "Amplifiers", value: "Op-amp",
      params: p => ({units: pick(int(p.units, 1, 4, 1), [1, 2, 4], 1), power: pick(p.power, ["shared", "separate"], "shared"), shutdown: bool(p.shutdown)}),
      packages: p => p.shutdown ? (p.units === 1 ? ["SOT-23-6", "SOIC-8"] : []) : p.units === 1 ? ["SOT-23-5", "SOIC-8"] : p.units === 2 ? ["SOIC-8"] : ["SOIC-14", "TSSOP-14"],
      pins: p => opamp(p), pinout: (p, pkg) => OPAMP_PIN[p.units + "|" + pkg],
      fields: [["GBW", "Gain bandwidth", null, ""], ["Rail-to-rail", "Rail-to-rail", ["Input", "Output", "Input and output"], ""], ["Supply", "Supply range", null, ""]],
      label: p => (p.units > 1 ? (p.units === 2 ? "dual " : "quad ") : "") + "op-amp"},
    comparator: {title: "Comparator", prefix: "U", category: "Comparators", value: "Comparator",
      params: p => ({units: pick(int(p.units, 1, 4, 1), [1, 2, 4], 1), power: pick(p.power, ["shared", "separate"], "shared"), output: pick(p.output, ["push-pull", "open-drain"], "push-pull")}),
      packages: p => p.units === 1 ? ["SOT-23-5"] : p.units === 2 ? ["SOIC-8"] : ["SOIC-14"],
      pins: p => opamp({...p, shutdown: false}, p.output === "open-drain" ? P.OC : P.OUT), pinout: (p, pkg) => COMP_PIN[p.units + "|" + pkg],
      fields: [["Hysteresis", "Hysteresis", null, ""], ["Supply", "Supply range", null, ""]],
      label: p => (p.units > 1 ? (p.units === 2 ? "dual " : "quad ") : "") + (p.output === "open-drain" ? "open-drain " : "") + "comparator"},
    bjt: {title: "Transistor (BJT)", prefix: "Q", category: "Transistors",
      params: p => ({polarity: pick(p.polarity, ["npn", "pnp"], "npn")}), packages: () => ["SOT-23-3"],
      pins: () => [row("B", "B", P.PAS, 0, "left"), row("C", "C", P.PAS, 0, "right"), row("E", "E", P.PAS, 0, "right")], pinout: () => ({"B|0": 1, "E|0": 2, "C|0": 3}),
      fields: [["Vce", "Max. Vce", null, ""], ["Ic", "Max. Ic", null, ""]], value: p => p.polarity.toUpperCase(), label: p => p.polarity.toUpperCase() + " transistor"},
    mosfet: {title: "MOSFET", prefix: "Q", category: "Transistors",
      params: p => ({polarity: pick(p.polarity, ["n", "p"], "n")}), packages: () => ["SOT-23-3"],
      pins: () => [row("G", "G", P.IN, 0, "left"), row("D", "D", P.PAS, 0, "right"), row("S", "S", P.PAS, 0, "right")], pinout: () => ({"G|0": 1, "S|0": 2, "D|0": 3}),
      fields: [["Vds", "Max. Vds", null, ""], ["Id", "Max. Id", null, ""], ["Rds(on)", "Rds(on)", null, ""]], value: p => p.polarity.toUpperCase() + "-channel", label: p => p.polarity.toUpperCase() + "-channel MOSFET"},
    ldo: {title: "LDO regulator", prefix: "U", category: "Power management", value: "LDO",
      params: p => ({en: p.en === undefined ? true : bool(p.en), pg: bool(p.pg), fb: bool(p.fb), nr: bool(p.nr)}),
      packages: p => { const n = 3 + ["en", "pg", "fb", "nr"].filter(k => p[k]).length; return [...(n === 3 ? ["SOT-223"] : []), ...(n <= 5 ? ["SOT-23-5"] : n === 6 ? ["SOT-23-6"] : [])]; },
      pins: p => [row("VIN", "VIN", P.PWR, 0, "left"), ...(p.en ? [row("EN", "EN", P.IN, 0, "left")] : []), ...(p.nr ? [row("NR", "NR", P.PAS, 0, "left")] : []),
        row("VOUT", "VOUT", P.PWR, 0, "right"), ...(p.fb ? [row("FB", "FB", P.IN, 0, "right")] : []), ...(p.pg ? [row("PG", "PG", P.OC, 0, "right")] : []), row("GND", "GND", P.PWR, 0, "bottom")],
      pinout: (p, pkg) => {
        if (pkg === "SOT-223") return {"GND|0": 1, "VOUT|0": 2, "VIN|0": 3, "VOUT|0#2": 4};
        const order = ["VIN", "GND", ...["EN", "FB", "NR", "PG"].filter(k => p[k.toLowerCase()])], n = pkg === "SOT-23-6" ? 6 : 5, out = {};
        order.forEach((f, i) => { out[f + "|0"] = i + 1; }); out["VOUT|0"] = n; return out;
      },
      fields: [["Vout", "Output voltage", null, ""], ["Iout", "Output current", null, ""]], label: p => (p.fb ? "adjustable " : "") + "LDO"},
    logic: {title: "Logic gate", prefix: "U", category: "Logic",
      params: p => {
        const fn = pick(p.function, ["and", "nand", "or", "nor", "xor", "xnor", "not", "buffer", "tristate"], "and");
        const single = fn === "not" || fn === "buffer" || fn === "tristate";
        return {function: fn, inputs: single ? 1 : int(p.inputs, 2, 4, 2), units: int(p.units, 1, 6, 1), schmitt: bool(p.schmitt)};
      },
      packages: p => { const t = p.function === "tristate" ? "t|" : ""; return Object.keys(LOGIC_PIN).filter(k => k.startsWith(t + p.units + "|" + p.inputs + "|") && (t || !k.startsWith("t|"))).map(k => k.split("|").pop()); },
      pins: p => {
        const rows = [];
        for (let u = 1; u <= p.units; u++) {
          for (let i = 1; i <= p.inputs; i++) rows.push(row("IN" + i, LETTER[i - 1], P.IN, u));
          if (p.function === "tristate") rows.push(row("OE#", "OE#", P.IN, u));
          rows.push(row("OUT", "Y", p.function === "tristate" ? P.HIZ : P.OUT, u));
        }
        return [...rows, row("V+", "VCC", P.PWR), row("GND", "GND", P.PWR)];
      },
      pinout: (p, pkg) => LOGIC_PIN[(p.function === "tristate" ? "t|" : "") + p.units + "|" + p.inputs + "|" + pkg],
      fields: [["Logic family", "Logic family", null, ""], ["Supply", "Supply range", null, ""]],
      value: p => p.function.toUpperCase() + (p.schmitt ? " (Schmitt)" : ""),
      label: p => (p.units > 1 ? p.units + "× " : "") + (p.inputs > 1 ? p.inputs + "-input " : "") + p.function.toUpperCase() + (p.function === "tristate" ? " buffer" : " gate")},
    memory: {title: "Memory", prefix: "U", category: "Memory",
      params: p => {
        const bus = pick(p.bus, ["parallel", "spi", "qspi"], "parallel");
        return {type: pick(p.type, ["sram", "dram", "nor", "nand", "eeprom", "fram"], bus === "parallel" ? "sram" : "nor"), bus,
          ...(bus === "parallel" ? {address: int(p.address, 1, 32, 16), data: int(p.data, 1, 32, 8)} : {})};
      },
      packages: p => p.bus === "parallel" ? [] : ["SOIC-8"],
      pins: p => p.bus === "spi" ? [row("CS#", "CS#", P.IN), row("CLK", "CLK", P.IN), row("MOSI", "DI", P.IN), row("MISO", "DO", P.OUT), row("WP#", "WP#", P.IN), row("HOLD#", "HOLD#", P.IN), row("V+", "VCC", P.PWR), row("GND", "GND", P.PWR)]
        : p.bus === "qspi" ? [row("CS#", "CS#", P.IN), row("CLK", "CLK", P.IN), ...[0, 1, 2, 3].map(i => row("IO" + i, "IO" + i, P.IO)), row("V+", "VCC", P.PWR), row("GND", "GND", P.PWR)]
        : [...Array.from({length: p.address}, (_, i) => row("A" + i, "A" + i, P.IN)), ...Array.from({length: p.data}, (_, i) => row("DQ" + i, "DQ" + i, P.IO)),
          row("CS#", "CS#", P.IN), row("WE#", "WE#", P.IN), row("OE#", "OE#", P.IN), row("V+", "VCC", P.PWR), row("GND", "GND", P.PWR)],
      pinout: p => p.bus === "spi" ? SPI_PIN : p.bus === "qspi" ? QSPI_PIN : null,
      fields: [["Capacity", "Capacity", null, ""], ["Speed", "Speed", null, ""]],
      value: p => p.type.toUpperCase(), label: p => (p.bus === "parallel" ? "parallel " : p.bus === "spi" ? "SPI " : "QSPI ") + p.type.toUpperCase()},
    mcu: {title: "MCU / FPGA block", prefix: "U", category: "Microcontrollers", value: "MCU",
      params: p => ({gpio: int(p.gpio, 0, 64, 8), spi: int(p.spi, 0, 3, 1), i2c: int(p.i2c, 0, 3, 1), uart: int(p.uart, 0, 4, 1), usb: bool(p.usb), swd: p.swd === undefined ? true : bool(p.swd)}),
      packages: () => [],
      pins: p => {
        const rows = [row("V+", "VDD", P.PWR), row("GND", "GND", P.PWR), row("RESET#", "NRST", P.IN)];
        for (let i = 0; i < p.gpio; i++) rows.push(row("GPIO" + i, "GPIO" + i, P.IO));
        for (let i = 1; i <= p.spi; i++) rows.push(row("CLK", "SPI" + i + "_SCK", P.OUT, i), row("MOSI", "SPI" + i + "_MOSI", P.OUT, i), row("MISO", "SPI" + i + "_MISO", P.IN, i), row("CS#", "SPI" + i + "_CS", P.OUT, i));
        for (let i = 1; i <= p.i2c; i++) rows.push(row("SDA", "I2C" + i + "_SDA", P.IO, i), row("SCL", "I2C" + i + "_SCL", P.IO, i));
        for (let i = 1; i <= p.uart; i++) rows.push(row("TX", "UART" + i + "_TX", P.OUT, i), row("RX", "UART" + i + "_RX", P.IN, i));
        if (p.usb) rows.push(row("USB_D+", "USB_DP", P.IO), row("USB_D-", "USB_DM", P.IO));
        if (p.swd) rows.push(row("SWDIO", "SWDIO", P.IO), row("SWCLK", "SWCLK", P.IN));
        // Bus instances are groups, not gates: one body.
        return rows.map(r => ({...r, group: r.unit, unit: 0}));
      },
      pinout: () => null, fields: [["Core", "Core", null, ""], ["Flash", "Flash", null, ""]], label: () => "MCU block"},
    switch: {title: "Switch", prefix: "SW", category: "Switches",
      params: p => ({type: pick(p.type, ["spst", "spdt", "tactile"], "spst")}), packages: () => [],
      pins: p => p.type === "spdt" ? [row("COM", "COM", P.PAS, 0, "left"), row("NO", "NO", P.PAS, 0, "right"), row("NC", "NC", P.PAS, 0, "right")]
        : p.type === "tactile" ? [row("A", "1", P.PAS, 0, "left"), row("A", "2", P.PAS, 0, "left"), row("B", "3", P.PAS, 0, "right"), row("B", "4", P.PAS, 0, "right")]
        : [row("A", "1", P.PAS, 0, "left"), row("B", "2", P.PAS, 0, "right")],
      pinout: () => null, fields: [["Rating", "Rating", null, ""]], value: p => p.type.toUpperCase(), label: p => p.type === "tactile" ? "tactile switch" : p.type.toUpperCase() + " switch"}
  };
  const ORDER = ["opamp", "comparator", "bjt", "mosfet", "ldo", "logic", "memory", "mcu", "switch"];
  const isPlaceholder = def => !!def && obj(def.generic) && def.generic.role === "placeholder";
  const FAMILY_NAME = f => FAMILIES[f]?.title || f;

  // ------------------------------------------------------------------ definitions
  function normalise(spec) {
    const F = FAMILIES[spec.family] || fail("Unknown placeholder family " + String(spec.family).slice(0, 40) + ". Use one of: " + ORDER.join(", ") + ".");
    const params = F.params(obj(spec.params) ? spec.params : spec);
    const offered = F.packages(params);
    let pkg = spec.package === undefined ? (offered[0] || "") : spec.package == null || spec.package === "none" ? "" : String(spec.package);
    if (pkg && !offered.includes(pkg)) fail("A " + F.label(params) + " placeholder has no package " + pkg.slice(0, 40) + ". Choose " + (offered.length ? offered.join(", ") + " or " : "") + "none.");
    return {family: spec.family, role: "placeholder", params, package: pkg};
  }
  // Rows numbered for the package (its pinout) or 1..n without one; NC rows fill unused pads.
  function numbered(F, params, pkg) {
    const rows = F.pins(params), pinout = pkg ? F.pinout(params, pkg) : null;
    if (!pinout) return rows.map((r, i) => ({...r, number: String(i + 1)}));
    const used = new Set(), out = [];
    for (const r of rows) {
      let n = pinout[r.fn + "|" + r.unit];
      if (n == null || used.has(n)) continue; // e.g. EN on a package without one: the row is not on this package
      used.add(n); out.push({...r, number: String(n)});
    }
    for (const [k, n] of Object.entries(pinout)) if (k.includes("#2") && !used.has(n)) { const base = rows.find(r => r.fn + "|" + r.unit === k.split("#")[0]); if (base) { used.add(n); out.push({...base, number: String(n)}); } }
    const total = PACKAGES[pkg] ? padCount(pkg) : 0;
    for (let n = 1; n <= total; n++) if (!used.has(n)) out.push({fn: "", name: "NC", type: "nc", unit: 0, number: String(n)});
    return out.sort((a, b) => Number(a.number) - Number(b.number));
  }
  const padCount = pkg => Number(/-(\d+)$/.exec(pkg)?.[1] || (pkg === "SOT-223" ? 4 : 0));
  function footprint(pkg) {
    const [fam, preset] = PACKAGES[pkg];
    const fp = W().generate({...W().defaults(fam, preset), symbol: false, id: "ph-tmp"}).footprint;
    delete fp.wizard;
    fp.provisional = true;
    return fp;
  }
  function make(n) {
    const F = FAMILIES[n.family], p = n.params;
    if (!SW()?.build || !W()?.generate) fail("Placeholders need the Symbol Wizard and the footprint wizard (symbol-wizard.js, footprint-wizard.js).");
    const rows = numbered(F, p, n.package);
    const units = Math.max(0, ...rows.map(r => r.unit));
    const gates = units > 1 || (p.power === "separate" && units >= 1 && n.family !== "mcu");
    const pins = rows.map((r, i) => {
      const nc = r.type === "nc";
      // Power on every unit (part 0) or in its own unit; no-connect pads sit on the last unit only.
      const last = p.power === "separate" ? units + 1 : units;
      const unit = !gates ? undefined : r.unit ? r.unit : nc ? last : (p.power === "separate" && r.type === P.PWR ? units + 1 : 0);
      return {key: "r" + i, row: i, number: r.number, typed: r.name, base: r.name, low: false, name: r.name, electrical: nc ? 4 : r.type, nc, alternates: [], description: "",
        include: true, ...(r.side ? {side: r.side} : {}), ...(unit !== undefined ? {part: unit} : {})};
    });
    const label = F.label(p);
    const {def} = SW().build(pins, {layout: gates ? "gates" : "function", name: label, prefix: F.prefix});
    const byKey = new Map(rows.map(r => [r.number, r]));
    for (const pin of def.symbol.pins) { const r = byKey.get(String(pin.number)); if (r?.fn) pin.fn = r.fn; }
    const value = typeof F.value === "function" ? F.value(p) : F.value;
    const out = {id: "", name: label[0].toUpperCase() + label.slice(1) + " (placeholder" + (n.package ? ", " + n.package : "") + ")", category: "Placeholders", prefix: F.prefix, value,
      description: "Placeholder " + label + (n.package ? " with a provisional " + n.package + " footprint" : ", symbol only") + ". Resolve it to a real component before ordering.",
      package: n.package || "", symbol: def.symbol, ...(def.schDrawing ? {schDrawing: def.schDrawing} : {})};
    if (n.package) out.footprint = footprint(n.package);
    return out;
  }
  const impl = {
    normalise, make, shapeKeys: ["params", "package"], title: def => FAMILIES[def.generic.family]?.label(def.generic.params) || def.name, value: def => def.value,
    fields: def => FAMILIES[def?.generic?.family]?.fields || [],
    summary: def => ({role: "placeholder", params: clone(def.generic.params || {}), provisional: !!def.footprint?.provisional, gates: def.symbol?.parts || 1})
  };
  function install() {
    const G = GP();
    if (!G?.registerFamily || install.done) return !!install.done;
    for (const f of ORDER) G.registerFamily(f, impl);
    install.done = true;
    return true;
  }

  // ------------------------------------------------------------------ function inference
  // A library pin's function, from its name: "+INA" -> IN+ unit 1, "2OUT" -> OUT unit 2, "~{CS}" -> CS#.
  const NAMES = {
    analog: [["IN+", /^(IN\+|\+IN|INP|IN_P|NONINV|VIN\+|NI)$/], ["IN-", /^(IN-|-IN|INN|IN_N|INV|VIN-)$/], ["OUT", /^(OUT|VO|VOUT|O|OUTPUT)$/],
      ["V+", /^(V\+|VCC|VDD|VS\+|\+VS|VS|AVDD|VCC\+|V\+S)$/], ["V-", /^(V-|VEE|VSS|VS-|-VS|GND|AGND|V-S)$/], ["EN", /^(EN|ENABLE|SHDN|SD|CE|SHUTDOWN)$/]],
    ldo: [["VIN", /^(VIN|IN|VI|VCC|VDD|INPUT)$/], ["VOUT", /^(VOUT|OUT|VO|OUTPUT)$/], ["GND", /^(GND|VSS|PGND|AGND|GROUND)$/], ["EN", /^(EN|ENABLE|SHDN|CE|ON|ON\/OFF)$/],
      ["PG", /^(PG|PGOOD|POK|PWRGD|FLAG|PWR_GD)$/], ["FB", /^(FB|ADJ|SENSE|SNS)$/], ["NR", /^(NR|BYP|BYPASS|NR\/SS|SS|NR_SS)$/]],
    bjt: [["B", /^(B|BASE)$/], ["C", /^(C|COLLECTOR)$/], ["E", /^(E|EMITTER)$/]],
    mosfet: [["G", /^(G|GATE)$/], ["D", /^(D|DRAIN)$/], ["S", /^(S|SOURCE)$/]],
    logic: [["IN1", /^(A|I0|IN1|IN|I)$/], ["IN2", /^(B|I1|IN2)$/], ["IN3", /^(C|I2|IN3)$/], ["IN4", /^(D|I3|IN4)$/], ["OUT", /^(Y|Q|OUT|O)$/], ["OE#", /^(OE|G|EN)$/],
      ["V+", /^(VCC|VDD|V\+)$/], ["GND", /^(GND|VSS)$/]],
    memory: [["CS#", /^(CS|CE|SS|NCS)$/], ["WE#", /^(WE|W)$/], ["OE#", /^(OE|G)$/], ["CLK", /^(CLK|SCK|SCLK|C)$/], ["MOSI", /^(MOSI|DI|SI|SDI)$/], ["MISO", /^(MISO|DO|SO|SDO)$/],
      ["WP#", /^(WP|IO2)$/], ["HOLD#", /^(HOLD|RESET|IO3)$/], ["V+", /^(VCC|VDD|VCCQ)$/], ["GND", /^(GND|VSS|VSSQ)$/]],
    mcu: [["V+", /^(VDD\w*|VCC\w*|VBAT|DVDD|IOVDD)$/], ["GND", /^(VSS\w*|GND\w*|EP|EPAD)$/], ["RESET#", /^(NRST|RESET|RST|MCLR|XRES)$/], ["SWDIO", /^(SWDIO|SWD|TMS)$/], ["SWCLK", /^(SWCLK|TCK)$/],
      ["USB_D+", /^(USB_?D[P+]|D\+|DP)$/], ["USB_D-", /^(USB_?D[MN-]|D-|DM)$/], ["SDA", /SDA$/], ["SCL", /SCL$/], ["TX", /(TX|TXD)$/], ["RX", /(RX|RXD)$/],
      ["CLK", /(SCK|SCLK)$/], ["MOSI", /MOSI$/], ["MISO", /MISO$/], ["CS#", /(NSS|CS|SS)$/], ["GPIO", /^(P[A-K]\d{1,2}|GPIO\d+|IO\d+|P\d+[._]\d+|D\d+)$/]],
    switch: [["COM", /^(COM|C|1)$/], ["NO", /^(NO|2)$/], ["NC", /^(NC|3)$/]]
  };
  const GROUP = {opamp: "analog", comparator: "analog"};
  function infer(raw, family) {
    let s = String(raw ?? "").normalize("NFKC").toUpperCase().replace(/\s+/g, "").replace(/̅/g, "");
    let m;
    if ((m = /^~\{(.+)\}$/.exec(s))) s = m[1];
    s = s.replace(/^[~!/]/, "").replace(/(#|_N|_B)$/, "");
    const table = NAMES[GROUP[family] || family];
    if (!table) return null;
    const test = (name, unit) => { for (const [fn, re] of table) if (re.test(name)) return {fn, unit}; return null; };
    if (family === "memory") {
      if ((m = /^A(\d{1,2})$/.exec(s))) return {fn: "A" + +m[1], unit: 0};
      if ((m = /^(?:DQ|D|IO)(\d{1,2})$/.exec(s))) return {fn: "DQ" + +m[1], unit: 0, io: "IO" + +m[1]};
    }
    const direct = test(s, 0);
    if (direct && family !== "logic") return direct;
    const unit = c => /\d/.test(c) ? +c : LETTER.indexOf(c) + 1;
    // Channel forms: 1IN+, 2OUT, 1A, 1Y | INA+, OUTA | +INA | IN1+, OUT1
    for (const re of [/^(\d)(.+)$/, /^(.+?)([A-D])([+-])$/, /^(OUT|VOUT)([A-D])$/, /^([+-])IN([A-D])$/, /^IN([1-4])([+-])$/, /^OUT([1-4])$/]) {
      const x = re.exec(s);
      if (!x) continue;
      let name, u;
      if (re.source.startsWith("^(\\d)")) { u = +x[1]; name = x[2]; }
      else if (re.source.startsWith("^(.+?)([A-D])")) { name = x[1] + x[3]; u = unit(x[2]); }
      else if (re.source.startsWith("^(OUT|VOUT)")) { name = x[1]; u = unit(x[2]); }
      else if (re.source.startsWith("^([+-])")) { name = x[1] + "IN"; u = unit(x[2]); }
      else if (re.source.startsWith("^IN(")) { name = "IN" + x[2]; u = +x[1]; }
      else { name = "OUT"; u = +x[1]; }
      const hit = test(name, u);
      if (hit) return hit;
    }
    return direct ? {...direct, unit: family === "logic" && direct.unit === 0 ? 1 : direct.unit} : null;
  }
  // Functions that count as one another (single-supply op-amps call V- GND).
  const SAME = {"V-": ["V-", "GND"], "GND": ["GND", "V-"]};
  const shared = fn => ["V+", "V-", "GND", "VIN", "VOUT", "EN", "PG", "FB", "NR", "RESET#", "SWDIO", "SWCLK", "USB_D+", "USB_D-"].includes(fn) || /^(A|DQ|IO)\d+$/.test(fn);
  const norm = fn => /^GPIO\d+$/.test(fn) ? "GPIO" : fn;

  // ------------------------------------------------------------------ mapping and candidates
  function members(project, part) { return GP().family(project, part); }
  // Placeholder pins with a connection somewhere (a named net, a net with other pins, or a board net).
  function connected(project, part, def) {
    const out = new Set(), defs = new Map(project.library.map(d => [d.id, d]));
    for (const [d, i] of members(project, part)) {
      if (d.kind === "schematic") {
        const net = A().connectivity(d, defs), counts = new Map();
        for (const v of net.byPin.values()) counts.set(v, (counts.get(v) || 0) + 1);
        for (const p of A().pins(i, def, "schematic")) { const n = net.byPin.get(i.id + "/" + p.number); if (n && (!/^Net-/.test(n) || counts.get(n) > 1)) out.add(String(p.number)); }
      } else for (const [k, v] of Object.entries(i.pinNets || {})) if (v) out.add(String(k));
    }
    return out;
  }
  function candidatePins(def, family) {
    const multi = (def.symbol?.parts || 1) > 1;
    return (def.symbol?.pins || []).map(p => {
      const got = p.fn ? {fn: p.fn, unit: 0} : infer(p.name, family) || (family === "switch" ? {fn: "", unit: 0} : null);
      if (!got) return null;
      const unit = multi ? (p.part || 0) : (got.unit ? (got.unit === 1 ? 1 : -got.unit) : 0);
      return {pin: p, fn: norm(got.fn), alt: got.io || null, unit, inferred: !p.fn};
    }).filter(Boolean);
  }
  // map: placeholder pin number -> candidate pin number. Units map in order: placeholder unit 2 -> gate B.
  // A single-gate candidate whose pins name their channel (OUTA, OUTB) only serves unit 1; the rest
  // need a candidate with one gate per channel, so nothing moves to a gate that does not exist.
  function mapping(project, part, def, o = {}) {
    const ph = project.library.find(d => d.id === part.def);
    if (!isPlaceholder(ph)) fail("That part is not a placeholder.");
    const family = ph.generic.family, conn = o.connected || connected(project, part, ph);
    const pool = candidatePins(def, family), used = new Set(), map = {}, inferred = new Set();
    const pins = (ph.symbol?.pins || []).filter(p => p.fn).sort((a, b) => conn.has(String(b.number)) - conn.has(String(a.number)));
    for (const p of pins) {
      const fn = norm(p.fn), u = (ph.symbol.parts || 1) > 1 ? (p.part || 0) : 1, ok = SAME[fn] || [fn];
      const fits = c => !used.has(c) && (ok.includes(c.fn) || (c.alt && c.alt === fn));
      let hit = null;
      if (shared(fn) || fn === "GPIO" || family === "mcu") hit = pool.find(c => fits(c) && c.unit <= 1 && c.unit >= 0) || pool.find(fits);
      else hit = pool.find(c => fits(c) && c.unit === u) || (u === 1 ? pool.find(c => fits(c) && c.unit === 0) : null);
      // Switch contacts: the same contact name (COM, NO, NC) or else the same pin number.
      if (family === "switch") {
        const same = c => !used.has(c) && String(c.pin.name || "").toUpperCase() === String(p.name || "").toUpperCase();
        hit = pool.find(same) || pool.find(c => !used.has(c) && String(c.pin.number) === String(p.number)) || null;
      }
      if (hit) { used.add(hit); map[String(p.number)] = String(hit.pin.number); if (hit.inferred) inferred.add(String(p.number)); }
    }
    if (o.manual) for (const [k, v] of Object.entries(o.manual)) if (v == null || v === "") delete map[k]; else map[k] = String(v);
    const missing = [...conn].filter(n => !map[n] && (ph.symbol.pins || []).some(p => String(p.number) === n && p.fn));
    const taken = new Set(Object.values(map));
    const unused = (def.symbol?.pins || []).filter(p => !taken.has(String(p.number))).map(p => ({number: String(p.number), name: p.name || "", gate: p.part || 0}));
    return {map, missing, unused, inferred: [...inferred], connected: [...conn]};
  }
  const MPN = /^(mpn|manufacturer part( number)?|part number)$/i;
  const prefixOf = def => String(def.prefix || "").toUpperCase();
  // Existing library components (project library, library sources, extra pools) that cover every
  // connected function, best first: complete coverage, then fewer spare functions, then a footprint.
  function candidates(project, part, o = {}) {
    const ph = project.library.find(d => d.id === part?.def);
    if (!isPlaceholder(ph)) fail("That part is not a placeholder.");
    const F = FAMILIES[ph.generic.family], conn = connected(project, part, ph);
    const pools = [{name: "Project library", defs: project.library}];
    if (o.sources !== false) try { for (const lib of L()?.sourceStore?.list?.() || []) pools.push({name: lib.name, library: lib.id, defs: lib.defs, lib}); } catch { /* storage unavailable */ }
    for (const extra of o.pools || []) pools.push(extra);
    const out = [];
    for (const pool of pools) for (const d of pool.defs || []) {
      if (!d?.symbol || obj(d.generic) || d.mirrorOf) continue;
      if (prefixOf(d) && F.prefix && prefixOf(d)[0] !== F.prefix[0] && !(F.prefix === "U" && /^(IC|U)/.test(prefixOf(d)))) continue;
      const m = mapping(project, part, d, {connected: conn});
      const covered = conn.size - m.missing.length;
      if (!Object.keys(m.map).length || (o.complete !== false && m.missing.length)) continue;
      const params = obj(d.parameters) ? d.parameters : {};
      out.push({def_id: d.id, source: pool.name, library: pool.library || null, name: d.name, footprint: d.footprint?.name || "", pins: d.symbol.pins.length,
        gates: d.symbol.parts || 1, covered, missing: m.missing, unused: m.unused.length, mapped: Object.keys(m.map).length, inferred: m.inferred.length,
        mpn: Object.entries(params).find(([k, v]) => MPN.test(k) && String(v).trim())?.[1] || "", def: d, lib: pool.lib || null, map: m.map,
        score: (m.missing.length ? 1000 * m.missing.length : 0) + m.unused.length + (d.footprint ? 0 : 50)});
    }
    return out.sort((a, b) => a.score - b.score || String(a.name).localeCompare(String(b.name), "en", {numeric: true}));
  }

  // ------------------------------------------------------------------ resolve and revert
  // The generic retarget matches pins by number, so the old definition is swapped, for the duration of
  // the call, for a copy whose pins carry the numbers they map to: wires follow the pins they belong to,
  // and where rerouting would change a net the pins are joined by net labels instead.
  function swap(project, part, from, to, map) {
    const k = project.library.indexOf(from);
    const tmp = clone(from);
    for (const p of tmp.symbol?.pins || []) p.number = map[String(p.number)] ?? "~" + p.number;
    if (!project.library.some(d => d.id === to.id)) project.library.push(to);
    const list = members(project, part);
    for (const [d, i] of list) if (d.kind === "pcb" && i.pinNets) i.pinNets = Object.fromEntries(Object.entries(i.pinNets).filter(([n]) => map[n] != null).map(([n, v]) => [map[n], v]));
    project.library[k] = tmp;
    let report;
    try { report = GP().retarget(project, part, to); }
    finally { project.library[k] = from; }
    return {report, members: list};
  }
  function resolve(project, part, defId, o = {}) {
    const ph = project.library.find(d => d.id === part?.def);
    if (!isPlaceholder(ph)) fail("That part is not a placeholder.");
    const def = project.library.find(d => d.id === defId) || fail("Add the component to the project library first.");
    if (isPlaceholder(def)) fail("Choose a real component, not another placeholder.");
    const m = mapping(project, part, def, {manual: o.mapping});
    if (m.missing.length && !o.force) return {designator: part.ref, refused: true, missing: m.missing,
      message: "Pins " + m.missing.join(", ") + " of " + part.ref + " are connected and have no matching pin on " + def.name + ". Map them by hand or pass force."};
    const g = ph.generic, from = {family: g.family, params: clone(g.params), package: g.package || "", digest: g.digest, def: ph.id, map: m.map};
    const {report, members: list} = swap(project, part, ph, def, m.map);
    for (const [, i] of list) i.resolvedFrom = clone(from);
    GP().prune(project);
    return {designator: part.ref, def_id: def.id, mapped: Object.keys(m.map).length, unused: m.unused, inferred: m.inferred, missing: m.missing, ...report};
  }
  function revert(project, part) {
    const r = part?.resolvedFrom;
    if (!obj(r) || !FAMILIES[r.family]) fail("That part was not resolved from a placeholder.");
    const def = project.library.find(d => d.id === part.def) || fail("The part's component is missing.");
    const ph = GP().ensure(project, {family: r.family, params: r.params, package: r.package || null});
    const back = Object.fromEntries(Object.entries(r.map || {}).map(([a, b]) => [b, a]));
    const {report, members: list} = swap(project, part, def, ph, back);
    for (const [, i] of list) delete i.resolvedFrom;
    return {designator: part.ref, def_id: ph.id, ...report};
  }
  function unresolved(project) {
    const defs = new Map((project?.library || []).map(d => [d.id, d])), seen = new Set(), out = [];
    for (const d of project?.documents || []) if (d.kind === "schematic") for (const i of d.items || []) {
      const def = i.kind === "part" && defs.get(i.def);
      if (!isPlaceholder(def) || seen.has(i.ref)) continue;
      seen.add(i.ref);
      out.push({ref: i.ref, family: def.generic.family, label: FAMILIES[def.generic.family]?.label(def.generic.params) || def.generic.family, footprint: !!def.footprint, part: i, doc: d});
    }
    return out.sort((a, b) => String(a.ref).localeCompare(String(b.ref), "en", {numeric: true}));
  }

  // ------------------------------------------------------------------ headless (MCP list/edit_generic_part)
  function headless(op, a, ctx) {
    const p = op === "candidates" ? ctx.project() : ctx.mutable();
    const part = (() => { for (const d of p.documents) for (const i of d.items || []) if (i.kind === "part" && (i.id === a.part_id || (a.designator && i.ref === a.designator && d.kind === "schematic"))) return i; return fail("No part " + String(a.part_id || a.designator || "").slice(0, 64) + "."); })();
    if (op === "candidates") return candidates(p, part).slice(0, 50).map(({def, lib, ...c}) => c);
    if (op === "resolve") {
      let id = a.resolve_def_id;
      if (!p.library.some(d => d.id === id)) {
        const c = candidates(p, part).find(x => x.def_id === id && x.lib) || fail("That component is not a candidate for " + part.ref + ".");
        id = L().addFromLibrary(c.lib, c.def, p).id;
      }
      const r = resolve(p, part, id, {mapping: a.pin_map, force: a.force});
      if (!r.refused) ctx.touched();
      return r;
    }
    if (op === "revert") { const r = revert(p, part); ctx.touched(); return r; }
    return fail("Unknown placeholder operation.");
  }

  install();
  if (!install.done && globalThis.document) setTimeout(install, 0);
  return Object.freeze({FAMILIES, ORDER, PACKAGES, isPlaceholder, normalise, make, infer, connected, mapping, candidates, resolve, revert, unresolved, headless, install, FAMILY_NAME});
})();
