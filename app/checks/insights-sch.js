"use strict";
// Design Insights for schematics (insights.js is the engine). Nets are read per sheet with
// Atrium.connectivity and joined across sheets by name (the default global net scope), so a
// check sees the whole project; each insight is placed on the sheet that holds its object.
// Compile (ERC) reports some of the same conditions as errors when it runs; these are live hints.
//
//   netTypo       a net name that is probably a typo of another (GND / GDN, VCC3V3 / VCC_3V3);
//                 fix: rename it to the common spelling across the project
//   decoupling    an IC power pin whose supply has no capacitor to ground anywhere in the design
//   i2cPullup     an I²C SDA/SCL net with no resistor to a supply
//   wireNearPin   a wire end that stops just short of a pin (looks connected, is not); fix: snap it
//   singlePin     a named net that reaches only one pin in the project
//   floatingInput an input pin connected to nothing
globalThis.AtriumInsightsSch = (() => {
  const G = globalThis, I = () => G.AtriumInsights, A = () => G.Atrium;
  const I18N = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = I18N.define({
    "insights.typo.title": "Net name looks like a typo",
    "insights.typo.message": "Net {name} looks like a typo of {other} ({other} is used {many} times, {name} {few}).",
    "insights.typo.why": "Nets join by name: a misspelt label makes a separate net that is not connected to the one it was meant for, and the board will not join them either.",
    "insights.typo.pref_help": "Flag similar names on different nets.",
    "insights.typo.learn": "Flagged when two names differ only in case or separators (VCC3V3 / VCC_3V3), by two swapped letters (GND / GDN), by a doubled letter, or by one letter from a common supply name. Names that differ by a digit or a P/N suffix (D0 / D1, USB_DP / USB_DM) are never flagged.",
    "insights.typo.fix": "Rename {name} to {other}",
    "insights.decoupling.title": "Power pin without decoupling",
    "insights.decoupling.message": "{ref} pin {pin} ({net}) has no capacitor to ground on {net} anywhere in the design.",
    "insights.decoupling.why": "Every IC draws current in fast pulses; without a capacitor next to its supply pins those pulses come through the supply's inductance and the rail rings. A 100 nF capacitor per supply pin, to the nearest ground, is the usual start.",
    "insights.decoupling.pref_help": "Flag power pins without a nearby supply capacitor.",
    "insights.decoupling.learn": "For each power pin of an IC (U…, IC…, or a pin of type Power), the design is searched for a capacitor (C…) with one pin on the same net and the other on a ground net (GND, VSS, AGND …).",
    "insights.i2c.title": "I²C net without a pull-up",
    "insights.i2c.message": "{net} has no pull-up resistor to a supply.",
    "insights.i2c.why": "I²C lines are open drain: nothing drives them high. Without a pull-up resistor (typically 2.2–10 kΩ to the bus supply) the bus never leaves low, or rises too slowly.",
    "insights.i2c.pref_help": "Flag I²C signals without pull-up resistors.",
    "insights.i2c.learn": "Nets named SDA or SCL (I2C_SDA, SCL1 …) are checked for a resistor (R…) with its other pin on a supply net. Pull-ups inside a module or IC are not seen; dismiss the hint then.",
    "insights.near.title": "Wire end near a pin",
    "insights.near.message": "This wire ends {gap} mm from pin {ref}-{pin} and is not connected to it.",
    "insights.near.why": "A wire must end exactly on a pin's connection point. One that stops a little short looks connected on the sheet but makes no connection.",
    "insights.near.pref_help": "Flag a wire that nearly joins a pin.",
    "insights.near.learn": "Wire ends that touch nothing are compared with the unconnected pins around them; an end within the threshold of a pin's hot spot is reported. The fix moves the end onto the pin.",
    "insights.near.fix": "Connect to {ref}-{pin}",
    "insights.single.title": "Net with one pin",
    "insights.single.message": "Net {net} reaches only one pin ({pin}).",
    "insights.single.why": "A named net normally connects two or more pins. One pin means the other end is missing, misspelt or on a sheet that is not in the project.",
    "insights.single.pref_help": "Flag a net connected to just one pin.",
    "insights.single.learn": "Counted across every sheet, joining nets of the same name. Test points and intentionally open pins are fine: dismiss the hint, or mark the pin No ERC.",
    "insights.float.title": "Floating input",
    "insights.float.message": "Input pin {ref}-{pin}{name} is not connected.",
    "insights.float.why": "A CMOS input left open floats between high and low: it picks up noise, draws extra current and can oscillate. Tie it to a defined level, directly or through a resistor, or mark it No ERC if it really is unused and allowed to float.",
    "insights.float.pref_help": "Flag inputs with no apparent driver.",
    "insights.float.learn": "Pins whose electrical type is Input (from the symbol) with no wire, label or pin on them.",
    "insights.placeholder.title": "Placeholder not resolved",
    "insights.placeholder.message": "{ref} is a {what} placeholder. Resolve it to a real component before ordering.",
    "insights.placeholder.why": "A placeholder stands in for a chip you have not chosen yet. It has no manufacturer part, and its footprint is provisional or missing, so the BOM and fabrication outputs are not final.",
    "insights.placeholder.pref_help": "Flag parts with placeholder names or values.",
    "insights.placeholder.learn": "Every placed part whose definition is a placeholder (Place › Placeholder). Resolve… offers the library components whose pins cover every connected function. Dismiss the hint per part while the choice is open.",
    "insights.placeholder.fix": "Resolve…"
  });
  const N = v => String(Math.round(v * 100) / 100);
  const KNOWN = new Set(["GND", "AGND", "DGND", "PGND", "SGND", "CGND", "GNDA", "GNDD", "VSS", "VSSA", "VDD", "VDDA", "VDDIO", "VCC", "VCCA", "VCCIO", "VEE", "VBUS", "VBAT", "VIN", "VOUT", "VREF",
    "3V3", "5V", "12V", "1V8", "2V5", "1V2", "+3V3", "+5V", "+12V", "+1V8", "+3.3V", "+5V0", "VCC3V3", "VCC_3V3", "VCC5V", "VDD_3V3"]);

  // ---------------------------------------------------------------- project nets
  // Reuse the sheet's compact connectivity and derive its pin and label lists on first demand.
  function sheetInfo(ctx, sheet) {
    const defs = ctx.defs, entry = A().sheetEntry(ctx.project, sheet, defs);
    if (entry?.insights) return entry.insights;
    const conn = entry ? (entry.names ??= A().connectivity(sheet, defs)) : A().connectivity(sheet, defs);
    const pins = [], labels = [];
    const S = G.AtriumSchObjects;
    for (const i of sheet.items) {
      if (i.kind === "part") {
        const def = defs.get(i.def);
        if (S?.notElectrical?.(i, def) || S?.componentKind?.(i, def) === "graphical") continue;
        let list = [];
        try { list = A().pins(i, def, "schematic"); } catch { list = []; }
        for (const p of list) if (!p.hidden) pins.push({part: i, pin: p, at: p.at, net: conn.byPin.get(i.id + "/" + p.number) || null});
      } else if (i.kind === "netlabel" && i.text && !S?.isBus?.(i.text)) labels.push({item: i, name: i.text, at: [i.x, i.y]});
      else if ((i.kind === "power" || i.kind === "port" || i.kind === "offsheet") && i.text && !S?.isBus?.(i.text)) labels.push({item: i, name: i.text, at: [i.x, i.y]});
      else if (i.kind === "wire" && i.net) labels.push({item: i, name: i.net, at: i.points[0]});
    }
    const info = {sheet, conn, pins, labels};
    if (entry) entry.insights = info;
    return info;
  }
  function project(ctx) {
    if (ctx._prj) return ctx._prj;
    const sheets = (ctx.project?.documents || [ctx.doc]).filter(d => d.kind === "schematic");
    if (!sheets.includes(ctx.doc)) sheets.push(ctx.doc);
    const infos = sheets.map(s => sheetInfo(ctx, s));
    // The project-wide name and net tables are the same while every sheet's info is (the shared
    // memo returns the same object for an unchanged sheet), so a pass after an edit elsewhere, or on
    // another sheet, reuses them instead of regrouping every pin and label of the project.
    const shared = ctx.project ? ctx.opts.sheetMemo : null, key = ctx.project, kept = shared?.get(key);
    let nets, names;
    if (kept && kept.infos.length === infos.length && kept.infos.every((x, i) => x === infos[i])) ({nets, names} = kept);
    else {
      nets = new Map(); names = new Map();
      for (const inf of infos) {
        for (const p of inf.pins) if (p.net) { if (!nets.has(p.net)) nets.set(p.net, []); nets.get(p.net).push({...p, sheet: inf.sheet}); }
        for (const l of inf.labels) { if (!names.has(l.name)) names.set(l.name, []); names.get(l.name).push({...l, sheet: inf.sheet}); }
      }
      shared?.set(key, {infos, nets, names});
    }
    // Two-pin parts by prefix, with the nets of both pins.
    const twoPin = prefix => {
      const out = [];
      for (const inf of infos) {
        const by = new Map();
        for (const p of inf.pins) if (new RegExp("^" + prefix + "\\d", "i").test(p.part.ref || "")) { if (!by.has(p.part)) by.set(p.part, []); by.get(p.part).push(p); }
        for (const [part, ps] of by) if (ps.length === 2) out.push({part, nets: [ps[0].net, ps[1].net], sheet: inf.sheet});
      }
      return out;
    };
    return ctx._prj = {sheets, infos, nets, names, twoPin, here: infos[sheets.indexOf(ctx.doc)]};
  }

  // ---------------------------------------------------------------- net-name typos
  const norm = s => s.toUpperCase().replace(/[\s_\-.]/g, "");
  // A name's comparison forms, computed once per name and pass instead of once per pair.
  const typoForm = s => { const U = s.toUpperCase(); return {s, U, N: norm(s), M: U.replace(/\d/g, "#")}; };
  function typoKind(a, b) { return typoPair(typoForm(a), typoForm(b)); }
  function typoPair(fa, fb) {
    if (fa.s === fb.s) return null;
    if (fa.N === fb.N) return "separators";
    const A2 = fa.U, B2 = fb.U;
    if (fa.M === fb.M && A2.length === B2.length) return null; // D0 / D1
    if (A2.length === B2.length) {
      const diff = [];
      for (let i = 0; i < A2.length; i++) if (A2[i] !== B2[i]) diff.push(i);
      if (diff.length === 2 && diff[1] === diff[0] + 1 && A2[diff[0]] === B2[diff[1]] && A2[diff[1]] === B2[diff[0]] && /[A-Z]/.test(A2[diff[0]] + A2[diff[1]])) return "swap";
      if (diff.length === 1) {
        const i = diff[0], x = A2[i], y = B2[i];
        if (/\d/.test(x) || /\d/.test(y)) return null;
        if (i === A2.length - 1 && /[PNMHLAB+\-]/.test(x) && /[PNMHLAB+\-]/.test(y)) return null; // USB_DP / USB_DM, CANH / CANL
        if (KNOWN.has(A2) !== KNOWN.has(B2) && A2.length >= 3) return "letter";
      }
      return null;
    }
    const [s, l] = A2.length < B2.length ? [A2, B2] : [B2, A2];
    if (l.length !== s.length + 1 || s.length < 3) return null;
    for (let i = 1; i < l.length; i++) if (l[i] === l[i - 1] && /[A-Z]/.test(l[i]) && l.slice(0, i) + l.slice(i + 1) === s) return "double";
    return null;
  }
  // Findings can outlive this pass. Keep only the two names needed by the later editor action.
  function renameFix(from, to) {
    return {label: t("insights.typo.fix", {name: from, other: to}), apply(doc, project) {
      const changed = [];
      for (const sheet of project?.documents || [doc]) for (const item of sheet.items) {
        if ((item.kind === "netlabel" || item.kind === "power" || item.kind === "port" || item.kind === "offsheet") && item.text === from) {
          item.text = to; changed.push(item.id);
        } else if (item.kind === "wire" && item.net === from) {
          item.net = to; changed.push(item.id);
        }
      }
      return changed;
    }};
  }
  function typoCheck(ctx) {
    const P = project(ctx), out = [], names = [...P.names.keys()];
    const uses = n => (P.names.get(n)?.length || 0) + (P.nets.get(n)?.length || 0);
    if (names.length > 3000) return out;
    // A pair can only be reported on this sheet when one of its names has a label here, and only
    // names of equal normal form, or of upper-case lengths within one, can be typos of each other
    // (typoPair). The candidates are visited in the same (i, j) order as the full pairwise scan.
    const forms = names.map(typoForm), local = names.map(n => (P.names.get(n) || []).some(l => l.sheet === ctx.doc));
    const byLen = new Map(), localByLen = new Map(), byNorm = new Map();
    const add = (m, k, i) => { let l = m.get(k); if (!l) m.set(k, l = []); l.push(i); };
    forms.forEach((f, i) => { add(byLen, f.U.length, i); if (local[i]) add(localByLen, f.U.length, i); add(byNorm, f.N, i); });
    for (let i = 0; i < names.length; i++) {
      const f = forms[i], pool = local[i] ? byLen : localByLen, js = [];
      for (const n of [f.U.length - 1, f.U.length, f.U.length + 1]) for (const j of pool.get(n) || []) if (j > i) js.push(j);
      for (const j of byNorm.get(f.N)) if (j > i && (local[i] || local[j])) js.push(j);
      js.sort((a, b) => a - b);
      for (let n = 0; n < js.length; n++) {
        const j = js[n];
        if (n && js[n - 1] === j) continue;
        const k = typoPair(f, forms[j]);
        if (!k) continue;
        let [rare, common] = uses(names[i]) <= uses(names[j]) ? [names[i], names[j]] : [names[j], names[i]];
        if (uses(rare) === uses(common) && KNOWN.has(rare.toUpperCase()) && !KNOWN.has(common.toUpperCase())) [rare, common] = [common, rare];
        const here = (P.names.get(rare) || []).filter(l => l.sheet === ctx.doc);
        if (!here.length) continue;
        const ids = here.map(l => l.item.id);
        out.push({objects: ids, at: here[0].at.slice(), net: rare, severity: "advice", message: t("insights.typo.message", {name: rare, other: common, many: uses(common), few: uses(rare)}),
          sig: ["typo", rare, common].join("|"),
          fix: renameFix(rare, common)});
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- decoupling, pull-ups
  const isIC = part => /^(U|IC)\d/i.test(part.ref || "");
  const POWER_PIN = /^(?:V(?:CC|DD|IN|BAT|BUS|IO|REF)\w*|AVDD\w*|DVDD\w*|PVDD\w*|VCORE\w*|\+?\d+V\d*)$/i;
  function decouplingCheck(ctx) {
    const P = project(ctx), out = [], I0 = I();
    const capNets = new Set();
    for (const c of P.twoPin("C")) { const [a, b] = c.nets; if (a && b) { if (I0.nets.isGround(b)) capNets.add(a); if (I0.nets.isGround(a)) capNets.add(b); } }
    const seen = new Set();
    for (const p of P.here.pins) {
      if (!isIC(p.part) || !p.net || I0.nets.isGround(p.net)) continue;
      const power = p.pin.electrical === 7 || /^power$/i.test(String(p.pin.electrical || "")) || POWER_PIN.test(p.pin.name || "");
      if (!power || !I0.nets.isPower(p.net) && !POWER_PIN.test(p.pin.name || "")) continue;
      if (capNets.has(p.net)) continue;
      const k = p.part.id + "|" + p.net;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({objects: [p.part.id], at: p.at.slice(), net: p.net, severity: "advice", message: t("insights.decoupling.message", {ref: p.part.ref, pin: p.pin.number, net: p.net}), sig: ["decoupling", p.net].join("|")});
    }
    return out;
  }
  const I2C = /(?:^|[_\-./])(?:I2C\d*[_\-.]?)?(SDA|SCL)\d*(?:$|[_\-./])/i;
  function i2cCheck(ctx) {
    const P = project(ctx), out = [], I0 = I(), pulled = new Set();
    for (const r of P.twoPin("R")) { const [a, b] = r.nets; if (a && b) { if (I0.nets.isPower(b)) pulled.add(a); if (I0.nets.isPower(a)) pulled.add(b); } }
    for (const [name, labels] of P.names) {
      if (!I2C.test(name) || pulled.has(name)) continue;
      if ((P.nets.get(name)?.length || 0) < 2) continue;
      const here = labels.filter(l => l.sheet === ctx.doc);
      if (!here.length) continue;
      out.push({objects: here.map(l => l.item.id), at: here[0].at.slice(), net: name, severity: "advice", message: t("insights.i2c.message", {net: name}), sig: ["i2c", name].join("|")});
    }
    return out;
  }

  // ---------------------------------------------------------------- wire ends, single pins, floating inputs
  const key = p => Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000);
  function nearCheck(ctx) {
    const s = ctx.settings, doc = ctx.doc, out = [], P = project(ctx).here, S = G.AtriumSchObjects;
    const points = new Map(), bump = p => points.set(key(p), (points.get(key(p)) || 0) + 1);
    const segs = [];
    for (const i of doc.items) {
      if (i.kind === "wire" && i.points?.length > 1) { for (const p of i.points) bump(p); for (let k = 1; k < i.points.length; k++) segs.push([i, i.points[k - 1], i.points[k]]); }
      else if (i.kind === "junction" || i.kind === "netlabel" || i.kind === "noerc" || /^no-?erc$/i.test(i.kind || "")) bump([i.x, i.y]);
      else if (S?.hotspots) for (const p of S.hotspots(i)) bump(p);
    }
    for (const p of P.pins) bump(p.at);
    const grid = (doc.grid > 0 ? doc.grid : 1.27), reach = Math.max(s.distance, 0), I0 = I();
    for (const w of doc.items) {
      if (w.kind !== "wire" || !(w.points?.length > 1)) continue;
      for (const end of [0, w.points.length - 1]) {
        const q = w.points[end];
        if ((points.get(key(q)) || 0) > 1) continue;
        // Touching another wire's segment counts as connected.
        if (segs.some(([o, a, b]) => o !== w && I0.geometry.segDist(q, a, b).d < 1e-3)) continue;
        let best = null;
        for (const p of P.pins) { const d = Math.hypot(p.at[0] - q[0], p.at[1] - q[1]); if (d > 1e-4 && d <= reach && (!best || d < best.d)) best = {d, p}; }
        if (!best || best.d >= grid * .99 && best.d > reach) continue;
        const id = w.id, to = best.p.at.slice(), idx = end;
        out.push({objects: [id, best.p.part.id], at: q.slice(), line: [q, to], severity: "advice", message: t("insights.near.message", {gap: N(best.d), ref: best.p.part.ref, pin: best.p.pin.number}),
          sig: ["near", best.p.pin.number, idx ? "end" : "start"].join("|"),
          fix: {label: t("insights.near.fix", {ref: best.p.part.ref, pin: best.p.pin.number}), apply(d) {
            const it = d.items.find(i => i.id === id); if (!it?.points?.[idx]) throw Error("The wire changed; check the sheet again.");
            it.points[idx] = to.slice();
            return [id];
          }}});
      }
    }
    return out;
  }
  function singleCheck(ctx) {
    const P = project(ctx), out = [];
    for (const [name, labels] of P.names) {
      if (/^(?:NC|N\/C|DNC|NOCONNECT)$/i.test(name)) continue;
      const pins = P.nets.get(name) || [];
      if (pins.length !== 1 || pins[0].sheet !== ctx.doc) continue;
      const p = pins[0];
      out.push({objects: [p.part.id, ...labels.filter(l => l.sheet === ctx.doc).map(l => l.item.id)], at: p.at.slice(), net: name, message: t("insights.single.message", {net: name, pin: p.part.ref + "-" + p.pin.number}), sig: ["single", name, p.pin.number].join("|")});
    }
    return out;
  }
  function floatCheck(ctx) {
    const P = project(ctx).here, out = [], ERC = G.AtriumERC;
    const noErc = new Set(ctx.doc.items.filter(i => /^no-?erc$/i.test(i.kind || "")).map(i => key([i.x, i.y])));
    for (const p of P.pins) {
      const type = ERC?.pinType ? ERC.pinType(p.pin) : p.pin.electrical === 0 || /^(?:in|input)$/i.test(String(p.pin.electrical ?? "")) ? 0 : undefined;
      if (type !== 0 || p.net || noErc.has(key(p.at))) continue;
      out.push({objects: [p.part.id], at: p.at.slice(), severity: "advice", message: t("insights.float.message", {ref: p.part.ref, pin: p.pin.number, name: p.pin.name && p.pin.name !== p.pin.number ? " (" + p.pin.name + ")" : ""}),
        sig: ["float", p.pin.number].join("|")});
    }
    return out;
  }

  // Placeholders (placeholder-parts.js): one hint per unresolved designator, on its first unit.
  function placeholderCheck(ctx) {
    const out = [], seen = new Set();
    for (const i of ctx.doc.items) {
      const def = i.kind === "part" ? ctx.defs.get(i.def) : null;
      if (def?.generic?.role !== "placeholder" || seen.has(i.ref)) continue;
      seen.add(i.ref);
      const what = G.AtriumPlaceholders?.FAMILIES?.[def.generic.family]?.label?.(def.generic.params) || def.generic.family;
      const id = i.id;
      out.push({objects: [id], at: [i.x, i.y], message: t("insights.placeholder.message", {ref: i.ref, what}), sig: ["placeholder", def.generic.family].join("|"),
        fix: {label: t("insights.placeholder.fix"), open: host => G.AtriumPlaceholderUI?.resolveDialog?.(host, i)}});
    }
    return out;
  }
  function install() {
    const R = I()?.register;
    if (!R) return false;
    R({id:"openSheetTodo",kind:"schematic",severity:"tip",title:"Open sheet to-do",scope:"doc",dirtyKinds:["textframe"],
      inputStamp:(project,doc)=>doc.items.filter(i=>i.widget?.type==="todo").flatMap(i=>i.widget.state.rows.filter(r=>r.threadId)
        .map(r=>r.threadId+"/"+(project.review?.records?.[r.threadId]?.status || ""))).join("|"),
      run(ctx) {
        const results=[];
        for (const i of ctx.doc.items) if (i.kind==="textframe" && i.widget?.type==="todo") {
          for (const r of i.widget.state.rows) {
            const checked=r.threadId?ctx.project.review?.records?.[r.threadId]?.status==="resolved":r.done;
            if (!checked) results.push({objects:[i.id],at:[i.x,i.y],sig:r.id,message:[r.text,r.assignee,r.due].filter(Boolean).join(" · "),
              fix:{label:"Open checklist",open:host=>G.AtriumLazy?.need("AtriumSheetWidgetEditor").then(ui=>ui.open(i.id,host))}});
          }
        }
        return results;
      }});
    R({id: "netTypo", kind: "schematic", severity: "advice", title: t("insights.typo.title"), why: t("insights.typo.why"), prefHelp: () => t("insights.typo.pref_help"), learnMore: t("insights.typo.learn"), scope: "doc", dirtyKinds: ["netlabel", "power", "port", "offsheet", "wire"], run: typoCheck});
    R({id: "decoupling", kind: "schematic", severity: "advice", title: t("insights.decoupling.title"), why: t("insights.decoupling.why"), prefHelp: () => t("insights.decoupling.pref_help"), learnMore: t("insights.decoupling.learn"), scope: "doc", run: decouplingCheck});
    R({id: "i2cPullup", kind: "schematic", severity: "advice", title: t("insights.i2c.title"), why: t("insights.i2c.why"), prefHelp: () => t("insights.i2c.pref_help"), learnMore: t("insights.i2c.learn"), scope: "doc", run: i2cCheck});
    R({id: "wireNearPin", kind: "schematic", severity: "advice", title: t("insights.near.title"), why: t("insights.near.why"), prefHelp: () => t("insights.near.pref_help"), learnMore: t("insights.near.learn"), scope: "doc",
      defaults: {distance: {low: .3, normal: .6, high: 1}}, settings: [{key: "distance", label: "Wire ends within", unit: "mm", min: .05, max: 5, step: .05}], run: nearCheck});
    R({id: "singlePin", kind: "schematic", severity: "tip", title: t("insights.single.title"), why: t("insights.single.why"), prefHelp: () => t("insights.single.pref_help"), learnMore: t("insights.single.learn"), scope: "doc", run: singleCheck});
    R({id: "floatingInput", kind: "schematic", severity: "advice", title: t("insights.float.title"), why: t("insights.float.why"), prefHelp: () => t("insights.float.pref_help"), learnMore: t("insights.float.learn"), scope: "doc", run: floatCheck});
    R({id: "placeholder", kind: "schematic", severity: "tip", title: t("insights.placeholder.title"), why: t("insights.placeholder.why"), prefHelp: () => t("insights.placeholder.pref_help"), learnMore: t("insights.placeholder.learn"), scope: "doc", dirtyKinds: ["part"], run: placeholderCheck});
    return true;
  }
  install();
  return Object.freeze({typoKind, install});
})();
