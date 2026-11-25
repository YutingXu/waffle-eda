"use strict";
// Design Insights that read net intent (docs/design/net-intent.md §7, phase P2): what the names say about a
// net, checked against the pins, parts and other names on it. Name-only intent is enough for a hint (the
// message says "by its name"); DRC, the router and ECO never read these. Registered with AtriumInsights
// (insights.js); the project facts come from net-intent-index.js, memoised on the undo journal.
//
//   pairSwap            a pair's positive net on a pin whose own name is negative, and the negative net on
//                       the positive pin of the same part (USB_DP on J3 pin D−). Quiet for links that may
//                       invert a lane (PCIe, SATA, SGMII, MIPI) unless the part is a connector.
//   pairOrphan          a pair member without its partner, in a project that names two or more complete
//                       pairs that way; fix: rename a near miss (PCIE_TX1_M) to the partner
//   railConflict        one net with two rail names: different voltages, a rail and a ground, or one rail
//                       spelt twice (fix: one spelling everywhere)
//   railPinMismatch     a pin whose name has a voltage (VDD_1V8) on a rail of another voltage
//   capRating           a capacitor whose voltage rating is under the rail across it times the derating
//   busGap              a bus of four or more members with one or two missing (D0–D7 without D5)
//   isolationBridge     an isolated ground (GND_ISO) joined to another ground by one net or a 0 Ω part,
//   isolationBridgeBoard  jumper, ferrite or net tie (schematic, and the same on the board)
//   isolationRating     a part on an isolated and another ground domain without a Creepage parameter (the
//                       layout creepage hint, creepage.js, holds the copper across the barrier to it)
//   nameSuggestion      a pair or bus the names suggest and no signal declares yet (Signals panel
//                       suggestions as quiet hints); fix: declare it; dismissing it declines it
globalThis.AtriumInsightsIntent = (() => {
  const G = globalThis, I = () => G.AtriumInsights, X = () => G.AtriumNetIntentIndex, N = () => G.AtriumNetIntent;
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = AtriumI18n.define({
    "insights.pairswap.title": "Differential pair swapped at a pin",
    "insights.pairswap.message": "{pos} (positive by its name) lands on {ref} pin {pinA}, and {neg} on pin {pinB}: the pair looks swapped.",
    "insights.pairswap.why": "A differential pair carries its signal as the difference between its two lines; crossing them inverts it. USB, CAN, HDMI and Ethernet expect each line on the pin of the same polarity. Only some serial links (PCIe, SATA) correct an inverted lane themselves.",
    "insights.pairswap.pref_help": "Flag pair polarity reversed at a pin.",
    "insights.pairswap.learn": "For each pair (by its net names, or a declared differential signal), the pins its nets reach are read by their own names (D+, D−, DP, DM, TXP, TXN, CANH, CANL …). Two pins of one part, each on the net of the other polarity, are reported. PCIe, SATA, SGMII and MIPI lanes are skipped except at connectors.",
    "insights.orphan.title": "Pair member without its partner",
    "insights.orphan.message": "{name} has no partner {partner}, though this project names {count} pairs {pattern} (by its name).",
    "insights.orphan.near": "{name} has no partner {partner}; {near} is probably meant (by their names).",
    "insights.orphan.why": "A net named as one half of a differential pair whose other half is missing is usually a renamed or misspelt partner, so the pair is not routed or checked as a pair.",
    "insights.orphan.pref_help": "Flag pair names missing their companion.",
    "insights.orphan.learn": "Only when the project names at least two complete pairs with the same pattern, or a near miss of the partner exists (another polarity word, or other case or separators). A lone control name such as RST_N is active low, not half a pair, unless the Naming view says otherwise.",
    "insights.orphan.fix": "Rename {near} to {partner}",
    "insights.railconflict.title": "Two rail names on one net",
    "insights.railconflict.volts": "This net is both {a} ({va} V) and {b} ({vb} V), by their names.",
    "insights.railconflict.ground": "This net is both the rail {a} and the ground {b}, by their names.",
    "insights.railconflict.same": "This net is named both {a} and {b}: one {v} V rail with two spellings.",
    "insights.railconflict.why": "Each name joins every net of that name in the project. A wire that carries two supply names connects two rails, or a rail to ground, everywhere those names appear.",
    "insights.railconflict.learn": "Names on one net that both read as supplies (3V3, +5V, VCC_1V8, GND …). Different voltages or a rail with a ground are advice; two spellings of one voltage are a tip with a fix. Rails without a voltage in their name (VCC, VDD) are not compared.",
    "insights.railconflict.fix": "Use {to} for {from}",
    "insights.railpin.title": "Pin voltage differs from its rail",
    "insights.railpin.message": "{ref} pin {pin} ({pv} V by the pin name) is on {net} ({nv} V {basis}).",
    "insights.railpin.regulator": "{ref} pin {pin} supplies {pv} V {basis}, but {net} is named for {nv} V.",
    "insights.railpin.why": "A supply pin named for one voltage on a rail of another usually means a wrong label, or a part chosen for another rail. Too high a voltage damages the part; too low a voltage leaves it unreliable.",
    "insights.railpin.pref_help": "Flag a pin connected to a different voltage.",
    "insights.railpin.learn": "A pin name such as VDD_1V8 is compared with the net's named voltage, the regulator's nominal output, or a feedback-divider estimate. A regulator output whose voltage disagrees with the net name is also flagged.",
    "insights.cap.title": "Capacitor voltage rating",
    "insights.cap.message": "{ref} is rated {rating} V across {net} ({v} V by its name): under {derate}× derating.",
    "insights.cap.below": "{ref} is rated {rating} V across {net} ({v} V by its name): below the rail itself.",
    "insights.cap.source": "{ref} is rated {rating} V across {net} ({v} V): under {derate}× derating. {basis}.",
    "insights.cap.source_below": "{ref} is rated {rating} V across {net} ({v} V): below the working voltage. {basis}.",
    "insights.railpin.named": "by its name",
    "insights.cap.basis": "{net}: {v} V {by}",
    "insights.cap.why": "A capacitor run near its rated voltage ages fast, and a ceramic one loses most of its capacitance under DC bias. A rating of about twice the working voltage for ceramics, and 1.25–1.5× for electrolytics, is the usual margin.",
    "insights.cap.pref_help": "Flag voltage ratings below the rail margin.",
    "insights.cap.learn": "Two-pin capacitors (C…) between rails or across a rail and ground. Voltages come from net names and regulator outputs. The rating comes from the part's Voltage or Rated Voltage parameter, or its value (10u/16V). The derating factor is a setting.",
    "insights.cap.derate": "Derating factor",
    "insights.busgap.title": "Gap in a bus",
    "insights.busgap.message": "{from}–{to} has no {missing} (by their names).",
    "insights.busgap.why": "A bus with one index missing is often a misnumbered label: the net meant for the gap is joined to another member, or left out.",
    "insights.busgap.pref_help": "Flag missing numbers in a bus.",
    "insights.busgap.learn": "Names with a common stem and an index (D0, D1 …, ADDR_12) with four or more members and exactly one or two missing in the range. Stems listed under Never suggest in the Naming view are skipped.",
    "insights.iso.title": "Isolation barrier bridged",
    "insights.iso.net": "{a} and {b} are one net here: the isolation barrier is bridged (by their names).",
    "insights.iso.part": "{ref} joins {a} and {b}: the isolation barrier is bridged (by their names).",
    "insights.iso.why": "An isolated domain only stays isolated if nothing but the isolator, a transformer, a Y capacitor or a high-value bleed resistor crosses the barrier. One 0 Ω link, ferrite or shared net joins the grounds and defeats it.",
    "insights.iso.pref_help": "Flag connections between isolated domains.",
    "insights.iso.learn": "Grounds whose name marks them isolated (GND_ISO, ISO_GND, or a ground in the project's naming dictionary) on one net with another ground, or joined by a two-pin 0 Ω resistor, jumper, ferrite, inductor or net tie. Capacitors and resistors of 1 kΩ or more are never reported.",
    "insights.isorating.title": "Isolation barrier without a rated creepage",
    "insights.isorating.message": "{ref} crosses the isolation barrier between {a} and {b} (by their names) but has no Creepage parameter: add its rated creepage from the datasheet (Creepage = 8 mm), so the board check can hold the copper to it.",
    "insights.isorating.why": "The board must keep at least the isolator's own creepage across the barrier, or the PCB becomes the weak point of the isolation. The rating is in the part's datasheet (external creepage, CPG).",
    "insights.isorating.pref_help": "Flag barriers with no creepage rating.",
    "insights.isorating.learn": "Parts with three or more pins on two ground domains, one of them isolated (GND_ISO, ISO_GND, or a ground in the project's naming dictionary marked isolated). A Creepage parameter (also Rated Creepage, Creepage Distance, CPG) on the part or its library component quiets the hint; the layout's creepage hint then uses it across the barrier.",
    "insights.suggest.title": "Signal suggested by net names",
    "insights.suggest.pair": "{pos} and {neg} look like one differential pair ({basis}).",
    "insights.suggest.bus": "{from}–{to} look like one bus of {count} nets ({basis}).",
    "insights.suggest.why": "A declared signal is what DRC, the router and ECO use: pair rules, length matching and polarity follow it. Suggestions come from the names only, so they wait for you.",
    "insights.suggest.pref_help": "Suggest signal types from net names.",
    "insights.suggest.learn": "The Signals panel lists the same suggestions (Window › Panels › Signals). Dismissing this hint declines the suggestion there too; the Naming view says how this project's names are read.",
    "insights.suggest.pairs": "{count} net pairs named {pattern} ({examples} …) look like differential pairs (by their names).",
    "insights.suggest.fix.pairs": "Declare all {count} pairs",
    "insights.suggest.fix.pair": "Declare pair {name}",
    "insights.suggest.fix.bus": "Declare bus {name}"
  });
  const ELECTRICAL = ["part", "wire", "netlabel", "power", "port", "offsheet", "junction"];
  const NAMES = ["netlabel", "power", "port", "offsheet", "wire"];
  const r2 = v => String(Math.round(v * 100) / 100);
  const upper = s => String(s).replace(/[a-z]/g, c => c.toUpperCase());
  const norm = s => upper(s).replace(/[\s_\-.]/g, "");
  // The project facts once per pass (every check of one pass shares its context).
  const passes = new WeakMap();
  function P(ctx) {
    let p = passes.get(ctx);
    if (!p) {
      const F = X().facts(ctx.project || {documents: [ctx.doc], library: []}, ctx.defs), conv = X().conventions(ctx.project, F).effective;
      p = {F, conv, read: n => X().classify(n, conv), regulators: () => X().regulatorVoltages(F, conv)};
      passes.set(ctx, p);
    }
    return p;
  }
  const volts = r => Number.isFinite(r.voltage) ? r.voltage : Number.isFinite(r.nominal) ? r.nominal : null;
  const supply = r => r.role === "rail" || r.role === "ground";
  const here = (F, name, doc) => (F.names.get(name)?.items || []).filter(i => i.doc === doc.id && i.kind !== "wire" && i.at);
  // Renames a net name everywhere in the project (labels, ports, power ports, wire names); returns the ids.
  function renameAll(project, doc, from, to) {
    const changed = [];
    for (const d of project?.documents || [doc]) for (const it of d.items || []) {
      if ((it.kind === "netlabel" || it.kind === "power" || it.kind === "port" || it.kind === "offsheet") && it.text === from) { it.text = to; changed.push(it.id); }
      else if (it.kind === "wire" && it.net === from) { it.net = to; changed.push(it.id); }
    }
    if (!changed.length) throw Error(from + " is no longer in the design; check it again.");
    return changed;
  }

  // ---------------------------------------------------------------- pairs
  const INVERTS = /^(?:PCIE\d?|SATA|SGMII|MIPI|CSI|DSI)$/;
  const CONNECTOR = /^(?:J|CN|CON|P|X|USB)\d/i;
  // Pairs of the project: name pairs (A/B excluded: their polarity is vendor-defined) and declared diff
  // signals (polarity from the legs).
  function pairsOf(ctx) {
    const p = P(ctx);
    if (p.pairs) return p.pairs;
    const out = new Map();
    for (const x of N().pairs([...p.F.names.keys()], [], {min: "likely"})) out.set(x.positive + "\u0001" + x.negative, {pos: x.positive, neg: x.negative, protocol: N().read(x.positive).protocol || "", declared: false});
    for (const s of ctx.project?.signals?.signals || []) if (s?.kind === "diff" && s.legs?.length === 2) {
      const P1 = s.legs.find(l => l.polarity === 1)?.nets?.[0], N1 = s.legs.find(l => l.polarity === -1)?.nets?.[0];
      if (P1 && N1) out.set(P1 + "\u0001" + N1, {pos: P1, neg: N1, protocol: N().read(P1).protocol || "", declared: true});
    }
    return p.pairs = [...out.values()];
  }
  function pairSwap(ctx) {
    const {F} = P(ctx), out = [];
    for (const pr of pairsOf(ctx)) {
      const onPos = F.pins.get(pr.pos) || [], onNeg = F.pins.get(pr.neg) || [];
      for (const a of onPos) {
        if (a.doc !== ctx.doc.id) continue;
        const pa = a.name && N().polarity(a.name);
        if (!pa || pa.polarity !== -1) continue;
        const b = onNeg.find(x => x.part === a.part && x.name && N().polarity(x.name)?.polarity === 1 && N().polarity(x.name).stem === pa.stem);
        if (!b) continue;
        if (INVERTS.test(pr.protocol) && !CONNECTOR.test(a.ref)) continue;
        out.push({objects: [a.part.id], at: a.at.slice(), net: pr.pos, severity: "advice", message: t("insights.pairswap.message", {pos: pr.pos, neg: pr.neg, ref: a.ref, pinA: a.name, pinB: b.name}),
          sig: ["pairSwap", pr.pos, pr.neg, a.number, b.number].join("|")});
      }
    }
    return out;
  }
  const NEG_ALT = ["N", "M", "NEG", "MINUS", "DN", "DM", "-"], POS_ALT = ["P", "POS", "PLUS", "DP", "+"];
  function pairOrphan(ctx) {
    const {F, read} = P(ctx), out = [], names = [...F.names.keys()], byNorm = new Map();
    for (const n of names) { const k = norm(n); if (!byNorm.has(k)) byNorm.set(k, []); byNorm.get(k).push(n); }
    const complete = new Map(), paired = new Set();
    for (const x of N().pairs(names, [], {min: "weak"})) { complete.set(x.pattern, (complete.get(x.pattern) || 0) + 1); paired.add(x.positive); paired.add(x.negative); }
    for (const n of names) {
      if (paired.has(n)) continue;
      const r = read(n), m = r.role === "pairMember" ? r : null;
      if (!m || m.known === false || m.analog) continue;
      if (m.partners.some(x => F.names.has(x))) continue; // ambiguous or claimed elsewhere: pairs() said no
      const partner = m.partners[0], spots = here(F, n, ctx.doc);
      if (!spots.length) continue;
      // A near miss: the partner in other case or separators, or with another polarity word.
      let near = (byNorm.get(norm(partner)) || []).find(x => x !== n && !paired.has(x)) || null;
      if (!near) {
        const alts = m.polarity > 0 ? NEG_ALT : POS_ALT, tail = /^(.*?)([A-Za-z]+|[+-])(\d*)$/.exec(partner);
        if (tail) for (const alt of alts) {
          const c = tail[1] + (tail[2] === tail[2].toLowerCase() ? alt.toLowerCase() : alt) + tail[3], hit = (byNorm.get(norm(c)) || []).find(x => x !== n && !paired.has(x) && !N().pairs([n, x]).length);
          if (hit && norm(c) !== norm(n)) { near = hit; break; }
        }
      }
      const count = complete.get(m.pattern) || 0;
      if (!near && count < 2) continue;
      const fix = near && {label: t("insights.orphan.fix", {near, partner}), apply: (doc, project) => renameAll(project, doc, near, partner)};
      out.push({objects: spots.map(s => s.id), at: spots[0].at.slice(), net: n, severity: near ? "advice" : "tip",
        message: near ? t("insights.orphan.near", {name: n, partner, near}) : t("insights.orphan.message", {name: n, partner, count, pattern: m.pattern}),
        sig: ["pairOrphan", n, near || ""].join("|"), ...(fix ? {fix} : {})});
    }
    return out;
  }

  // ---------------------------------------------------------------- rails
  function railConflict(ctx) {
    const {F, read} = P(ctx), out = [];
    for (const al of F.aliases) {
      if (al.doc !== ctx.doc.id) continue;
      const a = read(al.net), b = read(al.name);
      if (!supply(a) || !supply(b)) continue;
      const va = volts(a), vb = volts(b), base = {objects: [al.item.id], at: al.at.slice(), net: al.net, sig: ["railConflict", ...[al.net, al.name].sort()].join("|")};
      if (a.role === "ground" && b.role === "ground") continue; // ground domains: isolationBridge
      if (a.role !== b.role) { out.push({...base, severity: "advice", message: t("insights.railconflict.ground", {a: a.role === "rail" ? al.net : al.name, b: a.role === "rail" ? al.name : al.net})}); continue; }
      if (va == null || vb == null) continue; // VCC with 3V3: a usual alias
      if (Math.abs(va - vb) > 1e-6) { out.push({...base, severity: "advice", message: t("insights.railconflict.volts", {a: al.net, va: r2(va), b: al.name, vb: r2(vb)})}); continue; }
      if (!Number.isFinite(a.voltage) || !Number.isFinite(b.voltage)) continue; // VBUS with 5V: a nominal voltage is not a spelling
      const uses = n => F.names.get(n)?.n || 0, [to, from] = uses(al.net) >= uses(al.name) ? [al.net, al.name] : [al.name, al.net];
      out.push({...base, severity: "tip", message: t("insights.railconflict.same", {a: al.net, b: al.name, v: r2(va)}),
        fix: {label: t("insights.railconflict.fix", {to, from}), apply: (doc, project) => renameAll(project, doc, from, to)}});
    }
    return out;
  }
  const VOLT_TOKENS = /(?:^|[^A-Z0-9])[+-]?(?:\d+V\d+|\d+(?:[.,]\d+)?V)(?![A-Z0-9])|\d+V\d+/gi;
  function railVoltage(nr, evidence) {
    if (nr.role === "ground") return {v: 0, ground: true, isolated: !!nr.isolated, domain: nr.domain, by: t("insights.railpin.named")};
    if (evidence) return X().regulatorMatchesName(nr, evidence) ? {v: evidence.voltage, isolated: evidence.isolated, domain: evidence.domain, by: evidence.basis, evidence} : null;
    const v = volts(nr);
    return nr.role === "rail" && v != null ? {v, isolated: /ISO/i.test(nr.variant || ""), by: t("insights.railpin.named")} : null;
  }
  function railPinMismatch(ctx) {
    const {F, read, regulators} = P(ctx), reg = regulators(), out = [];
    for (const [net, pins] of F.pins) {
      const nr = read(net), evidence = reg.get(net), p = evidence?.pin;
      const nameV = nr.role === "ground" ? 0 : nr.voltage;
      if (p?.doc === ctx.doc.id && Number.isFinite(nameV) && !X().regulatorMatchesName(nr, evidence)) {
        out.push({objects: [p.part.id], at: p.at.slice(), net, severity: "advice",
          message: t("insights.railpin.regulator", {ref: p.ref, pin: p.name, pv: r2(evidence.voltage), basis: evidence.basis, net, nv: r2(nameV)}),
          sig: ["railOutput", net, p.name].join("|")});
      }
      const rail = railVoltage(nr, evidence);
      if (!rail || rail.ground) continue;
      for (const p of pins) {
        if (p.doc !== ctx.doc.id || !p.name) continue;
        const pr = N().read(p.name);
        if (pr.role !== "rail" || !Number.isFinite(pr.voltage) || (p.name.match(VOLT_TOKENS) || []).length !== 1) continue;
        const pv = pr.voltage;
        if (X().closeVoltage(pv, rail.v)) continue;
        out.push({objects: [p.part.id], at: p.at.slice(), net, severity: "advice", message: t("insights.railpin.message", {ref: p.ref, pin: p.name, pv: r2(pv), net, nv: r2(rail.v), basis: rail.by}), sig: ["railPin", net, p.name].join("|")});
      }
    }
    return out;
  }
  // A capacitor's voltage rating: a Voltage parameter (part, then library), else its value (10u/16V).
  const RATING = /^(?:voltage|rated ?voltage|voltage ?rating|v ?rated|vr|vmax|vdc|working ?voltage|rating)$/i;
  function ratingOf(part, def) {
    for (const src of [part.parameters, def?.parameters]) if (src && typeof src === "object") for (const [k, v] of Object.entries(src)) {
      if (!RATING.test(k.trim()) || typeof v === "object") continue;
      const m = /^\s*(\d+(?:[.,]\d+)?)\s*(k)?\s*V?/i.exec(String(v));
      if (m) return +m[1].replace(",", ".") * (m[2] ? 1000 : 1);
    }
    const val = String(part.value ?? def?.value ?? "");
    if (!/\d\s*[pnuµμ](?:F|\d|(?![A-Za-z]))|\d\s*mF\b|\dF\b/i.test(val)) return null;
    const m = /(\d+(?:[.,]\d+)?)\s*(k)?V(?:DC)?\b/i.exec(val);
    return m ? +m[1].replace(",", ".") * (m[2] ? 1000 : 1) : null;
  }
  function capRating(ctx) {
    const {F, read, regulators} = P(ctx), reg = regulators(), out = [], derate = ctx.settings?.derate ?? 1.5;
    for (const c of F.twoPin) {
      if (c.doc !== ctx.doc.id || !/^C\d/i.test(c.ref)) continue;
      const [a, b] = c.nets;
      if (!a || !b) continue;
      const ra = railVoltage(read(a), reg.get(a)), rb = railVoltage(read(b), reg.get(b));
      if (!ra || !rb) continue;
      const inferred = ra.evidence || rb.evidence;
      if (inferred && (ra.isolated !== rb.isolated || ra.isolated && ra.domain && rb.domain && ra.domain !== rb.domain)) continue;
      const v = Math.abs(ra.v - rb.v), rating = ratingOf(c.part, c.def);
      if (!v || rating == null || rating >= v * derate - 1e-9) continue;
      const net = ra.ground ? b : a, both = !ra.ground && !rb.ground;
      const kind = inferred ? rating < v ? "insights.cap.source_below" : "insights.cap.source" : rating < v ? "insights.cap.below" : "insights.cap.message";
      const basis = inferred ? [[a, ra], [b, rb]].map(([n, r]) => t("insights.cap.basis", {net: n, v: r2(r.v), by: r.by})).join(" · ") : "";
      out.push({objects: [c.part.id], at: c.pins[0].at.slice(), net, severity: rating < v ? "advice" : "tip", value: rating,
        message: t(kind, {ref: c.ref, rating: r2(rating), net: both ? a + "/" + b : net, v: r2(v), derate: r2(derate), basis}),
        sig: ["capRating", c.nets.slice().sort().join("/"), r2(rating), r2(derate)].join("|")});
    }
    return out;
  }

  // ---------------------------------------------------------------- buses
  function busGap(ctx) {
    const {F, conv, read} = P(ctx), out = [], stems = new Map();
    for (const n of F.names.keys()) {
      const r = read(n);
      if (!Number.isFinite(r.index) || !r.stem || /^(?:rail|ground|pairMember|auto|nc|railSignal)$/.test(r.role) || !Number.isInteger(r.index)) continue;
      let s = stems.get(r.stem); if (!s) stems.set(r.stem, s = new Map());
      if (!s.has(r.index)) s.set(r.index, n);
    }
    const never = new Set(conv.never.bus.map(upper)), allNorm = new Set([...F.names.keys()].map(norm));
    for (const [stem, members] of stems) {
      if (members.size < 4 || never.has(upper(stem.replace(/[_\-.[\]]+$/, "")))) continue;
      const idx = [...members.keys()].sort((a, b) => a - b), lo = idx[0], hi = idx.at(-1), holes = [];
      for (let i = lo; i <= hi && holes.length < 3; i++) if (!members.has(i)) holes.push(i);
      if (!holes.length || holes.length > 2 || hi - lo + 1 !== members.size + holes.length) continue;
      const ex = members.get(hi), name = i => ex.replace(/\d+(?=\]?$)/, String(i)), missing = holes.map(name);
      if (missing.some(m => allNorm.has(norm(m)))) continue; // spelt differently: netTypo's case
      const anchor = members.get(holes[0] - 1) || members.get(lo), spots = here(F, anchor, ctx.doc);
      const first = (F.names.get(anchor)?.items || []).find(i => i.kind !== "wire" && i.at);
      if (!spots.length || first?.doc !== ctx.doc.id) continue;
      out.push({objects: spots.map(s => s.id), at: spots[0].at.slice(), net: anchor, severity: "tip", message: t("insights.busgap.message", {from: members.get(lo), to: ex, missing: missing.join(", ")}),
        sig: ["busGap", upper(stem), holes.join(",")].join("|")});
    }
    return out;
  }

  // ---------------------------------------------------------------- isolation
  const iso = r => r.role === "ground" && (r.isolated || /ISO/i.test(r.domain || ""));
  // A two-pin part that joins its nets directly: a 0 Ω (or ≤ 1 Ω) resistor, jumper, ferrite, inductor, net tie.
  function direct(part) {
    const ref = String(part.ref || "");
    if (/^(?:FB|L|JP|NT|SJ|W|Z)\d/i.test(ref)) return true;
    if (!/^R\d/i.test(ref)) return false;
    const v = String(part.value ?? "").trim().replace(/\s+/g, "").replace(/Ω|ohms?/gi, "R");
    const m = /^(\d+(?:[.,]\d+)?)([RkKmM]?)(\d*)$/.exec(v);
    if (!m) return /^0R?$|^jumper|^short/i.test(v);
    const n = +(m[1].replace(",", ".") + (m[3] ? "." + m[3] : "")) * ({k: 1e3, K: 1e3, M: 1e6, m: 1e-3}[m[2]] || 1);
    return n <= 1;
  }
  function bridges(ctx, list) {
    const {read} = P(ctx), out = [];
    for (const c of list) {
      const [a, b] = c.nets;
      if (!a || !b || a === b) continue;
      const ra = read(a), rb = read(b);
      if (ra.role !== "ground" || rb.role !== "ground" || !(iso(ra) || iso(rb)) || iso(ra) && iso(rb) && ra.domain === rb.domain || !direct(c.part)) continue;
      out.push({c, a, b});
    }
    return out;
  }
  function isolationBridge(ctx) {
    const {F, read} = P(ctx), out = [];
    for (const al of F.aliases) {
      if (al.doc !== ctx.doc.id) continue;
      const a = read(al.net), b = read(al.name);
      if (a.role !== "ground" || b.role !== "ground" || !(iso(a) || iso(b)) || iso(a) && iso(b) && a.domain === b.domain) continue;
      out.push({objects: [al.item.id], at: al.at.slice(), net: al.net, severity: "advice", message: t("insights.iso.net", {a: al.net, b: al.name}), sig: ["iso", ...[al.net, al.name].sort()].join("|")});
    }
    for (const {c, a, b} of bridges(ctx, F.twoPin.filter(x => x.doc === ctx.doc.id)))
      out.push({objects: [c.part.id], at: c.pins[0].at.slice(), net: a, severity: "advice", message: t("insights.iso.part", {ref: c.ref, a, b}), sig: ["iso", ...[a, b].sort()].join("|")});
    return out;
  }
  function isolationBridgeBoard(ctx) {
    const {F} = P(ctx), out = [], mine = new Set(ctx.doc.items.map(i => i.id));
    for (const {c, a, b} of bridges(ctx, F.boardTwo.filter(x => mine.has(x.part.id)))) {
      const at = Number.isFinite(c.part.x) ? [c.part.x, c.part.y] : null;
      if (at) out.push({objects: [c.part.id], at, net: a, severity: "advice", message: t("insights.iso.part", {ref: c.ref, a, b}), sig: ["iso", ...[a, b].sort()].join("|")});
    }
    return out;
  }

  // A part on two ground domains, one isolated, without a rated creepage (the board check reads the rating).
  const RATED = /^(?:creepage|rated ?creepage|creepage ?distance|external ?creepage|cpg|isolation ?creepage)(?: ?\(mm\))?$/i;
  const hasRating = o => !!o && typeof o === "object" && Object.entries(o).some(([k, v]) => RATED.test(k.trim()) && v != null && String(v).trim() !== "");
  function isolationRating(ctx) {
    const {F, read} = P(ctx), out = [], parts = new Map();
    for (const [net, pins] of F.pins) for (const p of pins) {
      if (p.doc !== ctx.doc.id) continue;
      let e = parts.get(p.part); if (!e) parts.set(p.part, e = {ref: p.ref, nets: new Set(), pins: 0, at: p.at});
      e.nets.add(net); e.pins++;
    }
    const defs = ctx.defs;
    for (const [part, e] of parts) {
      if (e.pins < 3) continue;
      const doms = new Map();
      for (const n of e.nets) { const r = read(n); if (r.role === "ground") { const k = iso(r) ? "ISO:" + (r.domain || "") : "MAIN"; if (!doms.has(k)) doms.set(k, n); } }
      if (doms.size < 2 || ![...doms.keys()].some(k => k.startsWith("ISO"))) continue;
      if (hasRating(part.parameters) || hasRating(defs?.get?.(part.def)?.parameters)) continue;
      const [a, b] = [...doms.values()].sort();
      out.push({objects: [part.id], at: e.at.slice(), net: a, severity: "tip", message: t("insights.isorating.message", {ref: e.ref, a, b}), sig: ["isoRating", e.ref, a, b].join("|")});
    }
    return out;
  }

  // ---------------------------------------------------------------- suggestions as hints (P1)
  // Many pairs named one way (a PCIe or LVDS bank) are one hint: "Declare all".
  const GROUP = 4;
  function declarationFix(groups, label) {
    return {label, open(host) {
      const run = () => host.edit(() => groups.length === 1 ? X().accept(host.project(), groups[0]) : X().acceptAll(host.project(), groups), label);
      if (G.AtriumSignals) return run();
      return G.AtriumLazy?.need?.("AtriumSignals").then(run, e => host.info?.(e.message));
    }};
  }
  function nameSuggestion(ctx) {
    const {F} = P(ctx), out = [], list = X().suggest(ctx.project, {F}).filter(g => g.kind === "diff" || g.kind === "bus");
    const first = g => g.members[0].net, onThisSheet = g => { const any = (F.names.get(first(g))?.items || []).find(i => i.kind !== "wire" && i.at); return any?.doc === ctx.doc.id && here(F, first(g), ctx.doc); };
    const byPattern = new Map();
    for (const g of list) if (g.kind === "diff") { if (!byPattern.has(g.pattern)) byPattern.set(g.pattern, []); byPattern.get(g.pattern).push(g); }
    const grouped = new Set();
    for (const [pattern, gs] of byPattern) {
      if (gs.length < GROUP) continue;
      for (const g of gs) grouped.add(g);
      const anchor = gs.find(onThisSheet), spots = anchor && onThisSheet(anchor);
      if (!spots?.length) continue;
      const label = t("insights.suggest.fix.pairs", {count: gs.length});
      out.push({objects: spots.map(s => s.id), at: spots[0].at.slice(), net: first(anchor), severity: "tip", sig: "pairs:" + pattern,
        message: t("insights.suggest.pairs", {count: gs.length, pattern, examples: gs.slice(0, 2).map(g => g.name).join(", ")}), fix: declarationFix(gs, label)});
    }
    for (const g of list) {
      if (grouped.has(g)) continue;
      const spots = onThisSheet(g);
      if (!spots?.length) continue;
      const label = t(g.kind === "diff" ? "insights.suggest.fix.pair" : "insights.suggest.fix.bus", {name: g.name});
      out.push({objects: spots.map(s => s.id), at: spots[0].at.slice(), net: first(g), severity: "tip", sig: g.key,
        message: g.kind === "diff" ? t("insights.suggest.pair", {pos: g.positive, neg: g.negative, basis: g.basis}) : t("insights.suggest.bus", {from: first(g), to: g.members.at(-1).net, count: g.members.length, basis: g.basis}),
        fix: declarationFix([g], label)});
    }
    return out;
  }

  function install() {
    const R = I()?.register;
    if (!R || !X()) return false;
    const reg = (id, [title, why, learnMore, prefHelp], run, o = {}) => R({id, kind: "schematic", severity: "advice", title, why, learnMore, prefHelp, scope: "doc", dirtyKinds: ELECTRICAL, run, ...o});
    reg("pairSwap", [t("insights.pairswap.title"), t("insights.pairswap.why"), t("insights.pairswap.learn"), () => t("insights.pairswap.pref_help")], pairSwap);
    reg("pairOrphan", [t("insights.orphan.title"), t("insights.orphan.why"), t("insights.orphan.learn"), () => t("insights.orphan.pref_help")], pairOrphan, {dirtyKinds: NAMES});
    reg("railConflict", [t("insights.railconflict.title"), t("insights.railconflict.why"), t("insights.railconflict.learn"), undefined], railConflict);
    reg("railPinMismatch", [t("insights.railpin.title"), t("insights.railpin.why"), t("insights.railpin.learn"), () => t("insights.railpin.pref_help")], railPinMismatch);
    reg("capRating", [t("insights.cap.title"), t("insights.cap.why"), t("insights.cap.learn"), () => t("insights.cap.pref_help")], capRating, {defaults: {derate: {low: 1.2, normal: 1.5, high: 2}}, settings: [{key: "derate", label: t("insights.cap.derate"), unit: "×", min: 1, max: 4, step: .1}]});
    reg("busGap", [t("insights.busgap.title"), t("insights.busgap.why"), t("insights.busgap.learn"), () => t("insights.busgap.pref_help")], busGap, {severity: "tip", dirtyKinds: NAMES});
    reg("isolationBridge", [t("insights.iso.title"), t("insights.iso.why"), t("insights.iso.learn"), () => t("insights.iso.pref_help")], isolationBridge);
    reg("isolationRating", [t("insights.isorating.title"), t("insights.isorating.why"), t("insights.isorating.learn"), () => t("insights.isorating.pref_help")], isolationRating, {severity: "tip"});
    reg("nameSuggestion", [t("insights.suggest.title"), t("insights.suggest.why"), t("insights.suggest.learn"), () => t("insights.suggest.pref_help")], nameSuggestion, {severity: "tip", dirtyKinds: NAMES});
    G.AtriumCreepage?.install?.(); // the layout creepage hint (creepage.js, loaded with the rules engine)
    R({id: "isolationBridgeBoard", kind: "pcb", severity: "advice", title: t("insights.iso.title"), why: t("insights.iso.why"), prefHelp: () => t("insights.iso.pref_help"), learnMore: t("insights.iso.learn"), scope: "doc", dirtyKinds: ["part"], run: isolationBridgeBoard});
    return true;
  }
  install();
  return Object.freeze({install, ratingOf, direct});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumInsightsIntent;
