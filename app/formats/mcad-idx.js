"use strict";
if (!globalThis.AtriumImportFormats && typeof require === "function") require("./sexpr.js");
// IDX (ProSTEP iViP EDMD, the "Incremental Design Exchange" XML of PSI 5) for ECAD-MCAD collaboration
// with SolidWorks, Creo, NX, Fusion and Altium's MCAD CoDesigner. Written from public knowledge of
// the EDMD 3.0 schemas (IDX 3.0 / 4.0 "simplified" representation, geometryType on items); see
// docs/mcad.md for what is certain and what is not. DOM-free; needs AtriumXML and AtriumMCAD.
//
//   AtriumIDX.baseline(project, doc, opts) -> {name, text, stats, problems}   SendInformation (records the baseline)
//   AtriumIDX.changes(project, doc, opts)  -> {name, text, stats, problems}   SendChanges since the baseline
//   AtriumIDX.response(project, doc, opts) -> {name, text, stats, problems}   accepted / rejected answers to a received file
//   AtriumIDX.read(text)                   -> design (AtriumMCAD.compare input) with header, kind and notes
//   AtriumIDX.validate(text | tree)        -> [{path, message}] structural check against SCHEMA
// opts: {date (ISO; default now), creator, company, record (default true: store the baseline /
//   change sequence in doc.mcad; call inside edit()), pinHoles, vias, batch (response)}.
//
// Coordinates: IDX is millimetres, Y up; Waffle is Y down. A point (x, y) is written (x, -y). A
// component's 2D transform is its rotation theta = -angle (counter-clockwise, degrees) and, on the
// bottom side, a mirror (determinant -1). zOffset is the seat height: the board top for top parts,
// 0 (the board bottom) for bottom parts, whose bodies extend downward.
globalThis.AtriumIDX = (() => {
  const G = globalThis, X = () => G.AtriumXML, M = () => G.AtriumMCAD;
  const NS = Object.freeze({
    foundation: "http://www.prostep.org/EDMD/3.0/foundation", pdm: "http://www.prostep.org/EDMD/3.0/pdm",
    d2: "http://www.prostep.org/EDMD/3.0/geometry.d2", property: "http://www.prostep.org/EDMD/3.0/property",
    computational: "http://www.prostep.org/EDMD/3.0/computational", administration: "http://www.prostep.org/EDMD/3.0/administration",
    xsi: "http://www.w3.org/2001/XMLSchema-instance"});
  const D2R = Math.PI / 180;
  const GEOMETRY_TYPES = ["BOARD_OUTLINE", "BOARD_AREA_RIGID", "BOARD_AREA_FLEXIBLE", "BOARD_AREA_STIFFENER", "BEND", "COMPONENT", "COMPONENT_MECHANICAL",
    "HOLE_PLATED", "HOLE_NON_PLATED", "VIA", "FILLED_VIA", "KEEPOUT_AREA_ROUTE", "KEEPOUT_AREA_COMPONENT", "KEEPOUT_AREA_VIA", "KEEPOUT_AREA_TESTPOINT",
    "KEEPOUT_AREA_THERMAL", "KEEPOUT_AREA_OTHER", "KEEPIN_AREA_ROUTE", "KEEPIN_AREA_COMPONENT", "KEEPIN_AREA_VIA", "KEEPIN_AREA_TESTPOINT",
    "KEEPIN_AREA_THERMAL", "KEEPIN_AREA_OTHER", "PLACEMENT_GROUP_AREA", "OTHER_OUTLINE", "CONSTRAINT"];
  const UNITS = {UNIT_MM: 1, UNIT_CM: 10, UNIT_M: 1000, UNIT_UM: 0.001, UNIT_IN: 25.4, UNIT_INCH: 25.4, UNIT_MIL: 0.0254, UNIT_THOU: 0.0254};
  const KEEP = {route: "KEEPOUT_AREA_ROUTE", component: "KEEPOUT_AREA_COMPONENT", via: "KEEPOUT_AREA_VIA", other: "KEEPOUT_AREA_OTHER", keepin: "KEEPIN_AREA_COMPONENT"};

  // ---------------------------------------------------------------- schema (structural validation)
  const F = s => "foundation:" + s, P = s => "pdm:" + s, D = s => "d2:" + s, PR = s => "property:" + s, C = s => "computational:" + s;
  const VAL = {children: [PR("Value")], required: [PR("Value")]};
  const IDENT = {children: [F("SystemScope"), F("Number"), F("Version"), F("Revision"), F("Sequence")], required: [F("SystemScope"), F("Number")]};
  const KEYED = {children: [F("SystemScope"), F("ObjectName")], required: [F("ObjectName")]};
  const SCHEMA = Object.freeze({
    root: F("EDMDDataSet"),
    types: {[F("Header")]: [F("EDMDHeader")], [F("Body")]: [F("EDMDDataSetBody")], [F("CartesianPoint")]: [D("EDMDCartesianPoint")], [F("PolyLine")]: [D("EDMDPolyLine")],
      [F("CircleCenter")]: [D("EDMDCircleCenter")], [F("Arc")]: [D("EDMDArc")], [F("CompositeCurve")]: [D("EDMDCompositeCurve")], [F("CurveSet2d")]: [D("EDMDCurveSet2d")],
      [F("ProcessInstruction")]: [C("EDMDProcessInstructionSendInformation"), C("EDMDProcessInstructionSendChanges")], [F("Model3D")]: [P("EDMDModel3D")],
      [F("UserProperty")]: [PR("EDMDUserSimpleProperty")]},
    elements: {
      [F("EDMDDataSet")]: {children: [F("Header"), F("Body"), F("ProcessInstruction")], required: [F("Header"), F("Body"), F("ProcessInstruction")]},
      [F("Header")]: {children: [F("Description"), F("CreatorName"), F("CreatorCompany"), F("CreatorSystem"), F("PostProcessor"), F("PostProcessorVersion"), F("Creator"), F("GlobalUnitLength"), F("CreationDateTime"), F("ModifiedDateTime")],
        required: [F("CreatorSystem"), F("GlobalUnitLength"), F("CreationDateTime")]},
      [F("Description")]: {}, [F("CreatorName")]: {}, [F("CreatorCompany")]: {}, [F("CreatorSystem")]: {}, [F("PostProcessor")]: {}, [F("PostProcessorVersion")]: {}, [F("Creator")]: {},
      [F("GlobalUnitLength")]: {text: Object.keys(UNITS)}, [F("CreationDateTime")]: {}, [F("ModifiedDateTime")]: {},
      [F("Body")]: {children: [F("Item"), F("ShapeElement"), F("CartesianPoint"), F("PolyLine"), F("CircleCenter"), F("Arc"), F("CompositeCurve"), F("CurveSet2d"), F("Model3D")]},
      [F("Item")]: {requiredAttrs: ["id"], attrs: ["id", "geometryType"], enumAttrs: {geometryType: GEOMETRY_TYPES},
        children: [F("Name"), F("Description"), P("ItemType"), P("Identifier"), P("PackageName"), P("Shape"), P("ItemInstance"), P("AssembleToName"), P("BaseLine"), P("EDMD3DModel"), F("UserProperty")],
        required: [P("ItemType")]},
      [F("Name")]: {}, [P("ItemType")]: {text: ["single", "assembly"]}, [P("Identifier")]: IDENT,
      [F("SystemScope")]: {}, [F("Number")]: {}, [F("Version")]: {text: "number"}, [F("Revision")]: {text: "number"}, [F("Sequence")]: {text: "number"}, [F("ObjectName")]: {},
      [P("PackageName")]: KEYED, [P("Shape")]: {ref: true}, [P("AssembleToName")]: {}, [P("BaseLine")]: {text: "boolean"}, [P("EDMD3DModel")]: {ref: true},
      [P("ItemInstance")]: {requiredAttrs: ["id"], attrs: ["id"], children: [P("Item"), P("InstanceName"), P("Transformation"), P("zOffset"), F("UserProperty")], required: [P("Item")]},
      [P("Item")]: {ref: true}, [P("InstanceName")]: KEYED,
      [P("Transformation")]: {children: [P("TransformationType"), P("xx"), P("xy"), P("yx"), P("yy"), P("tx"), P("ty")], required: [P("TransformationType"), P("xx"), P("xy"), P("yx"), P("yy"), P("tx"), P("ty")]},
      [P("TransformationType")]: {text: ["d2"]}, [P("xx")]: {text: "number"}, [P("xy")]: {text: "number"}, [P("yx")]: {text: "number"}, [P("yy")]: {text: "number"},
      [P("tx")]: VAL, [P("ty")]: VAL, [P("zOffset")]: VAL, [PR("Value")]: {},
      [F("UserProperty")]: {children: [PR("Key"), PR("Value")], required: [PR("Key"), PR("Value")]}, [PR("Key")]: KEYED,
      [F("ShapeElement")]: {requiredAttrs: ["id"], attrs: ["id"], children: [P("ShapeElementType"), P("Inverted"), P("DefiningShape")], required: [P("ShapeElementType"), P("DefiningShape")]},
      [P("ShapeElementType")]: {text: ["FeatureShapeElement", "PartShapeElement", "ComponentTermination", "NonFeatureShapeElement"]}, [P("Inverted")]: {text: "boolean"}, [P("DefiningShape")]: {ref: true},
      [F("CartesianPoint")]: {requiredAttrs: ["id"], attrs: ["id"], children: [D("X"), D("Y")], required: [D("X"), D("Y")]}, [D("X")]: VAL, [D("Y")]: VAL,
      [F("PolyLine")]: {requiredAttrs: ["id"], attrs: ["id"], children: [D("Thickness"), D("Point")], required: [D("Point")]}, [D("Point")]: {ref: true}, [D("Thickness")]: VAL,
      [F("CircleCenter")]: {requiredAttrs: ["id"], attrs: ["id"], children: [D("CenterPoint"), D("Diameter")], required: [D("CenterPoint"), D("Diameter")]}, [D("CenterPoint")]: {ref: true}, [D("Diameter")]: VAL,
      [F("Arc")]: {requiredAttrs: ["id"], attrs: ["id"], children: [D("StartPoint"), D("MidPoint"), D("EndPoint")], required: [D("StartPoint"), D("MidPoint"), D("EndPoint")]},
      [D("StartPoint")]: {ref: true}, [D("MidPoint")]: {ref: true}, [D("EndPoint")]: {ref: true},
      [F("CompositeCurve")]: {requiredAttrs: ["id"], attrs: ["id"], children: [D("Curve")], required: [D("Curve")]}, [D("Curve")]: {ref: true},
      [F("CurveSet2d")]: {requiredAttrs: ["id"], attrs: ["id"], children: [P("ShapeDescriptionType"), D("LowerBound"), D("UpperBound"), D("DetailedGeometricModelElement")], required: [D("LowerBound"), D("UpperBound"), D("DetailedGeometricModelElement")]},
      [P("ShapeDescriptionType")]: {text: ["GeometricModel", "Outline"]}, [D("LowerBound")]: VAL, [D("UpperBound")]: VAL, [D("DetailedGeometricModelElement")]: {ref: true},
      [F("Model3D")]: {requiredAttrs: ["id"], attrs: ["id"], children: [P("ModelIdentifier"), P("ModelVersion"), P("ModelLocation"), P("MCADFormat")], required: [P("ModelIdentifier")]},
      [P("ModelIdentifier")]: {}, [P("ModelVersion")]: {}, [P("ModelLocation")]: {}, [P("MCADFormat")]: {},
      [F("ProcessInstruction")]: {children: [C("Changes")]},
      [C("Changes")]: {children: [C("NewItem"), C("PredecessorItem"), C("IsAttributeChanged"), C("Accepted"), C("Comment")]},
      [C("NewItem")]: {ref: true}, [C("PredecessorItem")]: {ref: true}, [C("IsAttributeChanged")]: {text: "boolean"}, [C("Accepted")]: {text: "boolean"}, [C("Comment")]: {}
    }});

  // ---------------------------------------------------------------- writer
  function builder(o) {
    const x = X(), el = x.el, body = [], counters = {}, points = new Map();
    const id = p => p + "_" + (counters[p] = (counters[p] || 0) + 1);
    const val = (q, v) => el(q, null, el("property:Value", null, v));
    const r = v => Math.round(v * 1e6) / 1e6 || 0;
    function point(x0, y0) {
      const k = r(x0) + "," + r(y0);
      let p = points.get(k);
      if (!p) { p = id("CP"); points.set(k, p); body.push(el("foundation:CartesianPoint", {id: p, "xsi:type": "d2:EDMDCartesianPoint"}, val("d2:X", r(x0)), val("d2:Y", r(y0)))); }
      return p;
    }
    // Waffle (Y down) polygon -> closed PolyLine (first point repeated), Y up.
    function polyline(pts) {
      const pl = id("PL"), refs = pts.map(q => point(q[0], -q[1]));
      body.push(el("foundation:PolyLine", {id: pl, "xsi:type": "d2:EDMDPolyLine"}, [...refs, refs[0]].map(p => el("d2:Point", null, p))));
      return pl;
    }
    function circle(c, d) {
      const cc = id("CC");
      body.push(el("foundation:CircleCenter", {id: cc, "xsi:type": "d2:EDMDCircleCenter"}, el("d2:CenterPoint", null, point(c[0], c[1])), val("d2:Diameter", r(d))));
      return cc;
    }
    // An exact Waffle contour (lines and arcs, Y down, screen angles) -> PolyLine or CompositeCurve.
    function contour(segs) {
      const B = G.AtriumBoardShape;
      if (segs.length === 1 && segs[0].kind === "arc" && Math.abs(B.sweep(segs[0])) >= 359.999) { const s = segs[0]; return circle([s.c[0], -s.c[1]], 2 * s.r); }
      if (!segs.some(s => s.kind === "arc")) return polyline(segs.map(s => s.a));
      const curves = [];
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const pl = id("PL"), refs = run.map(q => point(q[0], -q[1]));
        body.push(el("foundation:PolyLine", {id: pl, "xsi:type": "d2:EDMDPolyLine"}, refs.map(p => el("d2:Point", null, p))));
        curves.push(pl); run = [];
      };
      for (const s of segs) {
        if (s.kind !== "arc") { if (!run.length) run.push(s.a); run.push(s.b); continue; }
        flush();
        const [a, b] = B.ends(s), mid = B.pointAt(s.c, s.r, s.start + B.sweep(s) / 2);
        const arc = id("AR");
        body.push(el("foundation:Arc", {id: arc, "xsi:type": "d2:EDMDArc"}, el("d2:StartPoint", null, point(a[0], -a[1])), el("d2:MidPoint", null, point(mid[0], -mid[1])), el("d2:EndPoint", null, point(b[0], -b[1]))));
        curves.push(arc);
      }
      flush();
      const cc = id("CU");
      body.push(el("foundation:CompositeCurve", {id: cc, "xsi:type": "d2:EDMDCompositeCurve"}, curves.map(c => el("d2:Curve", null, c))));
      return cc;
    }
    function curveSet(curves, z0, z1) {
      const cs = id("CS");
      body.push(el("foundation:CurveSet2d", {id: cs, "xsi:type": "d2:EDMDCurveSet2d"}, el("pdm:ShapeDescriptionType", null, "GeometricModel"),
        val("d2:LowerBound", r(z0)), val("d2:UpperBound", r(z1)), [].concat(curves).map(c => el("d2:DetailedGeometricModelElement", null, c))));
      return cs;
    }
    function shape(cs, inverted) {
      const se = id("SE");
      body.push(el("foundation:ShapeElement", {id: se}, el("pdm:ShapeElementType", null, "FeatureShapeElement"), el("pdm:Inverted", null, inverted ? "true" : "false"), el("pdm:DefiningShape", null, cs)));
      return se;
    }
    const ident = (i, version) => el("pdm:Identifier", null, el("foundation:SystemScope", null, i.scope), el("foundation:Number", null, i.number),
      el("foundation:Version", null, version || 1), el("foundation:Revision", null, 0), el("foundation:Sequence", null, o.sequence || 0));
    const prop = (k, v) => el("foundation:UserProperty", {"xsi:type": "property:EDMDUserSimpleProperty"}, el("property:Key", null, el("foundation:SystemScope", null, M().SCOPE), el("foundation:ObjectName", null, k)), el("property:Value", null, v));
    function single(name, shapes, extra = {}) {
      const it = id("IT");
      body.push(el("foundation:Item", {id: it}, el("foundation:Name", null, name), el("pdm:ItemType", null, "single"),
        extra.ident ? ident(extra.ident, extra.version) : null,
        extra.package ? el("pdm:PackageName", null, el("foundation:SystemScope", null, M().SCOPE), el("foundation:ObjectName", null, extra.package)) : null,
        shapes.map(s => el("pdm:Shape", null, s)), el("pdm:BaseLine", null, o.baseline ? "true" : "false"),
        extra.model ? el("pdm:EDMD3DModel", null, extra.model) : null, (extra.props || []).map(([k, v]) => prop(k, v))));
      return it;
    }
    // transform: {theta (deg, CCW, Y up), mirror, tx, ty (Y up), z}
    function assembly(type, name, identity, version, singleId, instanceName, t, props = []) {
      const it = id("IT"), c = Math.cos((t?.theta || 0) * D2R), s = Math.sin((t?.theta || 0) * D2R), m = t?.mirror;
      const xf = el("pdm:Transformation", null, el("pdm:TransformationType", null, "d2"), el("pdm:xx", null, r(c)), el("pdm:xy", null, r(m ? s : -s)), el("pdm:yx", null, r(s)), el("pdm:yy", null, r(m ? -c : c)),
        val("pdm:tx", r(t?.tx || 0)), val("pdm:ty", r(t?.ty || 0)));
      body.push(el("foundation:Item", {id: it, geometryType: type}, el("foundation:Name", null, name), el("pdm:ItemType", null, "assembly"), ident(identity, version),
        el("pdm:ItemInstance", {id: id("II")}, el("pdm:Item", null, singleId), el("pdm:InstanceName", null, el("foundation:SystemScope", null, M().SCOPE), el("foundation:ObjectName", null, instanceName)), xf,
          t?.z != null ? val("pdm:zOffset", r(t.z)) : null),
        el("pdm:BaseLine", null, o.baseline ? "true" : "false"), props.map(([k, v]) => prop(k, v))));
      return it;
    }
    function stub(identity, version, name) {
      const it = id("IT");
      body.push(el("foundation:Item", {id: it}, el("foundation:Name", null, name || identity.number), el("pdm:ItemType", null, "assembly"), ident(identity, version)));
      return it;
    }
    function model3d(file) {
      const m = id("MD");
      body.push(el("foundation:Model3D", {id: m, "xsi:type": "pdm:EDMDModel3D"}, el("pdm:ModelIdentifier", null, file), el("pdm:MCADFormat", null, "STEP")));
      return m;
    }
    return {body, id, point, polyline, circle, contour, curveSet, shape, single, assembly, stub, model3d, prop};
  }
  const isoDate = d => { const t = d ? new Date(d) : new Date(); return (Number.isFinite(t.getTime()) ? t : new Date()).toISOString().slice(0, 19); };
  function dataset(b, o, instruction) {
    const x = X(), el = x.el;
    return el("foundation:EDMDDataSet", null,
      el("foundation:Header", {"xsi:type": "foundation:EDMDHeader"}, el("foundation:Description", null, o.description || "Waffle IDX"),
        el("foundation:CreatorName", null, o.creator || ""), el("foundation:CreatorCompany", null, o.company || ""), el("foundation:CreatorSystem", null, "Waffle"),
        el("foundation:GlobalUnitLength", null, "UNIT_MM"), el("foundation:CreationDateTime", null, isoDate(o.date)), el("foundation:ModifiedDateTime", null, isoDate(o.date))),
      el("foundation:Body", {"xsi:type": "foundation:EDMDDataSetBody"}, b.body),
      instruction);
  }
  // Writes every object of the snapshot whose key passes `want` (default all).
  function writeObjects(b, snap, doc, versions, want = () => true) {
    const MC = M(), out = new Map(), shared = new Map();
    const t = snap.board.thickness, ver = k => versions?.[k] || 1;
    if (want("board")) {
      const bd = snap.board;
      const outer = bd.contour?.length ? b.contour(bd.contour) : b.polyline(bd.outline);
      const shapes = [b.shape(b.curveSet(outer, 0, t), false)];
      const cuts = bd.cutoutContours?.length ? bd.cutoutContours : bd.cutouts;
      for (const c of cuts) shapes.push(b.shape(b.curveSet(bd.cutoutContours?.length ? b.contour(c) : b.polyline(c), 0, t), true));
      const props = [["THICKNESS", t]];
      if (bd.constraints?.maxHeightTop != null) props.push(["MAX_COMPONENT_HEIGHT_TOP", bd.constraints.maxHeightTop]);
      if (bd.constraints?.maxHeightBottom != null) props.push(["MAX_COMPONENT_HEIGHT_BOTTOM", bd.constraints.maxHeightBottom]);
      const s = b.single(bd.name, shapes);
      out.set("board", b.assembly("BOARD_OUTLINE", bd.name, MC.identOf(doc, "board"), ver("board"), s, bd.name, {theta: 0, tx: 0, ty: 0, z: 0}, props));
    }
    for (const p of snap.parts) {
      if (!want(p.key)) continue;
      // One package body per footprint, height and model: shared by every instance.
      const k = p.def + "|" + p.height + "|" + (p.model || "");
      let s = shared.get(k);
      if (!s) {
        const fp = footprintOutline(snap, p);
        const cs = b.curveSet(b.polyline(fp), 0, p.height);
        s = b.single(p.package, [b.shape(cs, false)], {package: p.package, model: p.model ? b.model3d(p.model) : null});
        shared.set(k, s);
      }
      const props = [["REFDES", p.ref], ["VALUE", p.value], ["SIDE", p.side.toUpperCase()]];
      if (p.locked) props.push(["LOCKED", "true"]);
      out.set(p.key, b.assembly("COMPONENT", p.ref, MC.identOf(doc, p.key), ver(p.key), s, p.ref,
        {theta: -p.angle, mirror: p.side === "Bottom", tx: p.x, ty: -p.y, z: p.side === "Bottom" ? 0 : t}, props));
    }
    for (const h of snap.holes) {
      if (!want(h.key)) continue;
      const k = "hole|" + h.d + "|" + h.plated;
      let s = shared.get(k);
      if (!s) { s = b.single((h.plated ? "PTH " : "NPTH ") + h.d, [b.shape(b.curveSet(b.circle([0, 0], h.d), 0, t), true)]); shared.set(k, s); }
      out.set(h.key, b.assembly(h.via ? "VIA" : h.plated ? "HOLE_PLATED" : "HOLE_NON_PLATED", h.owner ? (snap.index.get(h.owner)?.ref || "") + " " + h.key.split("/").pop() : "Hole",
        MC.identOf(doc, h.key), ver(h.key), s, h.key, {theta: 0, tx: h.x, ty: -h.y}));
    }
    for (const k of snap.keepouts) {
      if (!want(k.key)) continue;
      const z1 = k.z1 != null ? k.z1 : k.kind === "route" || k.kind === "via" ? 0 : 1000;
      const s = b.single("Area " + k.key, [b.shape(b.curveSet(b.polyline(k.points), k.z0 || 0, z1), false)]);
      out.set(k.key, b.assembly(KEEP[k.kind] || "KEEPOUT_AREA_OTHER", (k.kind === "keepin" ? "Keep-in " : "Keep-out ") + k.key, MC.identOf(doc, k.key), ver(k.key), s, k.key,
        {theta: 0, tx: 0, ty: 0}, [["LAYER", k.layer || "All"]]));
    }
    for (const bend of snap.bends) {
      if (!want(bend.key)) continue;
      const s = b.single(bend.name, [b.shape(b.curveSet(b.polyline(bendZone(bend)), 0, t), false)]);
      out.set(bend.key, b.assembly("BEND", bend.name, MC.identOf(doc, bend.key), ver(bend.key), s, bend.name, {theta: 0, tx: 0, ty: 0},
        [["BEND_ANGLE", bend.angle], ["BEND_RADIUS", bend.radius], ["BEND_LINE", [bend.a, bend.b].map(p => p[0] + " " + -p[1]).join(" ")]]));
    }
    return out;
  }
  function bendZone(bd) {
    const dx = bd.b[0] - bd.a[0], dy = bd.b[1] - bd.a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l * bd.width / 2, ny = dx / l * bd.width / 2;
    return [[bd.a[0] + nx, bd.a[1] + ny], [bd.b[0] + nx, bd.b[1] + ny], [bd.b[0] - nx, bd.b[1] - ny], [bd.a[0] - nx, bd.a[1] - ny]];
  }
  // The body outline of a component in its own frame (Y down, like the footprint), from the 3D body code.
  function footprintOutline(snap, p) {
    const S = G.AtriumSTEP, def = snap.defs?.get(p.def) || snap.def;
    if (S && def?.footprint) {
      try {
        const m = S.model({name: "p", documents: [{id: "x", kind: "pcb", name: "x", grid: 1, outline: [[-1, -1], [1, -1], [1, 1], [-1, 1]], items: [{id: "q", kind: "part", def: p.def, ref: p.ref, value: "", x: 0, y: 0, angle: 0}], notes: []}], library: [def]}, "x", {holes: false, models: false});
        const part = m.parts[0];
        if (part?.body?.loops?.[0]) { const f = S.flattenLoop(part.body.loops[0], 0.02), out = []; for (let i = 0; i < f.length; i += 2) out.push([Math.round(f[i] * 1e4) / 1e4, -Math.round(f[i + 1] * 1e4) / 1e4]); if (out.length >= 3) return out; }
      } catch { /* box below */ }
    }
    return [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  }
  const fileBase = (project, doc) => String(doc.name && doc.name !== "Board layout" ? doc.name : project.name || "Board").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "Board";
  function finishFile(tree, name, stats) {
    const text = X().write(tree, {namespaces: NS});
    return {name, text, stats: {...stats, bytes: text.length}, problems: X().validate(X().asParsed(tree), SCHEMA)};
  }
  function snapFor(project, doc, o) {
    const snap = M().exportSnapshot(project, doc, o);
    snap.defs = new Map((project.library || []).map(d => [d.id, d]));
    o.snapshotResult?.(snap);
    return snap;
  }

  function baseline(project, doc, o = {}) {
    const snap = snapFor(project, doc, o), b = builder({...o, baseline: true, sequence: 0});
    const written = writeObjects(b, snap, doc, null);
    const tree = dataset(b, {...o, description: o.description || "Waffle IDX baseline: " + snap.board.name},
      X().el("foundation:ProcessInstruction", {"xsi:type": "computational:EDMDProcessInstructionSendInformation"}));
    if (o.record !== false) M().recordSent(doc, snap, {reset: true, at: isoDate(o.date)});
    return finishFile(tree, fileBase(project, doc) + "-baseline.idx", {items: written.size, parts: snap.parts.length, holes: snap.holes.length, keepouts: snap.keepouts.length, bends: snap.bends.length});
  }
  function changes(project, doc, o = {}) {
    const MC = M(), snap = snapFor(project, doc, o), ch = MC.changesSince(doc, snap);
    if (!ch) throw Error("Export an IDX baseline first: changes are sent relative to it.");
    const base = MC.peek(doc).baseline, seq = base.seq + 1, versions = {...base.versions};
    for (const k of ch.changed) versions[k] = (versions[k] || 1) + 1;
    const b = builder({...o, baseline: false, sequence: seq}), want = new Set([...ch.added, ...ch.changed]);
    const written = writeObjects(b, snap, doc, versions, k => want.has(k));
    const x = X(), el = x.el, entries = [];
    for (const k of ch.changed) {
      const pred = b.stub(MC.identOf(doc, k), base.versions?.[k] || 1);
      entries.push(el("computational:Changes", null, el("computational:NewItem", null, written.get(k)), el("computational:PredecessorItem", null, pred), el("computational:IsAttributeChanged", null, "false"),
        el("computational:Comment", null, "Changed in Waffle")));
    }
    for (const k of ch.added) entries.push(el("computational:Changes", null, el("computational:NewItem", null, written.get(k)), el("computational:IsAttributeChanged", null, "false"), el("computational:Comment", null, "Added in Waffle")));
    for (const k of ch.removed) {
      const pred = b.stub(MC.identOf(doc, k), base.versions?.[k] || 1);
      entries.push(el("computational:Changes", null, el("computational:PredecessorItem", null, pred), el("computational:IsAttributeChanged", null, "false"), el("computational:Comment", null, "Deleted in Waffle")));
    }
    const tree = dataset(b, {...o, description: o.description || "Waffle IDX changes " + seq + ": " + snap.board.name},
      el("foundation:ProcessInstruction", {"xsi:type": "computational:EDMDProcessInstructionSendChanges"}, entries));
    if (o.record !== false) MC.recordSent(doc, snap, {at: isoDate(o.date)});
    return finishFile(tree, fileBase(project, doc) + "-changes-" + seq + ".idx", {added: ch.added.length, changed: ch.changed.length, removed: ch.removed.length, sequence: seq});
  }
  // The answer to a received file: one Changes entry per decided proposal, Accepted true or false.
  function response(project, doc, o = {}) {
    const MC = M(), m = MC.peek(doc), inbox = m?.inbox || [];
    const decided = inbox.filter(p => (p.status === "accepted" || p.status === "rejected") && p.ident?.number && (!o.batch || p.batch === o.batch));
    const batch = o.batch || decided.at(-1)?.batch;
    const list = decided.filter(p => p.batch === batch);
    if (!list.length) throw Error("Accept or reject a received MCAD proposal first.");
    const b = builder({...o, baseline: false, sequence: m.baseline?.seq || 0}), x = X(), el = x.el, entries = [];
    for (const p of list) {
      const s = b.stub({scope: p.ident.scope || "", number: p.ident.number}, p.ident.version || 1, p.ref || p.label);
      entries.push(el("computational:Changes", null, el("computational:NewItem", null, s), el("computational:IsAttributeChanged", null, "false"),
        el("computational:Accepted", null, p.status === "accepted" ? "true" : "false"), el("computational:Comment", null, (p.comment ? p.comment + " · " : "") + p.label)));
    }
    const tree = dataset(b, {...o, description: o.description || "Waffle IDX response"}, el("foundation:ProcessInstruction", {"xsi:type": "computational:EDMDProcessInstructionSendChanges"}, entries));
    const recv = (m.received || []).find(r => r.batch === batch);
    return finishFile(tree, fileBase(project, doc) + "-response-" + batch + ".idx", {accepted: list.filter(p => p.status === "accepted").length, rejected: list.filter(p => p.status === "rejected").length, batch, file: recv?.file || ""});
  }

  // ---------------------------------------------------------------- reader
  function read(text, opts = {}) {
    const x = X(), root = x.parse(text, {prefixes: NS, limits: opts.limits});
    if (root.local !== "EDMDDataSet") throw Error("This is not an IDX file (its root is <" + root.name + ">, not EDMDDataSet).");
    const header = x.child(root, "Header"), body = x.child(root, "Body");
    if (!body) throw Error("The IDX file has no Body.");
    const unitName = x.text(x.child(header, "GlobalUnitLength")) || "UNIT_MM", k = UNITS[unitName.toUpperCase()];
    const notes = [];
    if (k == null) throw Error("Unsupported IDX length unit " + unitName + ".");
    const byId = new Map();
    for (const c of body.children) if (c.attrs.id != null) byId.set(c.attrs.id, c);
    const ref = (node, q) => { const t = x.text(x.child(node, q)); return t ? byId.get(t) || null : null; };
    const val = n => { const v = x.num(n); return v == null ? null : v; };
    const pt = n => { if (!n) return null; const X0 = val(x.child(n, "X")), Y0 = val(x.child(n, "Y")); return X0 == null || Y0 == null ? null : [X0 * k, Y0 * k]; };
    // A curve -> {loops: [[x,y]...] in its own frame (Y up), circle?: {c, d}, arcs: count}
    const curveCache = new Map();
    // Every shape copies its curve's points: a budget stops a small file from referencing one
    // large curve a million times (reference amplification, security review).
    let budget = 4000000;
    function curve(node, depth = 0) {
      if (!node || depth > 8) return null;
      if (curveCache.has(node)) return curveCache.get(node);
      let r = null;
      const kind = node.local, type = x.typeOf(node, NS);
      if (kind === "PolyLine" || /PolyLine$/.test(type)) {
        const pts = x.children(node, "Point").map(p => pt(byId.get(x.text(p)))).filter(Boolean);
        r = {pts, closed: pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-6};
      } else if (kind === "CircleCenter" || /CircleCenter$/.test(type)) {
        const c = pt(ref(node, "CenterPoint")), d = val(x.child(node, "Diameter"));
        if (c && d > 0) r = {circle: {c, d: d * k}, pts: ring(c, d * k / 2), closed: true};
      } else if (kind === "Circle3Point" || /Circle3Point$/.test(type)) {
        const a = pt(ref(node, "Point1")), b = pt(ref(node, "Point2")), c = pt(ref(node, "Point3")), cc = a && b && c && G.AtriumImportFormats.geom.circle3(a, b, c);
        if (cc) r = {circle: {c: cc.c, d: 2 * cc.r}, pts: ring(cc.c, cc.r), closed: true};
      } else if (kind === "Arc" || /Arc$/.test(type)) {
        const a = pt(ref(node, "StartPoint")), m = pt(ref(node, "MidPoint")), b = pt(ref(node, "EndPoint"));
        if (a && m && b) r = {pts: arcPoints(a, m, b), arc: {a, m, b}, closed: false};
      } else if (kind === "Line" || /Line$/.test(type)) {
        const a = pt(ref(node, "Point")) || pt(ref(node, "StartPoint")), b = pt(ref(node, "EndPoint"));
        if (a && b) r = {pts: [a, b], closed: false};
      } else if (kind === "CompositeCurve" || /CompositeCurve$/.test(type)) {
        const pts = [], arcs = [];
        for (const c of x.children(node, "Curve")) {
          const s = curve(byId.get(x.text(c)), depth + 1);
          if (!s) continue;
          const seq = s.pts.slice();
          if (pts.length && Math.hypot(pts.at(-1)[0] - seq[0][0], pts.at(-1)[1] - seq[0][1]) < 1e-6) seq.shift();
          if (s.arc) arcs.push({...s.arc, from: pts.length ? pts.length - 1 : 0});
          pts.push(...seq);
          if (pts.length > 100000) throw Error("An IDX curve has more than 100000 points.");
        }
        r = {pts, arcs, closed: pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-6};
      }
      if (r && r.pts.length > 100000) throw Error("An IDX curve has more than 100000 points.");
      curveCache.set(node, r);
      return r;
    }
    // A single item's shapes: [{pts (closed, Y up), circle, inverted, z0, z1}]
    function shapesOf(item) {
      const out = [];
      for (const s of x.children(item, "Shape")) {
        let se = byId.get(x.text(s));
        if (!se) continue;
        let inverted = false, cs = se;
        if (se.local === "ShapeElement") { inverted = x.text(x.child(se, "Inverted")) === "true"; cs = ref(se, "DefiningShape"); }
        if (!cs) continue;
        const z0 = (val(x.child(cs, "LowerBound")) ?? 0) * k, z1 = (val(x.child(cs, "UpperBound")) ?? 0) * k;
        const elems = x.children(cs, "DetailedGeometricModelElement");
        for (const e of elems.length ? elems : [cs]) {
          const c = curve(byId.get(x.text(e)) || (e === cs ? null : null));
          if (!c || c.pts.length < 3) continue;
          if ((budget -= c.pts.length) < 0) throw Error("The IDX file's shapes expand to more than 4000000 outline points.");
          let pts = c.pts.slice();
          if (c.closed && pts.length > 3) pts.pop();
          out.push({pts, circle: c.circle || null, arcs: c.arcs || (c.arc ? [c.arc] : []), inverted, z0, z1});
        }
      }
      return out;
    }
    const ident = node => {
      const id = x.child(node, "Identifier");
      if (!id) return null;
      return {scope: x.text(x.child(id, "SystemScope")), number: x.text(x.child(id, "Number")), version: +x.text(x.child(id, "Version")) || 1};
    };
    const props = node => {
      const out = {};
      for (const u of x.children(node, "UserProperty")) { const key = x.text(x.child(x.child(u, "Key"), "ObjectName")); if (key) out[key.toUpperCase()] = x.text(x.child(u, "Value")); }
      return out;
    };
    const xfOf = inst => {
      const t = x.child(inst, "Transformation");
      if (!t) return {xx: 1, xy: 0, yx: 0, yy: 1, tx: 0, ty: 0};
      const n = q => { const v = x.num(x.child(t, q)); return v == null ? 0 : v; };
      return {xx: n("xx"), xy: n("xy"), yx: n("yx"), yy: n("yy"), tx: n("tx") * k, ty: n("ty") * k};
    };
    const apply = (T, p) => [T.xx * p[0] + T.xy * p[1] + T.tx, T.yx * p[0] + T.yy * p[1] + T.ty];

    // The change list (SendChanges): which items are new, which were removed.
    const instr = x.child(root, "ProcessInstruction"), itype = instr ? x.typeOf(instr, NS) : "";
    const kind = /SendChanges/.test(itype) ? "changes" : /SendInformation/.test(itype) || !itype ? "baseline" : /Accept|Response/i.test(itype) ? "response" : "baseline";
    const rows = [];
    for (const c of x.children(instr, "Changes")) {
      const inner = x.children(c, "Change");
      for (const r of inner.length ? inner : [c]) rows.push(r);
    }
    const listed = new Set(), removed = [], responses = [];
    for (const r of rows) {
      const nw = ref(r, "NewItem"), pred = ref(r, "PredecessorItem"), acc = x.child(r, "Accepted");
      if (acc) { const it = nw || pred; responses.push({ident: it ? ident(it) : null, accepted: x.text(acc) === "true", comment: x.text(x.child(r, "Comment")).slice(0, 500)}); continue; }
      if (nw) listed.add(nw);
      else if (pred) { const i = ident(pred); if (i) removed.push(i); }
    }
    const isResponse = responses.length > 0 && listed.size === 0;
    const design = {source: "idx", kind: isResponse ? "response" : kind, full: kind === "baseline" && !isResponse, parts: [], holes: [], keepouts: [], removed, responses, notes,
      board: null, header: {system: x.text(x.child(header, "CreatorSystem")), creator: x.text(x.child(header, "CreatorName")), transaction: x.text(x.child(header, "Description")).slice(0, 200)}};
    if (isResponse) return design;

    // Items with a geometry type: placed through their instances (assembly) or directly (single).
    const referenced = new Set();
    for (const it of x.children(body, "Item")) for (const inst of x.children(it, "ItemInstance")) { const t = ref(inst, "Item"); if (t) referenced.add(t); }
    let skipped = 0;
    for (const it of x.children(body, "Item")) {
      if (rows.length && kind === "changes" && !listed.has(it)) continue;
      const type = String(it.attrs.geometryType || "").toUpperCase();
      const insts = x.children(it, "ItemInstance");
      const id0 = ident(it);
      const placed = [];
      if (insts.length) for (const inst of insts) {
        const target = ref(inst, "Item");
        if (!target) continue;
        placed.push({T: xfOf(inst), single: target, name: x.text(x.child(x.child(inst, "InstanceName"), "ObjectName")), z: (x.num(x.child(inst, "zOffset")) ?? null), props: {...props(target), ...props(inst), ...props(it)},
          type: type || String(target.attrs.geometryType || "").toUpperCase()});
      } else if (!referenced.has(it) && type) placed.push({T: {xx: 1, xy: 0, yx: 0, yy: 1, tx: 0, ty: 0}, single: it, name: x.text(x.child(it, "Name")), z: null, props: props(it), type});
      for (const pl of placed) {
        const source = id0?.number || it.attrs.id;
        const t = pl.type, sh = shapesOf(pl.single), world = s => s.pts.map(p => apply(pl.T, p)), down = P => P.map(p => [p[0], -p[1]]);
        if (t === "BOARD_OUTLINE") {
          const solids = sh.filter(s => !s.inverted), outer = solids.map(s => ({s, a: Math.abs(area(s.pts))})).sort((a, b) => b.a - a.a)[0]?.s;
          if (!outer) { opts.trace?.omitted("Mechanical board profile", source, "No closed outline could be read."); notes.push("The board outline item has no closed outline."); continue; }
          const cutouts = [...sh.filter(s => s.inverted), ...solids.filter(s => s !== outer)].map(s => down(world(s)));
          design.board = {ident: id0, outline: down(world(outer)), cutouts, thickness: Math.max(0, outer.z1 - outer.z0) || null};
          if (opts.trace && sh.some(s => s.circle || s.arcs.length)) opts.trace.approximate(design.board, "Curved edges were sampled into the proposal outline.");
        } else if (t === "COMPONENT" || t === "COMPONENT_MECHANICAL" || (!t && x.child(pl.single, "PackageName"))) {
          const T = pl.T, det = T.xx * T.yy - T.xy * T.yx, theta = Math.atan2(T.yx, T.xx) / D2R;
          const side = det < 0 || /^BOT/i.test(pl.props.SIDE || "") ? "Bottom" : "Top";
          design.parts.push({ident: id0, ref: pl.props.REFDES || pl.name || x.text(x.child(it, "Name")), x: T.tx, y: -T.ty, angle: -theta, side, mechanical: t === "COMPONENT_MECHANICAL",
            height: sh[0] ? sh[0].z1 - sh[0].z0 : null});
        } else if (t === "HOLE_PLATED" || t === "HOLE_NON_PLATED") {
          const s = sh[0];
          if (!s) { opts.trace?.omitted("Drilled hole", source, "The hole has no readable shape."); notes.push("A hole item has no shape."); continue; }
          let c, d;
          if (s.circle) { c = apply(pl.T, s.circle.c); d = s.circle.d; }
          else { const w = world(s), b = bounds(w); c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; d = Math.min(b[2] - b[0], b[3] - b[1]); notes.push("A non-circular hole was read as its inscribed diameter."); }
          const hole = {ident:id0, x:c[0], y:-c[1], d, plated:t === "HOLE_PLATED"};
          design.holes.push(hole);
          if (!s.circle) opts.trace?.approximate(hole, "The non-circular hole was read as its inscribed diameter.");
        } else if (/^KEEP(OUT|IN)_AREA_/.test(t)) {
          const s = sh[0];
          if (!s) { opts.trace?.omitted("Mechanical keep-out", source, "The keep-out has no readable boundary."); continue; }
          const kk = /^KEEPIN/.test(t) ? "keepin" : t.endsWith("_ROUTE") ? "route" : t.endsWith("_COMPONENT") ? "component" : t.endsWith("_VIA") ? "via" : "other";
          const z1 = s.z1 >= 999 ? null : s.z1;
          const layer = pl.props.LAYER && pl.props.LAYER !== "All" ? pl.props.LAYER : null;
          const item = {ident:id0, kind:kk, points:down(world(s)), z0:s.z0, z1:kk === "route" || kk === "via" ? (s.z1 > 0 && s.z1 < 999 ? s.z1 : null) : z1, layer};
          design.keepouts.push(item);
          if (s.circle || s.arcs.length) opts.trace?.approximate(item, "The keep-out's curved edges were sampled into a polygon.");
        } else {
          skipped++;
          opts.trace?.omitted("IDX geometry", source, "The " + String(t).slice(0, 80) + " geometry has no mechanical change proposal.");
        }
      }
    }
    if (skipped) notes.push(skipped + " IDX item" + (skipped === 1 ? "" : "s") + " (bends, vias, board areas, other outlines) were read but have nothing to propose.");
    return design;
  }
  function area(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  function bounds(P) { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of P) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); } return b; }
  const ring = (c, r) => M().projectArc(c, r, 0, 360, 16, 128).slice(0, -1);
  // Points along the arc a -> m -> b (Y up), ending at b; a straight line when the three are collinear.
  function arcPoints(a, m, b) {
    const cc = G.AtriumImportFormats.geom.circle3(a, m, b);
    if (!cc) return [a, b];
    const ang = p => Math.atan2(p[1] - cc.c[1], p[0] - cc.c[0]);
    const a0 = ang(a), am = ang(m), a1 = ang(b), ccw = ((am - a0 + 4 * Math.PI) % (2 * Math.PI)) < ((a1 - a0 + 4 * Math.PI) % (2 * Math.PI));
    let sw = ccw ? (a1 - a0 + 4 * Math.PI) % (2 * Math.PI) : -((a0 - a1 + 4 * Math.PI) % (2 * Math.PI));
    if (Math.abs(sw) < 1e-9) sw = ccw ? 2 * Math.PI : -2 * Math.PI;
    const degrees = 180 / Math.PI, out = M().projectArc(cc.c, cc.r, a0 * degrees, sw * degrees, 2, 1024);
    out[0] = a; out[out.length - 1] = b;
    return out;
  }
  function validate(input) {
    const x = X(), tree = typeof input === "string" ? x.parse(input, {prefixes: NS}) : input;
    return x.validate(tree, SCHEMA);
  }
  return Object.freeze({NS, SCHEMA, GEOMETRY_TYPES, UNITS, baseline, changes, response, read, validate, footprintOutline, bendZone, arcPoints});
})();
