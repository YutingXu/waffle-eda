"use strict";
// Compile Project / Electrical Rules Check. Checks every schematic sheet in the
// project and reports through AtriumMessages. Its settings are the ERC rules of the project rule book
// (project-rules.js, project.rules): the unscoped erc<Check> rules set each check's report mode,
// ercPinMatrix the connection matrix, ercNetScope the net identifier scope; scoped ones apply per finding.
globalThis.AtriumERC = (() => {
  const A = Atrium;
  const LEVELS = ["No Report", "Warning", "Error", "Fatal"];
  const CLASS = {Warning:"Warning", Error:"Error", Fatal:"Fatal"};
  const CHECKS = [
    {id:"duplicateDesignators", group:"Components", name:"Duplicate part designators", level:"Error",
      help:"Two or more schematic components use the same designator."},
    {id:"unannotated", group:"Components", name:"Un-designated parts", level:"Error",
      help:"A component designator is empty or still contains '?'."},
    {id:"missingFootprint", group:"Components", name:"Components without a footprint", level:"Warning",
      help:"The component has no footprint model and no linked board component."},
    {id:"floatingInputs", group:"Nets", name:"Floating input pins", level:"Error",
      help:"An input pin is not connected to anything."},
    {id:"unconnectedPins", group:"Nets", name:"Unconnected pins", level:"Warning",
      help:"A visible pin is not connected to a wire, pin or net label. Pins marked No ERC are skipped."},
    {id:"singlePinNets", group:"Nets", name:"Nets with only one pin", level:"Warning",
      help:"A named or wired net reaches only one pin in the project."},
    {id:"multipleNames", group:"Nets", name:"Nets with multiple names", level:"Warning",
      help:"One connected net carries different net labels or power port names."},
    {id:"netTies", group:"Nets", name:"Net tie problems", level:"Error",
      help:"A net tie joins a net to itself, or the nets it ties are also shorted elsewhere on the schematic."},
    {id:"duplicateNets", group:"Nets", name:"Duplicate nets", level:"Error",
      help:"With flat net scope, separate nets on different sheets use the same net label."},
    {id:"floatingLabels", group:"Nets", name:"Floating net labels", level:"Warning",
      help:"A net label is not on a wire or pin."},
    {id:"floatingPower", group:"Nets", name:"Floating power objects", level:"Warning",
      help:"A power port is not on a wire or pin."},
    {id:"danglingWires", group:"Nets", name:"Unconnected wires", level:"Warning",
      help:"A wire end does not reach a pin, wire, junction, net label or No ERC marker."},
    {id:"noDriver", group:"Nets", name:"Nets with no driving source", level:"Warning",
      help:"A net with input pins has no output, bidirectional, power or open-collector/emitter pin, power port or port."},
    {id:"duplicateGate", group:"Components", name:"Gate placed more than once", level:"Error",
      help:"Two placed parts use the same gate (unit) of one multi-gate component."},
    {id:"missingPowerGate", group:"Components", name:"Power gate not placed", level:"Error",
      help:"A multi-gate component has a gate with only power pins that is not placed, so its supply pins are unconnected."},
    {id:"boardMismatch", group:"Documents", name:"Components missing from schematic or board", level:"Warning",
      help:"A component is placed on only one side of a linked schematic and board."},
    {id:"missingSheet", group:"Documents", name:"Sheet symbols without a child sheet", level:"Error",
      help:"A sheet symbol refers to a schematic sheet that is not in the project."},
    {id:"hierarchyLoop", group:"Documents", name:"Hierarchy loops", level:"Error",
      help:"A sheet symbol instantiates a sheet that contains it, directly or further down."},
    {id:"unmatchedEntries", group:"Documents", name:"Unmatched sheet entries and ports", level:"Warning",
      help:"With hierarchical scope, a sheet entry has no port of the same name on the child sheet, or a child port has no entry."},
    {id:"busWidth", group:"Buses", name:"Mismatched bus widths", level:"Warning",
      help:"Bus names drawn on one bus, or a bus sheet entry and the child port of the same name, have different widths (D[0..7] on D[0..15])."},
    {id:"calculationAssertion", group:"Calculations", name:"Calculation assertion", level:"Error", authored:true,
      help:"Compare the authored assertion against the calculated value or range."}
  ];
  const BY_ID = new Map(CHECKS.map(c => [c.id, c]));
  // Altium's pin electrical types, in the order stored by SchDoc pin records.
  const PIN_TYPES = ["Input", "I/O", "Output", "Open Collector", "Passive", "HiZ", "Open Emitter", "Power"];
  const IN=0, IO=1, OUT=2, OC=3, PASSIVE=4, HIZ=5, OE=6, PWR=7;
  const pairKey = (a, b) => Math.min(a, b) + "," + Math.max(a, b);
  // A simplified Altium connection matrix. Unlisted pairs are not reported.
  const MATRIX = {
    [pairKey(OUT, OUT)]:"Error", [pairKey(OUT, OC)]:"Error", [pairKey(OUT, OE)]:"Error", [pairKey(OUT, PWR)]:"Error",
    [pairKey(OC, OE)]:"Error", [pairKey(OC, PWR)]:"Warning", [pairKey(OE, PWR)]:"Warning",
    [pairKey(IO, OC)]:"Warning", [pairKey(IO, OE)]:"Warning", [pairKey(HIZ, OUT)]:"Warning"
  };
  const typeNames = {input:IN, in:IN, io:IO, "i/o":IO, bidirectional:IO, bidi:IO, output:OUT, out:OUT,
    "open collector":OC, opencollector:OC, "open-collector":OC, passive:PASSIVE, hiz:HIZ, tristate:HIZ, "tri-state":HIZ,
    "open emitter":OE, openemitter:OE, "open-emitter":OE, power:PWR};
  function pinType(pin) {
    const e = pin?.electrical;
    if (Number.isInteger(e) && e >= 0 && e <= 7) return e;
    if (typeof e === "string") return typeNames[e.trim().toLowerCase()];
    return undefined;
  }

  // Net identifier scope, as in Altium's project options (hierarchy.js applies it).
  // Global matches how Waffle joins same-named nets across sheets and on the board
  // and stays the default for existing projects. Flat: net labels stay on their sheet,
  // ports, off-sheet connectors and power ports connect sheets. Hierarchical: ports meet
  // the sheet entries of their parent's sheet symbol. Automatic picks one of those as
  // Altium does. Imported harness connectivity is not modelled.
  const SCOPES = {global:"Global (net labels and ports connect across sheets)", automatic:"Automatic (from sheet entries and ports)",
    flat:"Flat (only ports and power ports connect across sheets)", hierarchical:"Hierarchical (ports connect to their parent's sheet entries)"};
  const SO = () => globalThis.AtriumSchObjects, H = () => globalThis.AtriumHierarchy;
  const scopeOf = (project, cfg = settings(project)) => cfg.scope;

  // ---- Settings -----------------------------------------------------------
  function defaults() {
    return {scope:"global", checks:Object.fromEntries(CHECKS.filter(c => !c.authored).map(c => [c.id, c.level])), matrix:{...MATRIX}};
  }
  const level = v => LEVELS.includes(v) ? v : undefined;
  // Read project.erc, ignoring unknown checks and invalid values.
  // The settings the rule book gives (AtriumProjectRules.erc: its unscoped ERC rules in this shape).
  // project.erc is read only when the book cannot be (no rules module, a bare settings object); it goes
  // with the rules mirror (project-rules.js).
  function settings(project) {
    const P = globalThis.AtriumProjectRules;
    let raw = null;
    if (P?.erc && Array.isArray(project?.documents)) try {raw = P.erc(project);} catch {raw = null;}
    if (raw == null) raw = project?.erc ?? null;
    return fromStored(raw);
  }
  // Settings from the stored shape ({version, scope?, checks, matrix}), ignoring unknown checks and invalid values.
  function fromStored(raw) {
    const out = defaults();
    if (!raw || typeof raw !== "object") return out;
    if (Object.hasOwn(SCOPES, raw.scope)) out.scope = raw.scope;
    for (const [id, v] of Object.entries(raw.checks || {})) if (BY_ID.has(id) && !BY_ID.get(id).authored && level(v)) out.checks[id] = v;
    for (const [k, v] of Object.entries(raw.matrix || {})) {
      const m = /^([0-7]),([0-7])$/.exec(k);
      if (m && level(v)) out.matrix[pairKey(+m[1], +m[2])] = v;
    }
    return out;
  }
  // The stored form keeps only overrides, so new checks pick up their defaults.
  function stored(value) {
    const base = defaults(), checks = {}, matrix = {};
    for (const c of CHECKS) { const v = level(value?.checks?.[c.id]); if (!c.authored && v && v !== base.checks[c.id]) checks[c.id] = v; }
    for (let a = 0; a < 8; a++) for (let b = a; b < 8; b++) {
      const k = pairKey(a, b), v = level(value?.matrix?.[k]) || "No Report";
      if (v !== (base.matrix[k] || "No Report")) matrix[k] = v;
    }
    const scope = Object.hasOwn(SCOPES, value?.scope) && value.scope !== "global" ? value.scope : undefined;
    if (!scope && !Object.keys(checks).length && !Object.keys(matrix).length) return null;
    return {version:1, ...(scope ? {scope} : {}), checks, matrix};
  }
  // Options › OK: the unscoped ERC rules of the book become these settings (scoped ones stay).
  function save(project, value) {
    const s = stored(value), P = globalThis.AtriumProjectRules;
    if (!P?.edit) throw Error("The project rules module is not loaded.");
    const records = globalThis.AtriumDesignQueryRecord, all = records.selector("all");
    const sev = v => P.LEVEL_SEVERITY[v] || "warning", unscoped = [];
    const book = P.book(project), ids = new Map();
    for (const rule of book.list) if (P.isErc(rule.type) && !rule.sheets?.length && records.isAll(rule.scope) && !ids.has(rule.type)) ids.set(rule.type, rule.id);
    const idFor = type => ids.get(type) ?? A.id();
    for (const [id, v] of Object.entries(s?.checks || {})) {
      const type = P.ercType(id);
      unscoped.push({id: idFor(type), type, name: type.slice(3), enabled: true, priority: 1, scope: all, severity: sev(v), where: "schematic"});
    }
    if (Object.keys(s?.matrix || {}).length) unscoped.push({id: idFor("ercPinMatrix"), type: "ercPinMatrix", name: "ConnectionMatrix", enabled: true, priority: 1, scope: all, where: "schematic",
      matrix: Object.fromEntries(Object.entries(s.matrix).map(([k, v]) => [k, P.LEVEL_SEVERITY[v] || "off"]))});
    const previous = H()?.scopeRule(book);
    if (previous && previous.netScope === (s?.scope || "global")) unscoped.push(previous);
    else if (s?.scope) unscoped.push({id: idFor("ercNetScope"), type: "ercNetScope", name: "NetIdentifierScope", enabled: true, priority: 1, scope: all, where: "schematic", netScope: s.scope});
    P.edit(project, b => P.setErc(b, [...unscoped, ...b.list.filter(r => P.isErc(r.type) && (r.sheets?.length || !records.isAll(r.scope)))]));
    return s;
  }

  // ---- Sheet connectivity -------------------------------------------------
  // The same rules as Atrium.connectivity (model.js), which only returns net
  // names. ERC also needs the physical attachments at each point, so this graph
  // keeps them. tests/erc.cjs checks that both produce identical nets.
  const labelType = i => A.isOffsheet(i) ? "port" : i.kind === "power" || i.schPaint?.type === "power" ? "power" : i.kind === "port" || i.schPaint?.type === "port" ? "port" : "label";
  const isNoErc = i => /^no-?erc$/i.test(i.kind || "");
  function graph(doc, defs) {
    const parent = new Map(), coords = new Map(), contacts = [], names = [], wires = [], labels = [], junctions = new Map(), noErc = new Set();
    const entryNodes = new Set(), busEnds = new Set(), directions = new Map(), objects = SO();
    const touches = new Map(); // node -> Set of wire ids whose segments pass through it
    function node(p) {const k = A.pointKey(p); if (!parent.has(k)) {parent.set(k, k); coords.set(k, p);} return k;}
    function root(k) {let r = k; while (parent.get(r) !== r) r = parent.get(r); while (k !== r) {const n = parent.get(k); parent.set(k, r); k = n;} return r;}
    function join(a, b) {const x = root(a), y = root(b); if (x !== y) parent.set(y, x);}
    const count = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const i of doc.items) {
      if (A.isOffsheet(i) && i.io != null) {
        const electrical = A.offsheetIO(i.io);
        if (electrical !== "unspecified") {
          const at = [i.x, i.y];
          directions.set(i.id, {i, doc, key:A.pointKey(at), connector:true, pin:{electrical, at}});
        }
      }
      if (i.kind === "part") for (const pin of A.pins(i, defs.get(i.def), "schematic")) contacts.push({i, pin, key:node(pin.at)});
      if (i.kind === "wire" && i.points.length > 1) {
        const keys = i.points.map(node); for (const k of keys.slice(1)) join(keys[0], k);
        wires.push([i, keys[0], keys]); if (i.net) names.push([keys[0], i.net, i]);
      }
      if (i.kind === "junction") count(junctions, node([i.x, i.y]));
      if (i.kind === "netlabel" && !objects?.isBus(i.text)) {const k = node([i.x, i.y]); names.push([k, i.text, i]); labels.push({item:i, key:k, type:labelType(i)});}
      if (objects?.KINDS.has(i.kind)) {
        // Power ports, ports and off-sheet connectors name nets; sheet entries are anonymous nodes.
        for (const [p, name] of objects.netSources(i)) {
          const k = node(p);
          if (name) {names.push([k, name, i]); labels.push({item:i, key:k, type:labelType(i)});} else entryNodes.add(k);
        }
        if (i.kind === "busentry") for (const p of objects.hotspots(i)) busEnds.add(A.pointKey(p));
      }
      if (isNoErc(i) && Number.isFinite(i.x) && Number.isFinite(i.y)) noErc.add(node([i.x, i.y]));
    }
    const rows = new Map(), cols = new Map();
    const add = (m, k, v) => {if (!m.has(k)) m.set(k, []); m.get(k).push(v);};
    for (const [k, p] of coords) {add(rows, Math.round(p[1] * 10000), [k, p]); add(cols, Math.round(p[0] * 10000), [k, p]);}
    for (const [w, k] of wires) for (let n = 1; n < w.points.length; n++) {
      const a = w.points[n - 1], b = w.points[n];
      const candidates = a[1] === b[1] ? rows.get(Math.round(a[1] * 10000)) : a[0] === b[0] ? cols.get(Math.round(a[0] * 10000)) : coords;
      for (const [j, p] of candidates || []) if (A.nearSegment(p, a, b) < 0.00011) {
        join(k, j);
        if (!touches.has(j)) touches.set(j, new Set());
        touches.get(j).add(w.id);
      }
    }
    // Physical groups, before net labels with the same name are joined.
    const physical = new Map();
    for (const k of parent.keys()) physical.set(k, root(k));
    const labelRoots = new Map();
    for (const [k, name] of names) {if (labelRoots.has(name)) join(k, labelRoots.get(name)); else labelRoots.set(name, k);}
    const groups = new Map();
    function group(k) {const r = root(k); if (!groups.has(r)) groups.set(r, {root:r, names:new Set(), sources:[], pins:[], wires:[]}); return groups.get(r);}
    for (const [k, name, item] of names) {const g = group(k); g.names.add(name); g.sources.push({name, item, key:k});}
    for (const c of contacts) group(c.key).pins.push(c);
    for (const [w, k] of wires) group(k).wires.push(w);
    const byPin = new Map(), byWire = new Map(), nets = [];
    for (const g of groups.values()) {
      if (g.pins.length < 2 && !g.wires.length && !g.names.size) continue;
      const first = g.pins[0];
      g.name = [...g.names][0] || (first ? A.autoNetName(doc, g.pins.map(c => [c.i.ref, c.pin.number])) || "Net-" + first.i.ref + "-" + first.pin.number : "Net-" + (nets.length + 1));
      for (const c of g.pins) byPin.set(c.i.id + "/" + c.pin.number, g.name);
      for (const w of g.wires) byWire.set(w.id, g.name);
      nets.push(g);
    }
    // What is physically attached at each point (before label joins).
    const physicalContent = new Map();
    function content(r) {if (!physicalContent.has(r)) physicalContent.set(r, {pins:0, wires:0, labels:0}); return physicalContent.get(r);}
    for (const c of contacts) content(physical.get(c.key)).pins++;
    for (const [, k] of wires) content(physical.get(k)).wires++;
    for (const l of labels) content(physical.get(l.key)).labels++;
    const pinsAt = new Map(), labelsAt = new Map(), vertexAt = new Map();
    for (const c of contacts) count(pinsAt, c.key);
    for (const l of labels) count(labelsAt, l.key);
    for (const [, , keys] of wires) for (const k of keys) count(vertexAt, k);
    const entryGroups = new Set([...entryNodes].map(k => physical.get(k)));
    return {doc, byPin, byWire, nets, contacts, wires, labels, groups, noErc, touches, junctions, pinsAt, labelsAt, vertexAt, entryNodes, entryGroups, busEnds, directions,
      physicalOf:k => physical.get(k), physicalContent:r => physicalContent.get(r) || {pins:0, wires:0, labels:0}, netOf:k => groups.get(root(k)),
      point:k => coords.get(k)};
  }

  // ---- Checks -------------------------------------------------------------
  const upper = s => String(s || "").trim().toUpperCase();
  const unannotated = ref => !String(ref || "").trim() || String(ref).includes("?");
  const natural = new Intl.Collator("en", {numeric:true});
  const pinText = c => c.i.ref + "-" + c.pin.number + (c.pin.name && c.pin.name !== c.pin.number ? " (" + c.pin.name + ")" : "");
  const list = (values, max = 4) => values.slice(0, max).join(", ") + (values.length > max ? " and " + (values.length - max) + " more" : "");
  // run() drains steps(), a generator that yields between stages and after each sheet, so live
  // checking (checks.js) can slice it. A results cache opts into the journal-certified sheet graphs.
  const hasCalculations = project => (project?.documents || []).some(d => d.kind === "schematic" &&
    d.items?.some(i => i?.kind === "calculation" || i?.kind === "textframe" && i.calculation != null));
  const hasCalculationAssertions = project => project.rules?.list?.some(r =>
    r.type === "ercCalculationAssertion" && r.enabled !== false && r.severity !== "off");
  function loadCalculations(project) {
    if (!hasCalculations(project)) return null;
    return globalThis.AtriumCalculations || globalThis.AtriumLazy?.need("AtriumCalculations");
  }
  async function prepareCalculations(project, options = {}) {
    const C = await loadCalculations(project);
    if (!C) return null;
    return C.evaluate(project, options);
  }
  function run(project, options = {}) {
    if (options.calculationSnapshot === undefined && hasCalculationAssertions(project)) {
      const calculations = globalThis.AtriumCalculations;
      if (!calculations) throw Error("Prepare the calculation snapshot before checking assertions.");
      options = {...options, calculationSnapshot: calculations.evaluateSnapshot(project, {revision: options.revision})};
    }
    const it = steps(project, options);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  }
  async function runAsync(project, options = {}) {
    if (options.calculationSnapshot !== undefined || !hasCalculationAssertions(project) || !globalThis.document) return run(project, options);
    const calculationSnapshot = await prepareCalculations(project, options);
    return run(project, {...options, calculationSnapshot});
  }
  // Keep ERC findings with this ERC run's cache; its geometry lives in the shared sheet entry.
  // A consumer that supplies no cache gets the full reference computation.
  function graphOf(project, doc, defs, options, rebuilt) {
    const sheet = options.cache && A.sheetEntry(project, doc, defs);
    if (!sheet) { rebuilt.add(doc.id); return graph(doc, defs); }
    let e = options.cache.get(doc);
    if (e?.sheet !== sheet) { e = {sheet}; rebuilt.add(doc.id); }
    options.entries.set(doc, e);
    return sheet.erc ??= graph(doc, defs);
  }
  const netSigs = new WeakMap();
  // Scoped ERC rules (project.rules, project-rules.js): rules of the erc* types that apply to some sheets,
  // nets or components only. null when there are none (ERC then reads the unscoped rules alone).
  // Subjects: {component (designator), net, sheet}; scopes: All, Net, Component, Net Class, Component
  // Class (by designator, as on boards) and queries (InComponentClass('TestPoints'), InNet('VBUS') ...).
  const classFamilies = new Set(["netclass","componentclass"]);
  function usesBoardScopes(project) {
    const P = globalThis.AtriumProjectRules, records = globalThis.AtriumDesignQueryRecord;
    return !!project?.rules?.list?.some(r => {
      if (!P?.isErc(r.type) || r.enabled === false || !r.scope) return false;
      const selector = r.scope.kind ? r.scope : records?.toSelector(r.scope);
      return !selector || selector.kind === "query" || classFamilies.has(selector.kind);
    });
  }
  function scopedRules(project, book = project?.rules, {includeUnscoped = false} = {}) {
    const P = globalThis.AtriumProjectRules, K = globalThis.AtriumRules?.kit;
    if (!P?.book || !book) return null;
    const list = (book.list || []).filter(r => P.isErc(r.type) && r.type !== "ercNetScope" &&
      (r.type !== "ercCalculationAssertion" || r.severity !== "off" && globalThis.AtriumDesignQueryRecord?.isFuture(r.scope)) &&
      r.enabled !== false && (includeUnscoped || r.sheets?.length || !K.allScope(r.scope))).sort((a,b) => (a.priority || 1) - (b.priority || 1));
    if (!list.length) return null;
    const boards = project.documents.filter(d => d.kind === "pcb"), membership = new Map();
    function classes(family) {
      if (membership.has(family)) return membership.get(family);
      const result = new Map();
      for (const b of boards) {
        const source = family === "netclass" ? Object.entries(globalThis.AtriumRules.netClasses(b,{project}) || {}) : globalThis.AtriumComponentClasses?.map(b,project) || [];
        for (const [key,values] of source) {
          if (!result.has(key)) result.set(key,new Set());
          for (const value of values) result.get(key).add(value);
        }
      }
      membership.set(family,result);
      return result;
    }
    const perDoc = new Map(), errors = new Map(), dependencies = new Set();
    const byType = new Map();
    for (const r of list) {
      const check = {id:r.id,type:r.type,name:r.name,priority:r.priority,sheets:new Map(), level:P.SEVERITY_LEVEL[r.severity] ?? "No Report",
        matrix:r.matrix ? Object.fromEntries(Object.entries(r.matrix).map(([k,v]) => [k,P.SEVERITY_LEVEL[v] ?? "No Report"])) : null};
      for (const doc of project.documents) {
        if (doc.kind !== "schematic" && !(doc.kind === "pcb" && r.type === "ercBoardMismatch")) continue;
        if (r.sheets?.length && !r.sheets.includes(doc.id)) continue;
        if (!perDoc.has(doc)) perDoc.set(doc,K.scopePlans(Q => Q.context(project,doc,{domain:"schematic",
          ruleValue() { return doc.kind==="pcb" ? undefined : null; },
          resolveRef({family,name,binding}) {
            if (binding?.target || !classFamilies.has(family)) return undefined;
            if (classes(family).has(name) || name === (family === "netclass" ? "All Nets" : "All Components")) return {target:{name}};
            return undefined;
          },
          relation(subject,family,target) {
            if (!classFamilies.has(family)) return undefined;
            const key = family === "netclass" ? subject.net : subject.component;
            return !!key && (classes(family).get(target.name)?.has(key) ?? target.name === (family === "netclass" ? "All Nets" : "All Components"));
          }
        })));
        const {plan,diagnostics} = perDoc.get(doc)(r.scope);
        for (const d of diagnostics) {
          const issue = K.scopeDiagnostic(r,"scope",d), key = JSON.stringify(issue);
          if (!errors.has(key)) errors.set(key,{...issue,documentId:doc.id});
        }
        if (plan) {
          check.sheets.set(doc,plan);
          for (const dependency of plan.dependencies) dependencies.add(dependency);
        }
      }
      if (!byType.has(r.type)) byType.set(r.type,[]);
      byType.get(r.type).push(check);
    }
    // A class can change on a different board while the sheet's connectivity
    // and authored rule stay identical.
    const sets = [...membership].map(([family,map]) => [family,[...map].map(([k,v]) => [k,[...v].sort()])]);
    const sig = JSON.stringify([list,sets,[...errors.values()]]);
    return {sig, byType, get diagnostics(){return [...errors.values()];}, dependencies, rule(check,doc,subject) {
      for (const r of byType.get(P.ercType(check)) || []) {
        const plan = r.sheets.get(doc);
        if (!plan) continue;
        const match = plan.test(subject);
        if (match === true) return r;
        const missing = match === null && plan.requiredMissing?.(subject);
        if (missing) {
          const key=JSON.stringify([r.id,doc.id,missing.code,missing.span]);
          if (!errors.has(key)) errors.set(key,{...K.scopeDiagnostic(r,"scope",missing),documentId:doc.id,objectId:subject.id});
        }
      }
      return null;
    }};
  }
  function ruleSubject(doc,item,net,component,instanceId,point) {
    return {docId:doc?.id,sheet:doc?.id,item,id:item?.id,kind:item?.kind,net,
      component:item?.kind === "part" ? item.ref : component,instanceId,at:point ?? (Number.isFinite(item?.x) ? [item.x,item.y] : undefined)};
  }
  function* steps(project, options = {}) {
    options = {...options, entries:new Map()};
    const cfg = options.settings || settings(project), now = options.time || new Date();
    const defs = new Map(project.library.map(d => [d.id, d]));
    const sheets = project.documents.filter(d => d.kind === "schematic");
    const boards = project.documents.filter(d => d.kind === "pcb");
    const messages = [];
    const reuse = list => { for (const m of list) messages.push(m.time === now ? m : {...m, time:now}); };
    // Scoped ERC rules of the project rule book (project-rules.js): the first matching rule of a check sets
    // its level for that finding (off drops it); unscoped rules are cfg (the project.erc mirror) as before.
    const scoped = options.scoped !== undefined ? options.scoped : scopedRules(project);
    const projectRules = globalThis.AtriumProjectRules;
    const fallbacks = options.onCheck && !options.settings ? projectRules?.ercFallbacks(project) : null;
    function report(check, doc, text, object, point, extra) {
      const subject = (scoped || options.onCheck) ? ruleSubject(doc,object,extra?.net,extra?.component,
        extra?.instanceId ?? object?.mcInstance?.id,point) : null;
      const rule = scoped?.rule(check,doc,subject);
      const mode = rule ? rule.level : cfg.checks[check] ?? BY_ID.get(check)?.level;
      const finding = CLASS[mode] ? {class:CLASS[mode], source:"Compiler", check, text, document:doc?.name || "", documentId:doc?.id,
        objectId:object?.id, point:point ? [point[0], point[1]] : object && Number.isFinite(object.x) ? [object.x, object.y] : undefined, time:now, ...extra} : null;
      if (finding) messages.push(finding);
      options.onCheck?.(check,doc,subject,rule ?? fallbacks?.get(projectRules.ercType(check)),finding);
    }
    const graphs = [], rebuilt = new Set(); // sheets whose graph was built in this run (live checking)
    for (const s of sheets) { graphs.push(graphOf(project, s, defs, options, rebuilt)); yield "graph"; }
    // Graphical and mechanical parts (Altium component kinds) are not electrical: no pin checks.
    const quiet = i => !!SO()?.notElectrical?.(i, defs.get(i.def));
    const parts = (globalThis.AtriumMultichannel?.ercParts(project, sheets, !!options.cache) || sheets.flatMap(s => s.items.filter(i => i.kind === "part").map(i => ({i, doc:s}))))
      .filter(p => SO()?.componentKind?.(p.i, defs.get(p.i.def)) !== "graphical");

    // Designators.
    const byRef = new Map();
    for (const p of parts) {
      if (unannotated(p.i.ref)) {report("unannotated", p.doc, "Component " + (p.i.ref || "(no designator)") + " " + (defs.get(p.i.def)?.name || p.i.value || "") + " has not been annotated", p.i); continue;}
      const k = upper(p.i.ref); if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(p);
    }
    for (const group of byRef.values()) {
      if (group.length < 2) continue;
      // Altium multi-part components share one designator: the parts come from
      // one library reference and their visible pins do not overlap.
      const ds = group.map(p => defs.get(p.i.def));
      if (ds[0]?.symbol?.parts > 1 && group.every(p => p.i.def === group[0].i.def)) {
        const seen = new Map();
        for (const p of group) {
          const u = p.i.unit || p.i.part || 1;
          if (seen.has(u)) report("duplicateGate", p.doc, "Gate " + (u <= 26 ? String.fromCharCode(64 + u) : u) + " of " + p.i.ref + " is placed more than once", p.i, undefined, {sig:"gate:" + u});
          else seen.set(u, p);
        }
        continue;
      }
      const visible = ds.map(d => (d?.symbol?.pins || []).filter(pin => !pin.hidden).map(pin => pin.number));
      const numbers = visible.flat();
      const multipart = ds.every(d => d && d.name === ds[0].name) && visible.every(v => v.length) && new Set(numbers).size === numbers.length;
      if (multipart) continue;
      for (const p of group) {
        const others = group.filter(o => o !== p).map(o => o.doc === p.doc ? "this sheet" : o.doc.name);
        report("duplicateDesignators", p.doc, "Duplicate component designator " + p.i.ref + " (also on " + list([...new Set(others)]) + ")", p.i);
      }
    }

    for (const group of byRef.values()) {
      const d = defs.get(group[0].i.def);
      if (!(d?.symbol?.parts > 1) || !group.every(p => p.i.def === d.id)) continue;
      const used = new Set(group.map(p => p.i.unit || p.i.part || 1));
      for (let g = 1; g <= d.symbol.parts; g++) {
        const own = (d.symbol.pins || []).filter(x => x.part === g);
        if (!used.has(g) && own.length && own.every(x => x.electrical === 7))
          report("missingPowerGate", group[0].doc, "Power gate " + (g <= 26 ? String.fromCharCode(64 + g) : g) + " of " + group[0].i.ref + " is not placed; pins " + own.map(x => x.number).join(", ") + " are unconnected", group[0].i, undefined, {sig:"gate:" + g});
      }
    }
    yield "designators";
    // Board links.
    const boardParts = boards.flatMap(b => b.items.filter(i => i.kind === "part").map(i => ({i, doc:b})));
    const boardLinks = new Set(boardParts.map(p => p.i.link).filter(Boolean)), boardRefs = new Set(boardParts.map(p => upper(p.i.ref)));
    const onBoard = p => (p.i.link && boardLinks.has(p.i.link)) || boardRefs.has(upper(p.i.ref));
    for (const p of parts) {
      const d = defs.get(p.i.def);
      if (!d?.footprint && !String(d?.footprintName || "").trim() && !onBoard(p))
        report("missingFootprint", p.doc, "Component " + p.i.ref + " " + (d?.name || "") + " has no footprint", p.i);
    }
    for (const board of boards) {
      const placed = boardParts.filter(p => p.doc === board);
      if (!placed.length) continue; // An empty board has not been populated yet.
      const links = new Set(placed.map(p => p.i.link).filter(Boolean)), refs = new Set(placed.map(p => upper(p.i.ref)));
      for (const p of parts) if (!unannotated(p.i.ref) && !((p.i.link && links.has(p.i.link)) || refs.has(upper(p.i.ref))))
        report("boardMismatch", p.doc, "Component " + p.i.ref + " is not on " + board.name, p.i, undefined, {sig:"board:" + board.id});
    }
    if (boardParts.length) {
      const links = new Set(parts.map(p => p.i.link).filter(Boolean)), refs = new Set(parts.map(p => upper(p.i.ref)));
      for (const p of boardParts) if (!((p.i.link && links.has(p.i.link)) || refs.has(upper(p.i.ref))))
        report("boardMismatch", p.doc, "Board component " + p.i.ref + " has no schematic component", p.i, undefined, {sig:"orphan"});
    }

    yield "boards";
    // Sheet hierarchy and project-wide net names.
    let hier = null;
    try {const h = H(); if (h) hier = options.cache ? h.compileCached(project, {defs, scope:cfg.scope}) : h.compile(project, {defs, scope:cfg.scope});}
    catch (error) {messages.push({class:"Warning", source:"Compiler", check:"hierarchy", text:"Hierarchy could not be compiled: " + error.message, document:"", time:now});}
    for (const issue of hier?.issues || []) {
      const check = {missingSheet:"missingSheet", cycle:"hierarchyLoop", unmatchedEntry:"unmatchedEntries", unmatchedPort:"unmatchedEntries"}[issue.kind];
      const port = issue.kind === "unmatchedPort" ? issue.doc.items.find(i => (i.kind === "port" || i.kind === "netlabel" && i.schPaint?.type === "port") && i.text === issue.port) : null;
      if (check) report(check, issue.doc, issue.text, issue.item || port, undefined, {sig:issue.kind + ":" + (issue.entry?.name ?? issue.port ?? issue.item?.sheet ?? "")});
    }

    yield "hierarchy";
    // Buses: names on one drawn bus, and a bus sheet entry and its child port, agree in width.
    const S = SO(), busBase = n => String(n || "").trim().replace(/[[{].*$/, "");
    if (S?.busNetworks) for (const doc of sheets) {
      for (const net of S.busNetworks(doc)) {
        const names = [...new Map(net.names.filter(n => !S.repeatEntry(n.name)).map(n => [n.name, n])).values()];
        if (new Set(names.map(n => S.busWidth(n.name))).size < 2) continue;
        const at = names[1].entry ? S.entryPoint(names[1].item, names[1].entry) : undefined;
        report("busWidth", doc, "Bus widths differ on one bus: " + list(names.map(n => n.name + " (" + S.busWidth(n.name) + ")"), 6), names[1].item, at, {sig:"bus:" + names.map(n => n.name).sort().join(",")});
      }
      for (const sym of doc.items.filter(i => i.kind === "sheetsymbol")) {
        const child = sheets.find(d => d.id === sym.sheet);
        if (!child || child === doc) continue;
        const ports = child.items.filter(i => (i.kind === "port" || i.kind === "netlabel" && i.schPaint?.type === "port") && S.isBus(i.text));
        for (const e of sym.entries || []) {
          if (!S.isBus(e.name) || ports.some(p => p.text.trim() === e.name.trim())) continue;
          const port = ports.find(p => busBase(p.text) === busBase(e.name) && S.busWidth(p.text) !== S.busWidth(e.name));
          if (port) report("busWidth", doc, "Sheet entry " + e.name + " on " + (sym.name || "sheet symbol") + " is " + S.busWidth(e.name) + " wide; port " + port.text.trim() + " on " + child.name + " is " + S.busWidth(port.text), sym, S.entryPoint(sym, e), {sig:"entry:" + e.name});
        }
      }
    }

    yield "buses";
    // Per-sheet physical checks. Live checking (options.cache) keeps a sheet's findings while the sheet,
    // the library and the settings are unchanged; the project nets are built from the hierarchy.
    const projectNets = new Map(), namedOn = new Map();
    const floatingInputsOn = CLASS[cfg.checks.floatingInputs];
    const reusableScopes=!scoped || ![...scoped.dependencies || []].some(k=>k.startsWith("geometry:") || k.startsWith("rule:") || k==="field:length");
    const cfgSig = options.cache ? JSON.stringify(cfg) + (scoped ? "|" + scoped.sig : "") : "", scope0 = scopeOf(project, cfg), effective0 = hier?.effective || (scope0 === "automatic" ? "global" : scope0);
    for (const g of graphs) {
      const doc = g.doc, e = options.entries.get(doc);
      if (reusableScopes && e?.phys && e.physSig === cfgSig) reuse(e.phys);
      else {
      const start = messages.length;
      for (const c of g.contacts) {
        if (c.pin.hidden || c.pin.noConnect || g.noErc.has(c.key) || quiet(c.i)) continue;
        const net = g.netOf(c.key);
        if (net?.name || g.entryGroups.has(g.physicalOf(c.key))) continue;
        if (pinType(c.pin) === IN && floatingInputsOn) report("floatingInputs", doc, "Floating input pin " + pinText(c), c.i, c.pin.at, {sig:"pin:" + c.pin.number});
        else report("unconnectedPins", doc, "Unconnected pin " + pinText(c), c.i, c.pin.at, {sig:"pin:" + c.pin.number});
      }
      for (const l of g.labels) {
        const attached = g.physicalContent(g.physicalOf(l.key));
        if (attached.pins || attached.wires || g.noErc.has(l.key) || g.entryGroups.has(g.physicalOf(l.key))) continue;
        // Ports usually meet sheet entries or harnesses, which are not modelled.
        if (l.type === "power") report("floatingPower", doc, "Floating power object " + l.item.text, l.item);
        else if (l.type === "label") report("floatingLabels", doc, "Floating net label " + l.item.text, l.item);
      }
      for (const [w, , keys] of g.wires) {
        // A free end on a wire that carries a net label is a labelled stub, a
        // common Altium drawing style, and is not reported.
        if (g.physicalContent(g.physicalOf(keys[0])).labels) continue;
        for (const end of [0, keys.length - 1]) {
          const k = keys[end];
          const attached = g.pinsAt.get(k) || g.labelsAt.get(k) || g.junctions.get(k) || g.noErc.has(k) || g.entryNodes.has(k) || g.busEnds.has(k) ||
            (g.vertexAt.get(k) || 0) > 1 || [...(g.touches.get(k) || [])].some(id => id !== w.id);
          if (!attached) {const net = g.netOf(k); report("danglingWires", doc, "Unconnected wire end" + (net?.names.size || net?.pins.length ? " on net " + net.name : ""), w, g.point(k), {sig:"end:" + (end ? 1 : 0), ...(net?.names.size ? {net:net.name} : {})});}
        }
      }
      for (const net of g.nets) if (net.names.size > 1) {
        const second = net.sources.find(s => s.name !== net.name);
        report("multipleNames", doc, "Net has multiple names: " + list([...net.names], 6), second?.item || net.sources[0]?.item, undefined, {sig:"names:" + [...net.names].sort().join(","), net:net.name});
      }
      if (e) options.entries.set(doc, {...e, phys:messages.slice(start), physSig:cfgSig});
      }
      // With the project compiler the project nets come from it (below); without it, from the sheets.
      if (hier && effective0 !== "flat" && effective0 !== "hierarchical") { yield "sheet"; continue; }
      for (const net of g.nets) {
        // The project compiler (hierarchy.js) names nets across sheets and the hierarchy
        // under the net identifier scope. Without it, names join nets across sheets.
        const first = net.pins[0], projectName = hier && first ? hier.byDoc.get(doc.id)?.byPin.get(first.i.id + "/" + first.pin.number) : "";
        const key = projectName ? "h:" + projectName : net.names.size ? "name:" + net.name : "sheet:" + doc.id + ":" + net.name;
        if (!projectNets.has(key)) projectNets.set(key, {name:projectName || net.name, pins:[], connectors:[], global:false});
        const pn = projectNets.get(key);
        for (const c of net.pins) pn.pins.push({...c, doc, noErc:g.noErc.has(c.key)});
        if (!hier && g.directions.size) for (const {item} of net.sources) addDirection(pn, g, item, doc.id);
        if (net.sources.some(s => labelType(s.item) !== "label") || net.pins.some(c => g.entryGroups.has(g.physicalOf(c.key)))) pn.global = true;
        if (net.names.size) {
          if (!namedOn.has(net.name)) namedOn.set(net.name, []);
          namedOn.get(net.name).push({doc, net, global:net.sources.some(s => s.name === net.name && labelType(s.item) !== "label")});
        }
      }
      yield "sheet";
    }
    // With the project compiler, project nets come from it: every sheet instance (each
    // channel of a repeated sheet) contributes its pins under the hierarchy's net names.
    function addDirection(net, graph, item, instance) {
      const c = graph.directions.get(item.id);
      if (c) net.connectors.push({...c, instance, noErc:graph.noErc.has(c.key)});
    }
    if (hier) {
      // Each sheet's pins by part and pin number (kept with its graph).
      const contactsOf = new Map(), directedSheets = new Map();
      for (const g of graphs) {
        if (g.directions.size) directedSheets.set(g.doc.id, g);
        if (!g.contactOf) {g.contactOf = new Map(); for (const c of g.contacts) g.contactOf.set(c.i.id + "/" + c.pin.number, {c, noErc:g.noErc.has(c.key)});}
        contactsOf.set(g.doc.id, g.contactOf);
      }
      projectNets.clear();
      for (const n of hier.nets) {
        const pins = [];
        for (const x of n.pins) {
          const found = contactsOf.get(x.doc.id)?.get(x.part.id + "/" + x.pin.number);
          if (found) pins.push({...found.c, i:x.ref === found.c.i.ref ? found.c.i : {...found.c.i, ref:x.ref}, doc:x.doc, noErc:found.noErc});
        }
        const net = {name:n.name, pins, connectors:[], global:n.global, hier:n};
        if (directedSheets.size) for (const {inst, net:local} of n.local) {
          const g = directedSheets.get(inst.doc.id);
          if (g) for (const {item} of local.sources) addDirection(net, g, item, inst.id);
        }
        projectNets.set(n.key, net);
      }
      if (directedSheets.size) for (const link of hier.busLinks || []) {
        const g = directedSheets.get(link.inst.doc.id);
        if (!g?.directions.has(link.item.id)) continue;
        const members = SO().busMembers(link.item.text);
        for (const [i, key] of link.keys.entries()) {
          if (!projectNets.has(key)) projectNets.set(key, {name:members[i] || link.item.text, pins:[], connectors:[], global:true});
          addDirection(projectNets.get(key), g, link.item, link.inst.id);
        }
      }
    }
    const scope = scopeOf(project, cfg), effective = hier?.effective || (scope === "automatic" ? "global" : scope);
    for (const [name, entries] of effective === "flat" || effective === "hierarchical" ? namedOn : []) {
      const docs = new Set(entries.map(e => e.doc));
      if (docs.size < 2) continue;
      for (const e of entries) {
        if (e.global) continue;
        const others = [...docs].filter(d => d !== e.doc).map(d => d.name);
        const label = e.net.sources.find(s => s.name === name)?.item;
        report("duplicateNets", e.doc, "Duplicate net " + name + ": also on " + list(others) + ". With " + effective + " net scope, net labels are local to a sheet; use a port or power port to connect sheets", label, undefined, {sig:"net:" + name, net:name});
      }
    }
    // Live checking keeps each project net's findings while its pins, name and the settings are unchanged.
    const netCache = reusableScopes && options.cache ? (options.cache.get(project) || {}) : null, nextNets = netCache ? new Map() : null, byHier = netCache ? new Map() : null;
    const netStamp = netCache ? cfgSig + "|" + (options.stamp ?? "") : "";
    const sameStamp = !!netCache && netCache.stamp === netStamp;
    for (const net of projectNets.values()) {
      let sig = null;
      const changed = c => rebuilt.has(c.doc.id);
      const changedSheet = netCache && (net.pins.some(changed) || net.connectors.some(changed));
      // A net of a kept compile whose pins are all on sheets unchanged since the last run: its findings stand.
      if (sameStamp && net.hier && netCache.byHier?.has(net.hier) && !changedSheet) {
        const kept = netCache.byHier.get(net.hier);
        reuse(kept.msgs);
        byHier.set(net.hier, kept); nextNets.set(kept.sig, kept.msgs);
        continue;
      }
      if (netCache) {
        // A kept project compile keeps its nets: their pin list is signed once (No ERC markers apart).
        let base = net.hier ? netSigs.get(net.hier) : null;
        if (base == null) { base = net.name + "|" + (net.global ? 1 : 0) + "|" + net.pins.map(c => c.doc.id + ":" + c.i.id + ":" + c.i.ref + ":" + c.pin.number).join(","); if (net.hier) netSigs.set(net.hier, base); }
        // No ERC markers and the pins' places (a finding is reported at its pin) change without a new compile.
        let flags = ""; for (const c of net.pins) flags += (c.noErc ? "1" : "0") + c.pin.at[0] + "," + c.pin.at[1] + ";";
        for (const c of net.connectors) flags += JSON.stringify([c.instance, c.i.id, c.i.text, c.pin.electrical, c.pin.at, c.noErc]);
        sig = base + "|" + flags;
        const hit = sameStamp && !changedSheet ? netCache.nets?.get(sig) : null;
        if (hit) { reuse(hit); nextNets.set(sig, hit); if (net.hier) byHier.set(net.hier, {sig, msgs:hit}); continue; }
      }
      const start = messages.length;
      checkNet(net);
      if (nextNets) { const msgs = messages.slice(start); nextNets.set(sig, msgs); if (net.hier) byHier.set(net.hier, {sig, msgs}); }
    }
    function checkNet(net) {
      const pins = net.pins.filter(c => !c.noErc && !quiet(c.i));
      if (pins.length === 1) {const c = pins[0]; report("singlePinNets", c.doc, "Net " + net.name + " contains only one pin " + pinText(c), c.i, c.pin.at, {sig:"pin:" + c.pin.number, net:net.name});}
      // The matrix checks typed interfaces as well as physical pins. A connector
      // remains a net identifier for pin-count, floating-pin and driver checks.
      const typed = new Map();
      const contacts = net.connectors.length ? pins.concat(net.connectors.filter(c => !c.noErc)) : pins;
      for (const c of contacts) {const t = pinType(c.pin); if (t === undefined) continue; if (!typed.has(t)) typed.set(t, []); typed.get(t).push(c);}
      const types = [...typed.keys()].sort((a, b) => a - b);
      for (let x = 0; x < types.length; x++) for (let y = x; y < types.length; y++) {
        const a = types[x], b = types[y], first = contacts[0];
        const subject = (scoped || options.onCheck) ? ruleSubject(first.doc,first.i,net.name,first.i.ref,first.instance,first.pin?.at) : null;
        const mr = scoped?.rule("pinMatrix",first.doc,subject);
        if (a === b && typed.get(a).length < 2) continue;
        const key = pairKey(a,b), selected = mr?.matrix?.[key], mode = selected ?? cfg.matrix[key];
        const fallback = fallbacks?.get("ercPinMatrix");
        const rule = selected !== undefined ? mr : Object.hasOwn(fallback?.matrix || {},key) ? fallback : null;
        if (!CLASS[mode]) {options.onCheck?.("pinMatrix",first.doc,subject,rule,null); continue;}
        const involved = a === b ? typed.get(a) : [...typed.get(a), ...typed.get(b)];
        const what = involved.some(c => c.connector) ? " connections" : " pins";
        const text = "Net " + net.name + " contains " + (a === b ? "multiple " + PIN_TYPES[a] : PIN_TYPES[a] + " and " + PIN_TYPES[b]) + what +
          " (" + list(involved.map(c => PIN_TYPES[pinType(c.pin)] + (c.connector ? " off-sheet connector " + c.i.text + " on " + c.doc.name : " pin " + pinText(c)))) + ")";
        const finding = {class:CLASS[mode], source:"Compiler", check:"matrix", text, document:involved[0].doc.name, documentId:involved[0].doc.id,
          sig:"pins:" + a + "," + b + ":" + involved.map(c => c.connector ? c.instance + "/" + c.i.id : c.i.id + "/" + c.pin.number).sort().join(","), net:net.name,
          objectId:involved[0].i.id, point:involved[0].pin.at, time:now};
        messages.push(finding);
        options.onCheck?.("pinMatrix",first.doc,subject,rule,finding);
      }
      if (typed.has(IN) && !net.global) {
        const drives = pins.some(c => {const t = pinType(c.pin); return t === undefined || [IO, OUT, OC, HIZ, OE, PWR].includes(t);});
        if (!drives) {const c = typed.get(IN)[0]; report("noDriver", c.doc, "Net " + net.name + " has no driving source (" + list(typed.get(IN).map(c => "Input pin " + pinText(c))) + ")", c.i, c.pin.at, {sig:"pins:" + typed.get(IN).map(x => x.i.id + "/" + x.pin.number).sort().join(","), net:net.name});}
      }
    }
    yield "nets";
    globalThis.AtriumNetTies?.erc({project, defs, graphs, report});
    const reportedCalculationScopes = new Set();
    if (options.calculationSnapshot) {
      const findings = globalThis.AtriumCalculationChecks?.findings(project, options.calculationSnapshot, now) || [];
      for (const finding of findings) if (finding.detail.scopeDiagnostic) reportedCalculationScopes.add(finding.ruleId);
      reuse(findings);
      yield "calculations";
    }
    // Say when imported sheets lack objects that ERC relies on.
    const omitted = /(\d+) × (No ERC markers|bus connectivity|bus entries|buses|harness [a-z]+|signal harnesses|sheet entries|hierarchical sheet symbols)/g;
    for (const sheet of sheets) {
      const found = [...(sheet.notes || []).join(" ").matchAll(omitted)].map(m => m[1] + " " + m[2]);
      if (found.length) messages.push({class:"Info", source:"Compiler", check:"importNotice", document:sheet.name, documentId:sheet.id, time:now,
        text:"Imported without " + list(found, 6) + ". Related pins and nets may be reported."});
    }
    for (const issue of scoped?.diagnostics || []) if (!reportedCalculationScopes.has(issue.ruleId))
      messages.push({class:"Error",source:"Compiler",check:"ruleScope",ruleId:issue.ruleId,
        ruleName:issue.ruleName,text:issue.message,documentId:issue.documentId,objectId:issue.objectId,detail:issue,time:now});
    const order = new Map(sheets.map((s, n) => [s.id, n]));
    const rank = {Fatal:0, Error:1, Warning:2, Info:3};
    messages.sort((a, b) => (order.get(a.documentId) ?? 1e9) - (order.get(b.documentId) ?? 1e9) || rank[a.class] - rank[b.class] || natural.compare(a.text, b.text));
    const counts = {Fatal:0, Error:0, Warning:0, Info:0};
    for (const m of messages) counts[m.class]++;
    const problems = counts.Fatal + counts.Error + counts.Warning;
    const summary = sheets.length ? "Compiled " + sheets.length + " schematic sheet" + (sheets.length === 1 ? "" : "s") + ": " +
      (problems ? [[counts.Fatal, "fatal error"], [counts.Error, "error"], [counts.Warning, "warning"]].filter(([n]) => n).map(([n, w]) => n + " " + w + (n === 1 ? "" : "s")).join(", ") : "no errors found (0 errors, 0 warnings)") :
      "The project has no schematic sheets to compile";
    messages.push({class:"Info", source:"Compiler", check:"summary", text:summary, document:project.name || "", time:now});
    counts.Info++;
    // Publish one completed generation. A live pass can be stopped at any preceding yield.
    if (netCache && options.entries.size === sheets.length) {
      for (const [doc, entry] of options.entries) options.cache.set(doc, entry);
      options.cache.set(project, {stamp:netStamp, nets:nextNets, byHier});
    }
    return {messages, counts, summary, complete:!scoped?.diagnostics?.length, diagnostics:scoped?.diagnostics || [], scope, effectiveScope:effective, hierarchy:hier, sheets:sheets.length, graphs, settings:cfg, passed:!counts.Fatal && !counts.Error};
  }

  // ---- UI -------------------------------------------------------------------
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, fn, cls) {const b = el("button", text, cls); b.type = "button"; b.onclick = fn; return b;}
  // Compile the project and show the result in the Messages panel.
  function compile(ctx, calculationSnapshot) {
    const project = ctx.currentProject?.() || ctx.project;
    // The settings live in the rule book (project-rules.js, with the rules engine): load it first.
    const L = globalThis.AtriumLazy;
    if (!globalThis.AtriumProjectRules && L?.modules?.().includes("AtriumRules")) return L.need("AtriumRules").then(() => compile(ctx,calculationSnapshot), e => ctx.info?.(e.message));
    if (!globalThis.AtriumDesignQuery && L?.needsRuleQuery?.(project.rules,"schematic"))
      return L.need("AtriumDesignQuery").then(()=>compile(ctx,calculationSnapshot),e=>ctx.info?.(e.message));
    if (calculationSnapshot === undefined && hasCalculations(project)) {
      const host = globalThis.AtriumNavHost, live = host?.project?.() === project ? host : null;
      const revision = live?.revision?.();
      return prepareCalculations(project, {host:live, revision}).then(snapshot => {
        if (!snapshot) throw Error("The calculation engine is unavailable.");
        if ((ctx.currentProject?.() || ctx.project) !== project || live && live.revision() !== revision) return null;
        return compile(ctx, snapshot);
      }).catch(e => { if (e.name !== "AbortError") ctx.info?.(e.message); });
    }
    let result;
    try {result = run(project, {cache:new WeakMap(), calculationSnapshot});}
    catch (error) {ctx.info?.("Compile failed: " + error.message); throw error;}
    ctx.info?.(result.summary);
    // Live checking (checks.js): what Compile reports keeps its configured severity in Problems.
    globalThis.AtriumChecks?.compiled?.(project, result);
    // A clean compile is confirmed with a toast, not only the status bar (PARITY §3.2 #17).
    const bad = result.counts.Fatal + result.counts.Error, warn = result.counts.Warning;
    globalThis.AtriumToast?.show(bad ? "Compile: " + bad + " error" + (bad === 1 ? "" : "s") + ", " + warn + " warning" + (warn === 1 ? "" : "s") : "Compile succeeded · 0 errors, " + warn + " warning" + (warn === 1 ? "" : "s"), {kind:bad ? "warn" : warn ? "info" : "ok"});
    if (globalThis.AtriumMessages) AtriumMessages.show(ctx, {title:"Compile " + (project.name || "project"), group:"Compiler", messages:result.messages,
      rerun:() => compile(ctx), options:() => options(ctx)});
    return result;
  }
  const levelTone = v => v === "No Report" ? "none" : v.toLowerCase();
  function levelSelect(value, label, onchange) {
    const s = el("select", null, "ui-severity-field"); s.dataset.severity = levelTone(value); s.setAttribute("aria-label", label);
    for (const v of LEVELS) s.add(new Option(v, v));
    s.value = value; s.onchange = () => {s.dataset.severity = levelTone(s.value); onchange(s.value);};
    return s;
  }
  // Project Options → Error Reporting and Connection Matrix.
  function options(ctx) {
    const project = ctx.currentProject?.() || ctx.project, L = globalThis.AtriumLazy;
    if (!globalThis.AtriumProjectRules && L?.modules?.().includes("AtriumRules")) return L.need("AtriumRules").then(() => options(ctx), e => ctx.info?.(e.message));
    const work = settings(project), P = globalThis.AtriumProjectRules;
    const authored = project.rules?.list?.filter(r => r.type === P?.CALCULATION) || [];
    const calcRules = A.clone(authored), baseDefaults = {...project.rules?.calculationTolerances}, calcDefaults = {...baseDefaults};
    const d = el("dialog", null, "work-dialog erc-options"); d.setAttribute("aria-label", "Project options");
    d.onclose = () => d.remove(); document.body.append(d);
    const tabs = el("div", null, "ui-tabs erc-tabs"), body = el("div", null, "erc-tab-body"), foot = el("div", null, "work-actions");
    tabs.setAttribute("role", "tablist");
    d.append(el("h2", "Project options · " + (project.name || "Project")), tabs, body, foot);
    const pages = {"Error Reporting":reporting, "Connection Matrix":matrix, "Options":general, "Calculations":calculations};
    let page = "Error Reporting";
    function show(name) {
      page = name;
      for (const t of tabs.children) t.setAttribute("aria-selected", String(t.textContent === name));
      body.replaceChildren(); pages[name]();
    }
    for (const name of Object.keys(pages)) {const t = button(name, () => show(name), "ui-tab"); t.setAttribute("role", "tab"); tabs.append(t);}
    function reporting() {
      const table = el("table", null, "erc-report-table"), head = el("tr");
      head.append(el("th", "Violation type"), el("th", "Report mode"));
      table.append(el("thead")); table.tHead.append(head);
      const tbody = el("tbody"); table.append(tbody);
      let group = "";
      for (const c of CHECKS.filter(c => !c.authored)) {
        if (c.group !== group) {group = c.group; const r = el("tr", null, "erc-group"); const th = el("th", "Violations associated with " + group.toLowerCase()); th.colSpan = 2; r.append(th); tbody.append(r);}
        const r = el("tr"), name = el("td"); name.append(el("span", c.name), el("small", c.help));
        const cell = el("td"); cell.append(levelSelect(work.checks[c.id], c.name, v => {work.checks[c.id] = v;}));
        r.append(name, cell); tbody.append(r);
      }
      body.append(table);
    }
    function matrix() {
      body.append(el("p", "Select a cell to change the report mode when pins of these types share a net. Pins without an electrical type are not checked."));
      const grid = el("table", null, "erc-matrix"), head = el("tr");
      head.append(el("th"));
      for (const t of PIN_TYPES) {const th = el("th"); th.append(el("span", t)); th.scope = "col"; head.append(th);}
      grid.append(el("thead")); grid.tHead.append(head);
      const tbody = el("tbody"); grid.append(tbody);
      for (let a = 0; a < 8; a++) {
        const r = el("tr"), th = el("th", PIN_TYPES[a]); th.scope = "row"; r.append(th);
        for (let b = 0; b < 8; b++) {
          const td = el("td");
          if (b > a) {td.className = "erc-cell-mirror"; r.append(td); continue;}
          const k = pairKey(a, b), value = () => work.matrix[k] || "No Report";
          const cell = button("", () => {
            work.matrix[k] = LEVELS[(LEVELS.indexOf(value()) + 1) % LEVELS.length]; paint();
          }, "ui-severity-cell");
          function paint() {
            const level = value(); cell.dataset.severity = levelTone(level); cell.textContent = level === "No Report" ? "" : level[0];
            cell.title = PIN_TYPES[a] + " / " + PIN_TYPES[b] + ": " + level;
            cell.setAttribute("aria-label", cell.title);
          }
          paint(); td.append(cell); r.append(td);
        }
        tbody.append(r);
      }
      const legend = el("div", null, "erc-legend");
      for (const v of LEVELS) {const s = el("span", v), swatch = el("i", null, "ui-severity-swatch"); swatch.dataset.severity = levelTone(v); s.prepend(swatch); legend.append(s);}
      body.append(grid, legend);
    }
    function general() {
      const select = el("select"); select.setAttribute("aria-label", "Net identifier scope");
      for (const [v, t] of Object.entries(SCOPES)) select.add(new Option(t, v));
      select.value = work.scope; select.onchange = () => {work.scope = select.value;};
      const row = el("label", null, "work-row"); row.append(el("span", "Net identifier scope"), select);
      body.append(row, el("p", "Automatic uses hierarchical scope when sheet symbols have entries, flat scope when the project has ports, and global scope otherwise. Duplicate nets are reported with flat and hierarchical scope. Power ports are always global. Imported harness connections are not modelled."));
    }
    function calculations() {
      const module = globalThis.AtriumCalculationChecks || L?.need("AtriumCalculationChecks");
      Promise.resolve(module).then(C => {
        if (!C || !d.isConnected || page !== "Calculations") return;
        C.render(body, {project, rules:calcRules, defaults:calcDefaults,
          onEdit: target => C.focus(globalThis.AtriumNavHost, target).catch(e => ctx.info?.(e.message))});
      }).catch(e => ctx.info?.(e.message));
    }
    const reset = button("Set to defaults", () => {Object.assign(work, defaults()); show(page);});
    const compileNow = button("OK and compile", () => apply(true));
    function apply(then) {
      const before = JSON.stringify(stored(settings(project))), after = JSON.stringify(stored(work));
      const calcChanged = JSON.stringify([calcRules, calcDefaults]) !== JSON.stringify([authored, baseDefaults]);
      const run = () => {
        if (before !== after) save(project, work);
        if (calcChanged) P.edit(project, b => P.setCalculationOptions(b, calcRules, authored, calcDefaults, baseDefaults));
      };
      if (before !== after || calcChanged) ctx.edit ? ctx.edit(run) : run();
      d.close();
      if (then) compile(ctx);
    }
    reset.classList.add("erc-reset");
    foot.append(reset, button("Cancel", () => d.close()), compileNow, button("OK", () => apply(false), "is-primary"));
    globalThis.AtriumShell?.adoptDialog?.(d, {title:d.firstElementChild, body, actions:foot});
    show(page); d.showModal();
  }
  return {CHECKS, LEVELS, PIN_TYPES, MATRIX, SCOPES, scopeOf, usesBoardScopes, scopedRules, defaults, settings, fromStored, stored, save, graph, run, runAsync, steps, compile,
    options, pinType, loadCalculations, prepareCalculations,
    open:compile};
})();
