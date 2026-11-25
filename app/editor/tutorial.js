"use strict";
// Help › Your First Board: an interactive tutorial that teaches by doing (about 10 minutes).
// Lazy (lazy.js registers it for the "tutorial" action); the start page and the palette run the
// same action. It works in a practice project built for it, never in the user's own project.
//
// Each step names the action with its menu path (read from the live menus) and its keys (from
// the live key map, so it follows rebinding and presets), highlights the control, and completes
// when the editor's state says so (a subscription to project changes, Messages and the status
// bar), not when the user clicks Next. Skip performs the step through the same operations the
// MCP tools use (sch-author.js, eco.js, annotate.js, router.js, autorouter.js, polygon-pour.js,
// rules.js, fab-outputs.js), inside one undo step.
//
//   AtriumTutorial.open(host)                 the coach card (intro, or the running tutorial)
//   AtriumTutorial.create(host, {storage, ui}) -> controller (headless tests drive this)
//     controller.begin({track, resume}) / skip() / evaluate() / restart() / exit() / state()
//   AtriumTutorial.progress(storage)          saved progress {index, total, finished, track} or null
//   AtriumTutorial.STEPS, TRACKS, STRINGS, t(key, vars)
//
// Strings live in one table (STRINGS) and go through t(): AtriumI18n.t when it exists.
globalThis.AtriumTutorial = (() => {
  const A = () => globalThis.Atrium;
  const KEY = "atrium.tutorial.v1";   // start-page.js reads the same key for its Resume link

  // ------------------------------------------------------------------ strings
  const STRINGS = {
    "title": "Your First Board",
    "sandbox.name": "My First Board (tutorial)",
    "intro.lead": "Build a small LED board from an empty schematic to fabrication files, in about 10 minutes. Each step names the command and its keys, and moves on by itself when you have done it.",
    "intro.sandbox": "It works in a practice project, so your own project is not changed. If your project has unsaved edits, Waffle asks before switching; at the end you can go back to it.",
    "intro.track": "Show the differences for",
    "intro.start": "Start",
    "intro.resume": "Resume at step {n}",
    "intro.over": "Start over",
    "intro.later": "Not now",
    "track.standard": "New to PCB design",
    "track.altium": "Coming from Altium?",
    "track.kicad": "Coming from KiCad?",
    "track.altium.lead": "Waffle's default keys follow Altium, and most commands keep their Altium names. The notes point out where Waffle differs.",
    "track.kicad.lead": "The notes give the KiCad name for each step. You can switch to the KiCad-like key map now; the keys in each step follow it.",
    "track.kicad.keys": "Use KiCad-like keys",
    "track.kicad.keysOn": "KiCad-like keys are on. Tools › Customize Keyboard Shortcuts… switches back.",
    "track.altium.keys": "Use Altium keys",
    "card.step": "Step {n} of {total}",
    "card.progress": "Tutorial progress",
    "card.how": "Use",
    "card.or": "or",
    "card.skip": "Skip: do it for me",
    "card.skipping": "Working…",
    "card.restart": "Restart",
    "card.collapse": "Collapse the tutorial card",
    "card.expand": "Expand the tutorial card",
    "card.exit": "Exit the tutorial",
    "card.switch": "This step happens on the {kind}.",
    "card.switchTo": "Show the {kind}",
    "card.schematic": "schematic",
    "card.pcb": "board",
    "card.skipFailed": "Couldn't do this step for you: {message}",
    "card.done": "Step {n} done: {title}.",
    "card.announce": "Step {n} of {total}: {title}. {body}",
    "paused.title": "Tutorial paused",
    "paused.body": "Another project is open. The tutorial only works in its practice project, so nothing here changes your project.",
    "paused.return": "Back to the tutorial",
    "finish.title": "Your first board is done",
    "finish.body": "You placed parts, wired them, checked the design, laid out and routed the board, poured ground copper and wrote fabrication files.",
    "finish.next": "Next: open the Getting Started guide, or start your own board from the start page.",
    "finish.back": "Back to {name}",
    "finish.close": "Close",
    "exit.confirm": "Tutorial closed. Help › Your First Board Tutorial picks up where you left off.",
    "status.started": "Tutorial started in a practice project",
    "status.kept": "Kept the current project; the tutorial didn't start.",
    "status.returned": "Back to {name}",

    "step.led.title": "Place an LED",
    "step.led.body": "Open the component library, search for “LED” and place one on the schematic. Press {escape} when it is down.",
    "step.led.wait": "Waiting for an LED on the schematic.",
    "step.led.altium": "Same as Altium's Place › Part. Tab edits the part while it floats; Space rotates it.",
    "step.led.kicad": "KiCad's Add Symbol (A). Waffle parts already carry their footprint, so there is no separate footprint assignment.",
    "step.resistor.title": "Place a resistor",
    "step.resistor.body": "Place a resistor to limit the LED's current. Put it to the left of the LED.",
    "step.resistor.wait": "Waiting for a resistor on the schematic.",
    "step.resistor.altium": "Designators increment as you place (R1, R2…), as in Altium with auto-increment on.",
    "step.resistor.kicad": "Placement stays armed after each click, like KiCad's repeat placement; Esc stops it.",
    "step.connector.title": "Place a connector",
    "step.connector.body": "Place a 2-pin header (search “header”). It brings power onto the board.",
    "step.connector.wait": "Waiting for a connector on the schematic.",
    "step.connector.altium": "Connectors are ordinary parts in the library; their designators start with J.",
    "step.connector.kicad": "The same as placing a Conn_01x02 symbol.",
    "step.wire.title": "Wire the resistor to the LED",
    "step.wire.body": "Draw a wire from a resistor pin to the LED's anode (the pin on its left). Click to start, click to end, {escape} to finish.",
    "step.wire.wait": "Waiting for a wire between the resistor and the LED.",
    "step.wire.altium": "Space changes the corner direction and Backspace removes the last vertex, as in Altium.",
    "step.wire.kicad": "KiCad's Draw Wire (W). With the KiCad-like keys, W draws wires here too.",
    "step.power.title": "Add GND and VCC",
    "step.power.body": "Place VCC on the resistor's free pin and on connector pin 1, and GND on the LED's cathode and on connector pin 2. Power ports with the same name are connected.",
    "step.power.wait": "Waiting for VCC and GND nets with at least two pins each.",
    "step.power.altium": "Power ports work as in Altium; Tab names any other net while one floats.",
    "step.power.kicad": "KiCad's power symbols (P). A power port is a global net name, like a KiCad power symbol.",
    "step.annotate.title": "Annotate",
    "step.annotate.body": "Annotate numbers the designators in order. Open it, look at the proposed order and choose Update Changes List, then Accept Changes (Create ECO).",
    "step.annotate.wait": "Waiting for Annotate (every designator numbered, none repeated).",
    "step.annotate.altium": "Waffle numbers parts as you place them; Annotate re-orders them by position, like Altium's.",
    "step.annotate.kicad": "KiCad's Annotate Schematic.",
    "step.erc.title": "Run the electrical rules check",
    "step.erc.body": "Validate Project runs the ERC. The results go to the Messages panel; click a row to find the object.",
    "step.erc.wait": "Waiting for an ERC run with no errors.",
    "step.erc.errors": "The last ERC run found {count} error(s). Click each in Messages to find it, fix it, and run the check again.",
    "step.erc.altium": "Altium calls this Compile PCB Project. Project › Project Options – Error Reporting sets the severities.",
    "step.erc.kicad": "KiCad's Electrical Rules Checker. Results appear in the docked Messages panel instead of a dialog.",
    "step.eco.title": "Update the PCB",
    "step.eco.body": "Update PCB Document sends the parts and nets to the board. Review the list of changes and choose Execute Changes; Waffle then shows the board.",
    "step.eco.wait": "Waiting for every schematic part to be on the board.",
    "step.eco.altium": "The same Engineering Change Order (ECO) dialog as Altium's Design › Update PCB Document.",
    "step.eco.kicad": "KiCad's Update PCB from Schematic (F8). The list of changes is called an Engineering Change Order (ECO).",
    "step.shape.title": "Give the board a shape",
    "step.shape.body": "The Board Wizard draws an outline. A rectangle about 30 × 20 mm is plenty for three parts.",
    "step.shape.wait": "Waiting for a board outline.",
    "step.shape.altium": "Board Shape works as in Altium: draw lines and use Define from Selected Objects, or let the wizard draw it.",
    "step.shape.kicad": "KiCad draws the outline on Edge.Cuts. Here the board shape is its own object, and the wizard draws it for you.",
    "step.place.title": "Place the parts on the board",
    "step.place.body": "Drag each part inside the outline ({rotate} rotates). Arrange Within Board puts them all inside in one go.",
    "step.place.wait": "Waiting for every part to be inside the board outline.",
    "step.place.altium": "Smart guides snap to neighbours' edges and pad rows; L flips a part to the bottom while you move it.",
    "step.place.kicad": "Like KiCad's Move (M); thin lines (airwires) show the connections still to route.",
    "step.route.title": "Route one net",
    "step.route.body": "Start Interactive Routing, click a pad, then click the pad its airwire leads to. {escape} ends the track.",
    "step.route.wait": "Waiting for a routed track.",
    "step.route.altium": "{routingMode} cycles walkaround, push and hug. {layer} changes layer. Ctrl+click completes the connection.",
    "step.route.kicad": "KiCad's Route Single Track ({kicadRoute}). {routingMode} cycles the router modes, like KiCad's walkaround and shove.",
    "step.autoroute.title": "Auto-route the rest",
    "step.autoroute.body": "Auto Route › All routes the remaining connections. Choose Route in the dialog.",
    "step.autoroute.wait": "Waiting for every connection to be routed ({count} left).",
    "step.autoroute.altium": "Like Altium's Situs: Route › Auto Route › All, with strategies in the dialog.",
    "step.autoroute.kicad": "KiCad has no built-in autorouter; here it is one menu item and leaves your manual tracks alone.",
    "step.pour.title": "Add a GND pour",
    "step.pour.body": "For Polygon Pour, click the corners of the board, press {enter}, check that the net is GND and choose OK.",
    "step.pour.wait": "Waiting for a polygon pour on the GND net.",
    "step.pour.altium": "Same as Altium's Polygon Pour; Tools › Polygon Pours › Repour All refills it.",
    "step.pour.kicad": "A polygon pour is KiCad's filled zone (Add Filled Zone). A new pour connects to GND.",
    "step.drc.title": "Check the board",
    "step.drc.body": "Run Design Rule Check and aim for zero errors. Click a row in Messages to see a violation on the board.",
    "step.drc.wait": "Waiting for a design rule check with no violations.",
    "step.drc.errors": "The last check found {count} violation(s). Click each in Messages, fix it, and run the check again.",
    "step.drc.altium": "Online DRC also marks violations while you edit; passed rules collapse into one row.",
    "step.drc.kicad": "KiCad's Design Rules Checker (DRC).",
    "step.fab.title": "Generate fabrication files",
    "step.fab.body": "Fabrication Outputs writes Gerber, drill, pick-and-place and a readme. Choose Download all (.zip).",
    "step.fab.wait": "Waiting for the fabrication ZIP.",
    "step.fab.altium": "Like an Altium Output Job; File › Release… saves repeatable sets and checks the board before release.",
    "step.fab.kicad": "KiCad's Plot and Generate Drill Files in one step: Gerber X2, Excellon and pick-and-place in one ZIP.",

    // Menu paths used when there are no menus (headless) or a menu item is hidden.
    "menu.library": "Place › Component", "menu.route.schematic": "Place › Wire", "menu.sch-power": "Place › Power Port › GND / VCC",
    "menu.annotate": "Tools › Annotate Schematics…", "menu.compile": "Project › Validate Project (ERC)", "menu.eco": "Design › Update PCB Document…",
    "menu.board-wizard": "Design › Board Shape › Board Wizard…", "menu.arrange-board": "Tools › Component Placement › Arrange Within Board",
    "menu.route.pcb": "Route › Interactive Routing", "menu.autoroute-all": "Route › Auto Route › All…", "menu.polygon-pour": "Place › Polygon Pour",
    "menu.drc": "Tools › Run Design Rule Check", "menu.fab": "File › Fabrication Outputs…"
  };
  function t(key, vars) {
    const I = globalThis.AtriumI18n;
    let s = null;
    try { if (I?.t) { const r = I.t("tutorial." + key, vars); if (r && r !== "tutorial." + key) s = r; } } catch {}
    if (s == null) s = STRINGS[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => vars[k] != null ? String(vars[k]) : m) : s;
  }

  // ------------------------------------------------------------------ the practice board
  // Facts about the practice project, computed on demand (each getter once per evaluation).
  const up = s => String(s || "").toUpperCase();
  const isLed = d => !!d && /\bLED\b/i.test((d.id || "") + " " + (d.name || "").replace(/-/g, " ")) || /led/i.test(d?.id || "");
  const isRes = d => !!d && (up(d.prefix) === "R" || /resistor/i.test(d.name || "")) && !isLed(d);
  const isConn = d => !!d && (/^(J|P|CN|X)$/.test(up(d.prefix)) || /connector|header/i.test((d.category || "") + " " + (d.name || ""))) && !isLed(d);
  function inside(pt, poly) {
    let inn = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inn = !inn;
    }
    return inn;
  }
  function facts(project, ids) {
    const memo = {}, once = (k, f) => k in memo ? memo[k] : (memo[k] = f());
    const docs = project?.documents || [];
    const f = {
      get sch() { return once("sch", () => docs.find(d => d.id === ids?.sch) || null); },
      get pcb() { return once("pcb", () => docs.find(d => d.id === ids?.pcb) || null); },
      get defs() { return once("defs", () => new Map((project?.library || []).map(d => [d.id, d]))); },
      get parts() { return once("parts", () => (f.sch?.items || []).filter(i => i.kind === "part")); },
      partOf(test) { return f.parts.find(i => test(f.defs.get(i.def))) || null; },
      get led() { return once("led", () => f.partOf(isLed)); },
      get res() { return once("res", () => f.partOf(isRes)); },
      get conn() { return once("conn", () => f.partOf(isConn)); },
      get nets() { return once("nets", () => f.sch ? A().connectivity(f.sch, f.defs).byPin : new Map()); },
      netsOf(part) { const out = new Set(); if (part) for (const [k, n] of f.nets) if (k.startsWith(part.id + "/")) out.add(n); return out; },
      get wired() { return once("wired", () => { const a = f.netsOf(f.res); return [...f.netsOf(f.led)].some(n => a.has(n)); }); },
      get pinsPerNet() { return once("ppn", () => { const m = new Map(); for (const n of f.nets.values()) m.set(n, (m.get(n) || 0) + 1); return m; }); },
      get powered() { return once("powered", () => {
        const names = new Set((f.sch?.items || []).filter(i => i.kind === "power").map(i => up(i.text)));
        const ok = n => (f.pinsPerNet.get(n) || 0) >= 2;
        return names.has("GND") && ok("GND") && [...names].some(n => n !== "GND" && !/GND|EARTH/.test(n) && ok(n));
      }); },
      get annotated() { return once("annotated", () => { const refs = f.parts.map(i => up(i.ref)); return refs.length > 0 && refs.every(r => /^[A-Z_]+\d+$/.test(r)) && new Set(refs).size === refs.length; }); },
      get boardParts() { return once("bparts", () => (f.pcb?.items || []).filter(i => i.kind === "part")); },
      get synced() { return once("synced", () => { const links = new Set(f.boardParts.map(i => i.link)); const want = f.parts.filter(i => f.defs.get(i.def)?.footprint); return want.length > 0 && want.every(i => links.has(i.link)); }); },
      get outline() { return once("outline", () => Array.isArray(f.pcb?.outline) && f.pcb.outline.length >= 3 ? f.pcb.outline : null); },
      get placed() { return once("placed", () => !!f.outline && f.boardParts.length > 0 && f.boardParts.every(i => {
        const pads = A().pins(i, f.defs.get(i.def), "pcb");
        return (pads.length ? pads.map(p => p.at) : [[i.x, i.y]]).every(p => inside(p, f.outline));
      })); },
      get tracks() { return once("tracks", () => (f.pcb?.items || []).filter(i => i.kind === "track" && i.net).length); },
      get unrouted() { return once("unrouted", () => {
        if (!f.pcb || !globalThis.AtriumConnectivity) return null;
        try { return AtriumConnectivity.inspect(f.pcb, f.defs).airwires.length; } catch { return null; }
      }); },
      get pour() { return once("pour", () => (f.pcb?.items || []).some(i => i.kind === "polygon" && up(i.net) === "GND")); }
    };
    return f;
  }

  // Where the skip actions put things (mm). The schematic block sits near the sheet's centre.
  function sheetCentre(doc) {
    try { const s = A().sheet?.(doc); if (s && s.width) return [Math.round(s.width / 2 / 2.54) * 2.54, Math.round(s.height / 2 / 2.54) * 2.54]; } catch {}
    return [127, 88.9];
  }
  // [skip spot: dx, dy from the centre]
  const SPOT = {conn: [-35.56, 0], res: [-12.7, -10.16], led: [10.16, -10.16]};

  const tutorialPart = (project, template) => project.library.find(def => def.catalogueId === template)?.id || template;

  // ------------------------------------------------------------------ steps
  // kind: the document the step happens on; action: the command it teaches; menu: a menu item
  // selector (default [data-action=action]); targets: extra controls to highlight.
  // done(f, c): completion from the project facts f and the controller c (ran flags, start state).
  const STEPS = [
    {id: "led", kind: "schematic", action: "library", done: f => !!f.led,
      skip: (c, f) => c.editSch(p => c.author().placePart(p, {sheet: f.sch.id, def: ledDef(p), ...c.spot(f, "led"), rotation: 0}))},
    {id: "resistor", kind: "schematic", action: "library", done: f => !!f.res,
      skip: (c, f) => c.editSch(p => c.author().placePart(p, {sheet: f.sch.id, def: tutorialPart(p, "std-r"), ...c.spot(f, "res"), value: "330 Ω"}))},
    {id: "connector", kind: "schematic", action: "library", done: f => !!f.conn,
      skip: (c, f) => c.editSch(p => c.author().placePart(p, {sheet: f.sch.id, def: tutorialPart(p, "std-j2"), ...c.spot(f, "conn"), value: "Power"}))},
    {id: "wire", kind: "schematic", action: "route", done: f => f.wired,
      skip: (c, f) => { need(f.res && f.led, "Place the resistor and the LED first.");
        c.editSch(p => c.author().addWire(p, {sheet: f.sch.id, from: {designator: f.res.ref, pin: "2"}, to: {designator: f.led.ref, pin: anode(f)}})); }},
    {id: "power", kind: "schematic", action: "sch-power", menu: '[data-action="sch-power"][data-power-net="GND"]', done: f => f.powered,
      skip: (c, f) => { need(f.res && f.led && f.conn, "Place the three parts first.");
        const nets = f.nets, has = (part, pin, net) => nets.get(part.id + "/" + pin) === net;
        const want = [[f.res, otherPin(f, f.res), "VCC"], [f.conn, "1", "VCC"], [f.led, cathode(f), "GND"], [f.conn, "2", "GND"]].filter(([part, pin, net]) => !has(part, pin, net));
        c.editSch(p => { for (const [part, pin, net] of want) c.author().addPowerPort(p, {sheet: f.sch.id, net, at: {designator: part.ref, pin}}); }); }},
    {id: "annotate", kind: "schematic", action: "annotate", done: (f, c) => f.annotated && (c.ran.annotate || c.seen.annotate || c.entry.annotated === false),
      skip: async c => { const AN = await c.need("AtriumAnnotate"); c.edit(p => { const plan = AN.plan(p, {}); if (plan.changes.length) AN.apply(p, plan, {boards: "*"}); }); c.ran.annotate = true; }},
    {id: "erc", kind: "schematic", action: "compile", done: (f, c) => c.ran.erc?.errors === 0,
      wait: (f, c) => c.ran.erc?.errors ? t("step.erc.errors", {count: c.ran.erc.errors}) : null,
      skip: async c => { const E = await c.need("AtriumERC"); const r = await E.runAsync(c.host.project());
        c.ran.erc = {errors: (r.counts?.Error || 0) + (r.counts?.Fatal || 0), at: Date.now()}; c.show("compile"); }},
    {id: "eco", kind: "schematic", action: "eco", done: f => f.synced,
      skip: async (c, f) => { const E = await c.need("AtriumECO");
        c.edit(p => { const plan = E.plan(p, {board: f.pcb.id, scope: "*", direction: "pcb"}); const r = E.execute(p, plan, null); if (r.failed) throw Error(r.error || r.failed + " changes failed"); });
        c.view(f.pcb.id, "fit-document"); }},
    {id: "shape", kind: "pcb", action: "board-wizard", done: f => !!f.outline,
      skip: (c, f) => { c.edit(p => c.author().setBoardOutline(p, {board: f.pcb.id, rect: [0, 0, 30, 20]})); c.view(f.pcb.id, "fit-document"); }},
    {id: "place", kind: "pcb", action: "arrange-board", done: f => f.placed,
      skip: (c, f) => { need(f.outline, "Give the board a shape first.");
        const [x0, y0, x1, y1] = A().bounds(f.outline), w = x1 - x0, h = y1 - y0, cy = y0 + h / 2, ref = d => f.boardParts.find(i => i.link === d?.link);
        const slots = [[ref(f.conn), x0 + w * .18, cy, 0], [ref(f.res), x0 + w * .48, cy - h * .2, 0], [ref(f.led), x0 + w * .78, cy - h * .2, 180]];
        let k = 0; for (const i of f.boardParts) if (!slots.some(s => s[0] === i)) slots.push([i, x0 + w * (.3 + .15 * k), y0 + h * .78, 0]), k++;
        c.edit(p => { for (const [i, x, y, rotation] of slots) if (i) c.author().moveComponent(p, {board: f.pcb.id, component: i.id, x, y, rotation}); });
        c.view(f.pcb.id, "fit-document"); }},
    {id: "route", kind: "pcb", action: "route", menu: '[data-action="route"][data-scope="pcb"][data-hint], [data-action="route"][data-scope="pcb"]', done: f => f.tracks > 0,
      skip: async (c, f) => { const R = await c.need("AtriumRouter"), [from, to] = firstConnection(f) || need(null, "Update the PCB and place the parts first.");
        c.edit(() => { const r = R.route(f.pcb, f.defs, {from: from.at, to: to.at, net: from.net, layer: "Top", budgetMs: 2000}); if (!r.ok) throw Error("No route was found (" + (r.status || "blocked") + ")."); R.apply(f.pcb, r.plan); }); }},
    {id: "autoroute", kind: "pcb", action: "autoroute-all", done: f => f.synced && f.unrouted === 0,
      wait: f => f.unrouted ? t("step.autoroute.wait", {count: f.unrouted}) : null,
      skip: async (c, f) => { const AR = await c.need("AtriumAutorouter"), st = AR.STRATEGIES.find(s => s.id === "default2") || AR.STRATEGIES[0];
        c.edit(p => { const plan = AR.routeBoard(f.pcb, f.defs, {project: p, scope: {}, fanout: false, router: {...st.router, timeLimit: 20000}});
          globalThis.AtriumRouter?.apply ? AtriumRouter.apply(f.pcb, plan) : (f.pcb.items.push(...(plan.add || []))); }); }},
    {id: "pour", kind: "pcb", action: "polygon-pour", done: f => f.pour,
      skip: async (c, f) => { const PP = await c.need("AtriumPolygonPour"); need(f.outline, "Give the board a shape first.");
        c.edit(() => { f.pcb.items.push(PP.make(f.outline.map(q => [...q]), {net: "GND", layer: "Top", name: "GND pour"})); PP.apply(f.pcb, f.defs, {}); }); }},
    {id: "drc", kind: "pcb", action: "drc", done: (f, c) => c.ran.drc?.errors === 0,
      wait: (f, c) => c.ran.drc?.errors ? t("step.drc.errors", {count: c.ran.drc.errors}) : null,
      skip: async (c, f) => { const R = await c.need("AtriumRules"), defs = f.defs, p = c.host.project();
        if (globalThis.AtriumLazy && !globalThis.AtriumDRC) await c.need("AtriumDRC").catch(() => null);
        // As run_drc does: the DRC module's headless entry when it is loaded, else the rule engine.
        const rules = R.stored(f.pcb, p) || R.defaults(), D = globalThis.AtriumDRC, go = D?.headless || D?.run;
        const opts = {connections: () => globalThis.AtriumConnectivity?.inspect(f.pcb, defs), project: p};
        const res = typeof go === "function" ? go(f.pcb, defs, rules, opts) : R.drc(f.pcb, defs, rules, opts);
        c.ran.drc = {errors: res.total, at: Date.now()}; c.show("drc"); }},
    {id: "fab", kind: "pcb", action: "fab", done: (f, c) => !!c.ran.fab,
      skip: async (c, f, o) => { const F = await c.need("AtriumFabOutputs"), p = c.host.project();
        const result = F.build(p, f.pcb.id, {fileStem: F.defaultStem ? F.defaultStem(p, f.pcb) : f.pcb.name});
        if (!result.files.length) throw Error("No files were generated.");
        if (!o?.replay) { const saved = await c.host.exportFile?.(result.name, F.zip(result)); if (saved === false) return; c.host.info?.("Exported " + result.name + " (" + result.files.length + " files)"); }
        c.ran.fab = {files: result.files.length, name: result.name}; }}
  ];
  const TRACKS = ["standard", "altium", "kicad"];
  function need(v, m) { if (!v) throw Error(m); return v; }
  function ledDef(p) { return (p.library.find(d => d.id === "starter-led-0603") || p.library.find(isLed) || need(null, "The library has no LED.")).id; }
  const pinByName = (f, part, re, fallback) => { const def = f.defs.get(part.def), hit = (def?.symbol?.pins || []).find(x => re.test(x.name || "")); return hit ? String(hit.number) : fallback; };
  const anode = f => pinByName(f, f.led, /^A$|anode/i, "2"), cathode = f => pinByName(f, f.led, /^K$|cathode/i, "1");
  // The resistor pin that is not wired to the LED.
  function otherPin(f, part) { const led = f.netsOf(f.led); return led.has(f.nets.get(part.id + "/2")) ? "1" : led.has(f.nets.get(part.id + "/1")) ? "2" : "1"; }
  // The first board connection (two pads on one net), for the interactive-route skip.
  function firstConnection(f) {
    if (!f.pcb) return null;
    const pads = [];
    for (const i of f.boardParts) for (const pad of A().pins(i, f.defs.get(i.def), "pcb")) { const net = i.pinNets?.[pad.number]; if (net && up(net) !== "GND") pads.push({at: pad.at, net, part: i}); }
    for (const a of pads) { const b = pads.find(x => x.net === a.net && x.part !== a.part); if (b) return [a, b]; }
    return null;
  }

  // ------------------------------------------------------------------ storage
  function store(s) { try { return s === undefined ? globalThis.localStorage || null : s; } catch { return null; } }
  function load(s) { try { const v = JSON.parse(store(s)?.getItem(KEY) || "null"); return v && typeof v === "object" && v.v === 1 ? v : null; } catch { return null; } }
  function save(s, v) { try { store(s)?.setItem(KEY, JSON.stringify(v)); } catch {} }
  function progress(s) { const v = load(s); return v ? {index: Math.min(v.index | 0, STEPS.length), total: STEPS.length, finished: !!v.finished, track: v.track || "standard"} : null; }

  // ------------------------------------------------------------------ controller
  function create(host, o = {}) {
    const storage = o.storage, listeners = new Set();
    const c = {host, ran: {}, seen: {}, entry: {}, ids: null, index: 0, track: "standard", status: "intro", error: "", busy: false,
      done: new Set(), skipped: new Set(), last: null, returnTo: null};
    const emit = ev => { for (const fn of listeners) try { fn(ev, c); } catch (e) { globalThis.console?.error?.(e); } };
    c.on = fn => { listeners.add(fn); return () => listeners.delete(fn); };
    c.author = () => globalThis.AtriumSchAuthor || need(null, "Design authoring (sch-author.js) is not loaded.");
    c.need = names => { const L = globalThis.AtriumLazy, list = [].concat(names);
      if (list.every(n => globalThis[n] != null)) return Promise.resolve(Array.isArray(names) ? list.map(n => globalThis[n]) : globalThis[names]);
      if (!L) return Promise.reject(Error(list.find(n => globalThis[n] == null) + " is not loaded."));
      return L.need(names); };
    c.edit = fn => host.edit(() => fn(host.project()));
    c.editSch = fn => { if (c.ids && host.currentId?.() !== c.ids.sch) host.selectDocument?.(c.ids.sch); c.edit(fn); };
    c.spot = (f, k) => { const [cx, cy] = sheetCentre(f.sch), [dx, dy] = SPOT[k]; return {x: cx + dx, y: cy + dy}; };
    c.view = (id, a) => { try { if (host.currentId?.() !== id) host.selectDocument?.(id); if (a) host.act?.(a); } catch {} };
    // Read-only checks also run the real command in the editor, so Messages shows the result.
    c.show = a => { if (o.ui !== false) try { host.act?.(a); } catch {} };
    c.facts = () => facts(host.project(), c.ids);
    c.step = () => STEPS[c.index] || null;
    c.state = () => ({status: c.status, index: c.index, total: STEPS.length, step: c.step()?.id || null, track: c.track, done: [...c.done], skipped: [...c.skipped], error: c.error});
    const persist = () => save(storage, {v: 1, index: c.index, track: c.track, done: [...c.done], skipped: [...c.skipped], finished: c.status === "finished", at: Date.now()});
    const inSandbox = () => { const p = host.project(); return !!c.ids && !!p?.documents?.some(d => d.id === c.ids.sch) && !!p.documents.some(d => d.id === c.ids.pcb); };
    function enter(i) {
      c.index = i; c.error = ""; c.seen = {}; c.stepStart = Date.now();
      const f = c.facts(); c.entry = {annotated: STEPS[i]?.id === "annotate" ? f.annotated : undefined};
      if (i >= STEPS.length) c.status = "finished";
      persist();
    }
    // Completion: the current step is done when the state says so; later steps that are
    // already satisfied complete in turn (work done out of order counts).
    function evaluate() {
      if (c.status === "intro" || c.status === "finished" || c.status === "closed") return c.state();
      if (!inSandbox()) { if (c.status !== "paused") { c.status = "paused"; emit("paused"); } return c.state(); }
      if (c.status === "paused") { c.status = "running"; emit("resumed"); }
      c.last = JSON.parse(JSON.stringify(host.project()));
      let moved = 0;
      while (c.status === "running" && c.step()) {
        const s = c.step(), f = c.facts();
        let ok = false; try { ok = !!s.done(f, c); } catch { ok = false; }
        if (!ok) break;
        c.done.add(s.id); moved++;
        emit({type: "done", step: s, index: c.index});
        enter(c.index + 1);
      }
      if (moved) emit(c.status === "finished" ? "finished" : "step");
      return c.state();
    }
    c.evaluate = evaluate;
    c.waitText = () => { const s = c.step(); if (!s) return ""; const f = c.facts(); try { return s.wait?.(f, c) || t("step." + s.id + ".wait"); } catch { return t("step." + s.id + ".wait"); } };
    async function build() {
      const T = await c.need("AtriumTemplates"), P = globalThis.AtriumPrefs;
      return T.build("blank", {name: t("sandbox.name"), starter: true, prefs: P?.changed?.() || {}});
    }
    // Start (or resume) in a fresh practice project. resume: replay the skip actions of the
    // steps already done, so the board is where the user left it.
    c.begin = async (opts = {}) => {
      const saved = load(storage);
      c.track = TRACKS.includes(opts.track) ? opts.track : saved?.track || c.track;
      const project = await build();
      const sch = project.documents.find(d => d.kind === "schematic"), pcb = project.documents.find(d => d.kind === "pcb");
      if (!host.isStarter?.() && host.project?.() && !inSandbox()) c.returnTo = {project: JSON.parse(JSON.stringify(host.project())), dirty: !!host.isDirty?.(), path: globalThis.AtriumHost?.projectPath || null};
      const ok = await host.replaceProject(project, {copy: true});
      if (ok === false) { c.returnTo = null; host.info?.(t("status.kept")); emit("kept"); return false; }
      c.ids = {sch: sch.id, pcb: pcb.id};
      c.done = new Set(); c.skipped = new Set(); c.ran = {}; c.status = "running";
      host.selectDocument?.(sch.id);
      const upto = opts.resume && saved && !saved.finished ? Math.min(saved.index | 0, STEPS.length - 1) : 0;
      enter(0);
      c.busy = upto > 0;
      try {
        for (let i = 0; i < upto; i++) {
          try { await STEPS[i].skip(c, c.facts(), {replay: true}); } catch { break; }
          if (STEPS[i].id === "annotate") c.ran.annotate = true;
          if (!STEPS[i].done(c.facts(), c)) break;
          c.done.add(STEPS[i].id); if (saved.skipped?.includes(STEPS[i].id)) c.skipped.add(STEPS[i].id);
          enter(i + 1);
        }
      } finally { c.busy = false; }
      if (STEPS[c.index]?.kind === "schematic") host.selectDocument?.(sch.id);
      host.info?.(t("status.started"));
      emit("started"); evaluate(); emit("step");
      return true;
    };
    c.skip = async () => {
      const s = c.step();
      if (!s || c.status !== "running" || c.busy) return false;
      const was = c.index;
      c.busy = true; c.error = ""; c.skipped.add(s.id); emit("busy");
      try { await s.skip(c, c.facts(), {}); }
      catch (e) { c.error = t("card.skipFailed", {message: e.message}); }
      finally { c.busy = false; }
      evaluate();
      if (c.index === was) { if (!c.error && !s.done(c.facts(), c)) c.error = t("card.skipFailed", {message: c.waitText()}); c.skipped.delete(s.id); emit("step"); }
      return c.index !== was;
    };
    c.restart = () => { save(storage, null); try { store(storage)?.removeItem(KEY); } catch {} return c.begin({track: c.track}); };
    // Back to the practice project after another one was opened (asks if that one has edits).
    c.returnToSandbox = async () => { if (!c.last) return false; const ok = await host.replaceProject(JSON.parse(JSON.stringify(c.last)), {copy: true}); if (ok !== false) evaluate(); return ok !== false; };
    // Leave the practice project: reopen the user's project (its file when it was saved and clean).
    c.goBack = async () => {
      const r = c.returnTo; if (!r) return false;
      let ok = false;
      if (r.path && !r.dirty && globalThis.AtriumHost?.openRecent) { try { await AtriumHost.openRecent(r.path); ok = true; } catch {} }
      if (!ok) ok = await host.replaceProject(r.project, {force: true, ...(r.dirty ? {} : {dirty: false})}) !== false;
      if (ok) { c.returnTo = null; host.info?.(t("status.returned", {name: r.project.name})); }
      return ok;
    };
    c.close = () => { if (c.status === "running" || c.status === "paused") persist(); c.status = "closed"; emit("closed"); };
    c.reopen = () => {
      if (c.status === "closed") {
        c.status = c.index >= STEPS.length ? "finished" : c.ids ? "running" : "intro";
        evaluate();
      }
      emit("step");
    };
    c.setTrack = tr => { if (TRACKS.includes(tr)) { c.track = tr; if (c.ids) persist(); emit("step"); } };
    // Subscriptions: project changes and document switches.
    c.subscriptions = [host.on?.("change", () => schedule()), host.on?.("document", () => schedule())].filter(Boolean);
    let queued = false;
    function schedule() {
      if (c.busy || (c.status !== "running" && c.status !== "paused")) return;
      if (o.sync) { evaluate(); return; }
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (c.busy || (c.status !== "running" && c.status !== "paused")) return;
        evaluate(); emit("tick");
      });
    }
    c.schedule = schedule;
    c.dispose = () => { for (const off of c.subscriptions) try { off(); } catch {} listeners.clear(); };
    return c;
  }

  // ------------------------------------------------------------------ coach card (DOM)
  const doc = () => globalThis.document;
  function el(tag, cls, text) { const n = doc().createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(text, fn, cls) {
    const b = el("button", cls, text); b.type = "button"; b.onclick = fn;
    if (!cls || cls === "tut-primary" || cls === "tut-quiet") b.classList.add("ui-button");
    if (cls === "tut-primary") b.dataset.variant = "primary";
    if (cls === "tut-quiet") b.dataset.variant = "quiet";
    return b;
  }
  const KM = () => globalThis.AtriumKeymap;
  const kindNow = host => host.doc?.()?.kind || doc()?.body?.dataset.kind || "schematic";
  function menuItem(step, kind) {
    const sel = step.menu || '[data-action="' + step.action + '"]', d = doc();
    const all = [...(d?.querySelectorAll?.(".menubar .menu-items " + sel.split(",").join(", .menubar .menu-items ")) || [])];
    return all.find(n => !n.dataset.scope || n.dataset.scope === kind) || all[0] || null;
  }
  // "Place › Power Port › GND", from the live menus.
  function menuPath(step, kind) {
    const n = menuItem(step, kind);
    if (!n) return t(STRINGS["menu." + step.action + "." + step.kind] ? "menu." + step.action + "." + step.kind : "menu." + step.action);
    const parts = [globalThis.AtriumNavCommon.menuLabel(n)];
    for (let p = n.parentElement; p; p = p.parentElement) {
      if (p.classList?.contains("submenu")) { const tr = p.querySelector(":scope > .submenu-trigger"); if (tr) parts.unshift(tr.textContent.trim()); }
      if (p.classList?.contains("work-menu")) { const s = p.querySelector(":scope > summary"); if (s) parts.unshift(s.textContent.trim()); break; }
    }
    if (step.id === "power") parts[parts.length - 1] = "GND / VCC";
    return parts.join(" › ");
  }
  const keyFor = (step, kind) => {
    if (step.kind && step.kind !== kind) return "";
    return KM()?.hintKey(step.action, kind) || "";
  };
  // The controls the step uses, highlighted while it is current.
  function targets(step, host) {
    const d = doc(), out = new Set(), kind = kindNow(host), add = n => n && out.add(n);
    if (step.kind && step.kind !== kind) { add(d.querySelector('#document-tabs [data-kind="' + step.kind + '"]')); add(d.querySelector('#documents [data-kind="' + step.kind + '"]')); return [...out]; }
    const item = menuItem(step, kind);
    if (item) { add(item.closest(".work-menu")?.querySelector(":scope > summary")); add(item); add(item.closest(".submenu")?.querySelector(":scope > .submenu-trigger")); }
    add(d.querySelector('#tools [data-action="' + step.action + '"]'));
    return [...out];
  }

  let ui = null;
  function mount(host, c) {
    const d = doc(), pane = d.getElementById("properties"), card = el("section", "tut-card");
    card.setAttribute("role", "region"); card.setAttribute("aria-labelledby", "tut-title"); card.tabIndex = -1;
    const live = el("div", "visually-hidden"); live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite"); live.setAttribute("aria-atomic", "true");
    const body = el("div", "tut-body");
    card.append(body, live);
    card.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); d.getElementById("canvas")?.focus(); } });
    if (pane) { if (d.body.classList.contains("hide-right")) host.act?.("toggle-right"); pane.querySelector(".pane-heading")?.after(card) ?? pane.prepend(card); }
    else d.body.append(card);
    let watched = null;
    const groups = {erc: "Compiler", drc: "DRC"};
    const onMessages = event => { if (event.detail === groups[watched]) observe(); };
    const watch = new MutationObserver(records => {
      if (watched === "fab" || records.some(record => record.target.matches?.("dialog.annotate-dialog[open]"))) observe();
    });
    function watchStep() {
      const step = c.status === "running" ? c.step()?.id : null;
      if (step === watched) return;
      watch.disconnect();
      d.removeEventListener("atrium-messages-changed", onMessages);
      watched = step;
      if (step === "annotate") watch.observe(d.body, {subtree:true, attributes:true, attributeFilter:["open"]});
      else if (groups[step]) d.addEventListener("atrium-messages-changed", onMessages);
      else if (step === "fab") {
        const status = d.getElementById("status");
        if (status) watch.observe(status, {childList:true, characterData:true, subtree:true});
      }
    }
    ui = {host, c, card, body, live, collapsed: false, key: "", lit: [], offKeys: KM()?.onChange?.(() => render(true))};
    // The live region: each step as it starts (after "Step n done"), a pause, the finish.
    let said = -1, done = "";
    c.on(ev => {
      if (ev?.type === "done") { done = t("card.done", {n: ev.index + 1, title: t("step." + ev.step.id + ".title")}); return; }
      watchStep(); render();
      const s = c.step();
      if (c.status === "running" && s && said !== c.index) { said = c.index; announce((done ? done + " " : "") + stepText(c)); done = ""; }
      else if (ev === "paused") { said = -1; announce(t("paused.title") + ". " + t("paused.body")); }
      else if (ev === "finished") { said = -1; announce((done ? done + " " : "") + t("finish.title") + "."); done = ""; }
    });
    return ui;
  }
  // UI signals the project doesn't carry: the Annotate dialog was opened, ERC/DRC results in
  // Messages, "Exported … (N files)" from Fabrication Outputs.
  function observe() {
    if (!ui) return;
    const {c} = ui, d = doc(), s = c.step();
    if (c.status === "running" && s) {
      if (s.id === "annotate" && d.querySelector("dialog.annotate-dialog[open]")) c.seen.annotate = true;
      const M = globalThis.AtriumMessages, group = {erc: "Compiler", drc: "DRC"}[s.id];
      if (group && M?.messages) {
        const rows = M.messages().filter(m => m.group === group), when = Math.max(0, ...rows.map(m => +m.time || 0));
        if (rows.length && when >= c.stepStart - 1000 && (!c.ran[s.id] || when > c.ran[s.id].at)) {
          const bad = rows.filter(m => s.id === "erc" ? m.class === "Error" || m.class === "Fatal" : m.class === "Error" || m.class === "Warning" || m.class === "Fatal").length;
          c.ran[s.id] = {errors: bad, at: when};
        }
      }
      if (s.id === "fab") {
        const status = d.getElementById("status")?.textContent || "";
        if (/^Exported .+\(\d+ files\)/.test(status)) c.ran.fab = {status};
      }
    }
    c.schedule();
  }
  const stepText = c => t("card.announce", {n: c.index + 1, total: STEPS.length, title: t("step." + c.step().id + ".title"), body: t("step." + c.step().id + ".body")});
  function announce(text) { if (!ui) return; ui.live.textContent = ""; setTimeout(() => { if (ui) ui.live.textContent = text; }, 30); }
  function light(list) {
    if (!ui) return;
    for (const n of ui.lit) if (!list.includes(n)) n.removeAttribute("data-tut-highlight");
    for (const n of list) n.setAttribute("data-tut-highlight", "");
    ui.lit = list;
  }
  function render(force) {
    if (!ui) return;
    const {c, host, body, card} = ui, s = c.step(), kind = kindNow(host);
    if (c.status === "closed") { light([]); card.hidden = true; return; }
    card.hidden = false;
    const key = [c.status, c.index, c.track, c.busy, c.error, kind, ui.collapsed, c.waitText(), c.status === "running" && s ? keyFor(s, kind) + menuPath(s, kind) : ""].join("|");
    if (!force && key === ui.key) { if (c.status === "running" && s) light(targets(s, host)); return; }
    const active = doc().activeElement, hadFocus = card.contains(active);
    const action = hadFocus ? active?.dataset?.tut : null;
    ui.key = key; body.replaceChildren();
    const head = el("header", "tut-head"), h = el("h2", "tut-name", t("title")); h.id = "tut-title";
    const tools = el("div", "tut-tools");
    const fold = btn(ui.collapsed ? "+" : "–", () => { ui.collapsed = !ui.collapsed; render(true); }, "tut-icon"); fold.dataset.tut = "fold";
    fold.setAttribute("aria-label", t(ui.collapsed ? "card.expand" : "card.collapse")); fold.setAttribute("aria-expanded", String(!ui.collapsed)); fold.title = fold.getAttribute("aria-label");
    const x = btn(null, () => { c.close(); host.info?.(t("exit.confirm")); doc().getElementById("canvas")?.focus(); }, "tut-icon tut-close"); x.dataset.tut = "close";
    x.setAttribute("aria-label", t("card.exit")); x.title = t("card.exit");
    tools.append(fold, x); head.append(h, tools); body.append(head);
    if (c.status === "intro") renderIntro(body);
    else if (c.status === "paused") {
      light([]);
      body.append(el("h3", "tut-title", t("paused.title")), el("p", "tut-text", t("paused.body")));
      const row = el("div", "tut-actions"); const b = btn(t("paused.return"), () => c.returnToSandbox(), "tut-primary"); b.dataset.tut = "return"; row.append(b); body.append(row);
    } else if (c.status === "finished") renderFinish(body);
    else if (s) renderStep(body, s, kind);
    // Keep keyboard focus in the card across re-renders (the Start button becomes Skip, and so on).
    if (hadFocus) {
      const target = (action && body.querySelector('[data-tut="' + action + '"]')) ||
        body.querySelector('[data-tut="skip"], [data-tut="return"], [data-tut="back"], [data-tut="close-done"]');
      (target && !target.disabled ? target : card).focus();
    }
  }
  function trackPicker(parent) {
    const {c} = ui, g = el("fieldset", "tut-tracks"); g.append(el("legend", null, t("intro.track")));
    for (const tr of TRACKS) {
      const l = el("label", "tut-track"), r = el("input"); r.type = "radio"; r.name = "tut-track"; r.value = tr; r.checked = c.track === tr;
      r.onchange = () => { c.setTrack(tr); render(true); doc().querySelector('.tut-card input[value="' + tr + '"]')?.focus(); };
      l.append(r, el("span", null, t("track." + tr))); g.append(l);
    }
    parent.append(g);
    if (c.track !== "standard") parent.append(el("p", "tut-note", t("track." + c.track + ".lead")));
    if (c.track === "kicad" || c.track === "altium") {
      const want = c.track === "kicad" ? "kicad" : "altium", K = KM();
      if (K?.preset && K.preset() !== want) { const b = btn(t("track." + c.track + ".keys"), () => { try { K.setPreset(want); } catch (e) { ui.host.info?.(e.message); } render(true); }, "tut-link"); b.dataset.tut = "keys"; parent.append(b); }
      else if (want === "kicad" && K?.preset) parent.append(el("p", "tut-note", t("track.kicad.keysOn")));
    }
  }
  function renderIntro(body) {
    const {c} = ui, saved = progress();
    body.append(el("p", "tut-text", t("intro.lead")), el("p", "tut-note", t("intro.sandbox")));
    trackPicker(body);
    const row = el("div", "tut-actions");
    let starting = false;
    const go = o => async () => {
      if (starting) return; starting = true;
      try { await c.begin(o); } catch (e) { ui.host.info?.(e.message); } finally { starting = false; }
      render(true); focusLater('[data-tut="skip"]');
    };
    if (saved && !saved.finished && saved.index > 0) {
      const over = btn(t("intro.over"), go({track: c.track})); over.dataset.tut = "over";
      const res = btn(t("intro.resume", {n: saved.index + 1}), go({track: c.track, resume: true}), "tut-primary"); res.dataset.tut = "start";
      row.append(over, res);
    } else { const b = btn(t("intro.start"), go({track: c.track}), "tut-primary"); b.dataset.tut = "start"; row.append(b); }
    const later = btn(t("intro.later"), () => { c.close(); }); later.dataset.tut = "later"; row.prepend(later);
    body.append(row);
  }
  function renderStep(body, s, kind) {
    const {c, host} = ui, n = c.index + 1, total = STEPS.length;
    const meter = el("div", "tut-meter"); meter.setAttribute("role", "progressbar"); meter.setAttribute("aria-label", t("card.progress"));
    meter.setAttribute("aria-valuemin", "0"); meter.setAttribute("aria-valuemax", String(total)); meter.setAttribute("aria-valuenow", String(c.index));
    const bar = el("span", "tut-meter-bar"); bar.style.inlineSize = (100 * c.index / total).toFixed(1) + "%"; meter.append(bar);
    body.append(el("p", "tut-count", t("card.step", {n, total})), meter, el("h3", "tut-title", t("step." + s.id + ".title")));
    if (ui.collapsed) { light(targets(s, host)); return; }
    const message = (part, cls) => {
      const node = el("p", cls), K = KM();
      node.append(...AtriumNavCommon.shortcutParts(t("step." + s.id + "." + part), {
        escape:"Escape", enter:"Enter", rotate:K?.hintKey("rotate-ccw", kind) || "Space",
        routingMode:K?.hintKey("route-conflict", "pcb") || "Shift+R", layer:"*", kicadRoute:"X"
      }));
      return node;
    };
    body.append(message("body", "tut-text"));
    const how = el("p", "tut-how"), path = menuPath(s, kind), keys = keyFor(s, kind);
    const go = btn(path, () => { if (s.kind && kindNow(host) !== s.kind) c.view(s.kind === "pcb" ? c.ids.pcb : c.ids.sch); setTimeout(() => host.act?.(s.action), 0); }, "tut-link tut-path");
    go.dataset.tut = "run";
    AtriumNavCommon.shortcutTitle(go, path, keys, " from the design canvas");
    how.append(el("span", null, t("card.how") + " "), go);
    if (keys) how.append(el("span", null, " " + t("card.or") + " "), AtriumShortcut.render(keys));
    body.append(how);
    if (c.track !== "standard") body.append(message(c.track, "tut-note"));
    if (s.kind && s.kind !== kind) {
      const sw = el("p", "tut-wait"); sw.append(el("span", null, t("card.switch", {kind: t("card." + s.kind)}) + " "));
      const b = btn(t("card.switchTo", {kind: t("card." + s.kind)}), () => c.view(s.kind === "pcb" ? c.ids.pcb : c.ids.sch), "tut-link"); b.dataset.tut = "switch"; sw.append(b); body.append(sw);
    } else body.append(el("p", "tut-wait", c.waitText()));
    if (c.error) { const e = el("p", "tut-error", c.error); e.setAttribute("role", "alert"); body.append(e); }
    const row = el("div", "tut-actions");
    const restart = btn(t("card.restart"), () => c.restart().then(() => render(true)), "tut-quiet"); restart.dataset.tut = "restart";
    const skip = btn(c.busy ? t("card.skipping") : t("card.skip"), () => c.skip(), "tut-primary"); skip.disabled = c.busy; skip.dataset.tut = "skip";
    row.append(restart, skip); body.append(row);
    light(targets(s, host));
  }
  function renderFinish(body) {
    const {c} = ui;
    light([]);
    const meter = el("div", "tut-meter"); meter.setAttribute("role", "progressbar"); meter.setAttribute("aria-label", t("card.progress"));
    meter.setAttribute("aria-valuemin", "0"); meter.setAttribute("aria-valuemax", String(STEPS.length)); meter.setAttribute("aria-valuenow", String(STEPS.length));
    meter.append(el("span", "tut-meter-bar"));
    body.append(meter, el("h3", "tut-title", t("finish.title")), el("p", "tut-text", t("finish.body")), el("p", "tut-note", t("finish.next")));
    const row = el("div", "tut-actions");
    const r = btn(t("card.restart"), () => c.restart().then(() => render(true)), "tut-quiet"); r.dataset.tut = "restart"; row.append(r);
    if (c.returnTo) { const b = btn(t("finish.back", {name: c.returnTo.project.name}), async () => { if (await c.goBack()) { c.close(); } }, "tut-primary"); b.dataset.tut = "back"; row.append(b); }
    else { const b = btn(t("finish.close"), () => c.close(), "tut-primary"); b.dataset.tut = "close-done"; row.append(b); }
    body.append(row);
  }

  // After the editor has finished its own handling (it may focus the canvas after an action or a
  // project switch), move keyboard focus into the card.
  function focusLater(sel) {
    queueMicrotask(() => { if (!ui || ui.card.hidden) return; const n = sel.split(",").map(x => ui.card.querySelector(x.trim())).find(Boolean); (n || ui.card).focus(); });
  }
  // The "tutorial" action: show the card (the intro, or the running tutorial) and focus it.
  function open(host) {
    if (!doc()?.body || !host) return null;
    if (!ui || !ui.card.isConnected) {
      const c = create(host, {});
      const saved = progress(); if (saved) c.track = saved.track;
      mount(host, c);
    } else ui.c.reopen();
    render(true);
    focusLater('[data-tut="start"], [data-tut="skip"], [data-tut="return"], [data-tut="back"], [data-tut="close-done"]');
    if (ui.c.status === "running" && ui.c.step()) announce(stepText(ui.c));
    return ui.card;
  }
  globalThis.AtriumNavCommon?.ready?.(host => host.registerAction("tutorial", () => open(host)));
  return Object.freeze({STEPS, TRACKS, STRINGS, KEY, t, create, open, progress, facts, menuPath, keyFor, controller: () => ui?.c || null});
})();
