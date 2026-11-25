"use strict";
// Test design for schematic <-> PCB sync and support placement (tests/sync-placement.cjs and the
// browser probes). Two sheets:
//   MCU  U1 (LQFP-48 MCU with 6 power pins: VBAT, VDD x4, VDDA), six 100 nF capacitors each drawn
//        next to one power pin, one 10 µF bulk capacitor, crystal Y1 with load capacitors C8/C9,
//        series resistors R1-R4 on the SPI lines.
//   IO   SPI header J1 (1x6) and I2C header J2 (1x4), pull-ups R5 (NRST), R6 (SCL), R7 (SDA).
// Needs Atrium, AtriumSchAuthor and AtriumStarterLibrary (with AtriumLibrary and the footprint wizard).
globalThis.AtriumSyncDesign = (() => {
  // The starter MCU's pin table, with PC13 (pin 2) turned into a second VDD: six power pins.
  const MCU = [["VBAT", 7], ["VDD", 7], ["PC14", 1], ["PC15", 1], ["XIN", 0], ["XOUT", 2], ["NRST", 0], ["VSSA", 7], ["VDDA", 7], ["PA0", 1], ["PA1", 1], ["PA2", 1],
    ["PA3", 1], ["SPI_CS", 2], ["SPI_SCK", 2], ["SPI_MISO", 0], ["SPI_MOSI", 2], ["PB0", 1], ["PB1", 1], ["PB2", 1], ["PB10", 1], ["PB11", 1], ["VSS", 7], ["VDD", 7],
    ["PB12", 1], ["PB13", 1], ["PB14", 1], ["PB15", 1], ["PA8", 1], ["PA9", 1], ["PA10", 1], ["PA11", 1], ["PA12", 1], ["SWDIO", 1], ["VSS", 7], ["VDD", 7],
    ["SWCLK", 0], ["PA15", 1], ["PB3", 1], ["PB4", 1], ["PB5", 1], ["I2C_SCL", 1], ["I2C_SDA", 1], ["BOOT0", 0], ["PB8", 1], ["PB9", 1], ["VSS", 7], ["VDD", 7]];
  const POWER_PINS = ["1", "2", "9", "24", "36", "48"];
  function build(name = "Sync test") {
    const A = Atrium, W = AtriumSchAuthor, L = AtriumLibrary;
    const p = A.project(name, []);
    AtriumStarterLibrary.addTo(p);
    const base = p.library.find(d => d.id === "starter-mcu-qfp48");
    const mcu = JSON.parse(JSON.stringify(base));
    mcu.id = "test-mcu-6pwr"; mcu.name = "MCU, LQFP-48, six supply pins";
    const built = L.buildSymbol(L.symbolFromPins(MCU.map(([n, e], i) => ({number: String(i + 1), name: n, electrical: e, side: ["left", "bottom", "right", "top"][Math.floor(i / 12)]})), {title: "MCU"}));
    mcu.symbol = built.symbol; mcu.schDrawing = built.schDrawing;
    p.library.push(mcu);
    const [s1, board] = p.documents;
    s1.name = "MCU";
    const s2 = A.sheet("schematic", "IO");
    p.documents.splice(1, 0, s2);
    board.outline = [[0, 0], [50, 0], [50, 40], [0, 40]];
    const u = W.placePart(p, {sheet: "MCU", def: mcu.id, x: 127, y: 101.6, designator: "U1", value: "MCU"});
    const at = n => u.pins.find(x => x.number === n).at;
    const out = n => { const q = at(n), dx = q[0] - u.at[0], dy = q[1] - u.at[1]; return Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)]; };
    const pwr = (sheet, net, designator, pin) => W.addPowerPort(p, {sheet, net, at: {designator, pin}});
    const label = (sheet, text, designator, pin) => W.addNetLabel(p, {sheet, text, at: {designator, pin}});
    // Power pins and their 100 nF capacitors, each drawn 12.7 mm (or 22.86 mm, staggered) outward from its pin.
    POWER_PINS.forEach((n, k) => {
      const q = at(n), d = out(n), ref = "C" + (k + 1);
      pwr("MCU", "+3V3", "U1", n);
      const o = 12.7 + 10.16 * (k % 2);
      W.placePart(p, {sheet: "MCU", def: "starter-c-0402", x: q[0] + d[0] * o, y: q[1] + d[1] * o, designator: ref, value: "100 nF", rotation: d[0] ? 90 : 0});
      pwr("MCU", "+3V3", ref, "1"); pwr("MCU", "GND", ref, "2");
    });
    for (const n of ["8", "23", "35", "47"]) pwr("MCU", "GND", "U1", n);
    // Bulk capacitor near pin 48.
    { const q = at("48"), d = out("48");
      W.placePart(p, {sheet: "MCU", def: "starter-c-0805", x: q[0] + d[0] * 35.56 + (d[0] ? 0 : 12.7), y: q[1] + d[1] * 35.56 + (d[1] ? 0 : 12.7), designator: "C7", value: "10 µF"});
      pwr("MCU", "+3V3", "C7", "1"); pwr("MCU", "GND", "C7", "2"); }
    // Crystal and load capacitors beside XIN/XOUT.
    { const q = at("5"), d = out("5"), x0 = q[0] + d[0] * 25.4, y0 = q[1];
      W.placePart(p, {sheet: "MCU", def: "starter-xtal-3225", x: x0, y: y0 + 2.54, designator: "Y1", value: "16 MHz", rotation: 90});
      W.placePart(p, {sheet: "MCU", def: "starter-c-0402", x: x0 - 10.16, y: y0 + 15.24, designator: "C8", value: "22 pF", rotation: 90});
      W.placePart(p, {sheet: "MCU", def: "starter-c-0402", x: x0 + 10.16, y: y0 + 15.24, designator: "C9", value: "22 pF", rotation: 90});
      label("MCU", "XIN", "U1", "5"); label("MCU", "XOUT", "U1", "6");
      label("MCU", "XIN", "Y1", "1"); label("MCU", "XOUT", "Y1", "3");
      pwr("MCU", "GND", "Y1", "2"); pwr("MCU", "GND", "Y1", "4");
      label("MCU", "XIN", "C8", "1"); pwr("MCU", "GND", "C8", "2");
      label("MCU", "XOUT", "C9", "1"); pwr("MCU", "GND", "C9", "2"); }
    // SPI series resistors, drawn beside the MCU pins.
    [["14", "CS"], ["15", "SCK"], ["16", "MISO"], ["17", "MOSI"]].forEach(([n, sig], k) => {
      const q = at(n), d = out(n), ref = "R" + (k + 1);
      W.placePart(p, {sheet: "MCU", def: "starter-r-0402", x: q[0] + d[0] * 15.24 + (d[0] ? 0 : 7.62 * k), y: q[1] + d[1] * 15.24 + (d[1] ? 0 : 0), designator: ref, value: "33 Ω",
        rotation: d[0] ? 0 : 90});
      label("MCU", "MCU_" + sig, "U1", n); label("MCU", "MCU_" + sig, ref, "1"); label("MCU", "SPI_" + sig, ref, "2");
    });
    label("MCU", "NRST", "U1", "7"); label("MCU", "I2C_SCL", "U1", "42"); label("MCU", "I2C_SDA", "U1", "43");
    // IO sheet: connectors and pull-ups.
    W.placePart(p, {sheet: "IO", def: "starter-hdr-1x6", x: 50.8, y: 50.8, designator: "J1", value: "SPI"});
    ["+3V3", "GND"].forEach((n, k) => pwr("IO", n, "J1", String(k + 1)));
    ["CS", "SCK", "MISO", "MOSI"].forEach((s, k) => label("IO", "SPI_" + s, "J1", String(k + 3)));
    W.placePart(p, {sheet: "IO", def: "starter-hdr-1x4", x: 50.8, y: 101.6, designator: "J2", value: "I2C"});
    pwr("IO", "+3V3", "J2", "1"); pwr("IO", "GND", "J2", "2"); label("IO", "I2C_SCL", "J2", "3"); label("IO", "I2C_SDA", "J2", "4");
    [["R5", "NRST"], ["R6", "I2C_SCL"], ["R7", "I2C_SDA"]].forEach(([ref, sig], k) => {
      W.placePart(p, {sheet: "IO", def: "starter-r-0402", x: 101.6 + 15.24 * k, y: 76.2, designator: ref, value: "10 kΩ", rotation: 90});
      pwr("IO", "+3V3", ref, "1"); label("IO", sig, ref, "2");
    });
    return p;
  }
  // Expected associations (designator -> [kind, target designator, pin]); decoupling pins are
  // the pins each capacitor is drawn beside.
  const EXPECTED = {
    C1: ["decoupling", "U1", "1"], C2: ["decoupling", "U1", "2"], C3: ["decoupling", "U1", "9"], C4: ["decoupling", "U1", "24"], C5: ["decoupling", "U1", "36"], C6: ["decoupling", "U1", "48"],
    C7: ["bulk", "U1", "48"], Y1: ["crystal", "U1", "5"], C8: ["load", "Y1", "1"], C9: ["load", "Y1", "3"],
    R1: ["termination", "U1", "14"], R2: ["termination", "U1", "15"], R3: ["termination", "J1", "5"], R4: ["termination", "U1", "17"],
    R5: ["pullup", "U1", "7"], R6: ["pullup", "U1", "42"], R7: ["pullup", "U1", "43"]
  };
  return {build, EXPECTED, POWER_PINS};
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.AtriumSyncDesign;
