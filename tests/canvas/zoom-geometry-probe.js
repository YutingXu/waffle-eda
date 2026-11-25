"use strict";

// Shared by Chrome and the real WKWebView. The gesture uses the editor's wheel
// handler. Capture each render before WebGL discards its back buffer, then draw
// an independent, uncached Canvas 2D reference at exactly the captured camera.
globalThis.atriumZoomGeometry = async function ({fixtures = [], renderers = ["gpu", "2d"], cases, evidence, frameImages, screen, presentationOnly = false, warmGPU = false, mutations = [], nativeBoard, synthetic = true} = {}) {
  const H = AtriumNavHost, PCB = AtriumPCBAppearance;
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, description) {
    for (let i = 0; i < 240; i++) {
      if (check()) return;
      await wait(50);
    }
    throw new Error("Timed out waiting for " + description);
  }
  const act = detail => dispatchEvent(new CustomEvent("atrium-command", {detail}));
  const rgb = hex => hex.match(/[a-f\d]{2}/gi).map(n => parseInt(n, 16));
  const mix = (a, b, alpha) => a.map((v, i) => v * alpha + b[i] * (1 - alpha));
  const distance = (a, b, i) => Math.max(Math.abs(a[i] - b[0]), Math.abs(a[i + 1] - b[1]), Math.abs(a[i + 2] - b[2]));
  const corners = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const D = () => AtriumPCBDraw;
  await AtriumLazy.need(["AtriumCanvasGPU", "AtriumPCBDraw", "AtriumBoardShape", "AtriumPolygonPour", "AtriumViaStack", "AtriumCamera"]);
  const GPU = AtriumCanvasGPU;
  document.documentElement.setAttribute("data-motion", "off");
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  globalThis.AtriumDRCMarkers?.setVisible?.(false, H);
  globalThis.confirm = () => true;

  const movingScreenCases = ["caption-crossover", "R1-and-SIG", "clipped-band-coverage"];
  const settledScreenCases = ["all", "reversal"];
  if (presentationOnly && (!screen || frameImages || mutations.length))
    throw new Error("The presentation replay requires a capture adapter and a separate full buffer replay.");
  function syntheticBoard() {
    const B = AtriumBoardShape;
    const shape = B.fromPolygon(corners(0, 0, 70, 44));
    shape.cutouts = [B.fromPolygon(corners(25, 1, 31, 5)).contour];
    const closed = (layer, points, more = {}) => ({kind: "path", layer, points, width: .64, closed: true, ...more});
    const footprint = {shapes: [
      closed("Mechanical 15", corners(-4, -4, 4, 4)),
      closed("Mechanical 13", corners(-3, -2.7, 3, 2.7)),
      closed("Mechanical 5", corners(-2, -1.4, 2, 1.4), {style: "package", fill: true}),
      closed("Silk", corners(-1.2, -.45, 1.2, .45)),
      closed("Mechanical 6", corners(7, -2.8, 14, 2.8), {cutout: true}),
      closed("Keepout", corners(16, -2.8, 23, 2.8), {keepout: true, fill: true})
    ], pads: [{x: 0, y: 7, w: 2.4, h: 1.9, shape: "rect", number: "1"}]};
    const p = Atrium.project("Zoom geometry", [{id: "fixture-footprint", name: "Diagnostic footprint", footprint}]);
    const d = p.documents.find(x => x.kind === "pcb");
    d.name = "Zoom geometry";
    B.apply(d, shape);
    const segment = (id, kind, layer, points, width = .7) => ({id, kind, layer, width, points});
    d.items = [
      {id: "fixture-part", kind: "part", def: "fixture-footprint", x: 12, y: 12, layer: "Top", showRef: false},
      segment("fixture-track", "track", "Top", [[8, 30], [22, 30]]),
      segment("fixture-bottom-track", "track", "Bottom", [[9, 33], [21, 33]]),
      {...D().arcItem({c: [42, 16], r: 4, start: 180, sweep: 180}, {id: "fixture-arc", layer: "Top", width: .7}), kind: "track"},
      {id: "fixture-pad", kind: "pad", x: 27, y: 17, w: 2, h: 2, layer: "Top", shape: "rect", net: "FIXTURE"},
      segment("overlapping-track", "track", "Top", [[27.25, 16], [27.25, 18]], .3),
      {id: "fixture-via", kind: "via", x: 25, y: 28, diameter: 3, drill: 1.3, layer: "Multi", fromLayer: "Top", toLayer: "Bottom", ipc4761: "VII"},
      {id: "fixture-drilled-pad", kind: "pad", x: 31, y: 28, w: 3, h: 3, drill: 1.5, layer: "Multi", shape: "round"},
      {id: "fixture-thermal-pad", kind: "pad", x: 47, y: 29, w: 2, h: 2, layer: "Top", shape: "rect"},
      D().dimensionItem("linear", [[35, 40], [47, 40]], {id: "fixture-dimension", layer: "Top", width: .55, offset: -3, textHeight: .85}),
      D().keepoutItem({type: "region", points: corners(32, 19, 38, 25)}, {id: "fixture-rule-area", layer: "Top"}),
      D().fillItem([33, 32], [37, 35], {id: "fixture-fill", layer: "Silk"}),
      D().lineItem([[29, 20.5], [32, 20.5]], {id: "fixture-fine-silk", layer: "Silk", width: .1}),
      D().fillItem([43, 18], [46, 21], {id: "fixture-mask", layer: "Top mask"}),
      D().fillItem([48, 17], [51, 20], {id: "fixture-paste", layer: "Top paste"}),
      D().fillItem([53, 13], [56, 16], {id: "fixture-back-silk", layer: "Bottom silk"})
    ];
    // The retained copper has a true void and four 0.6 mm thermal spokes around a pad.
    // Four separate voids leave the cross in the pour itself, not a second copper object.
    const holes = [corners(52, 27, 57, 32)];
    for (const x of [-2, .3]) for (const y of [-2, .3]) holes.push(corners(47 + x, 29 + y, 47 + x + 1.7, 29 + y + 1.7));
    const pours = [AtriumPCBPours.region([corners(41, 24, 61, 35), ...holes], "Top", "")];
    d.pcbDrawing = {pours};
    d.sourcePourSignature = AtriumPCBPours.signature(d, new Map(p.library.map(def => [def.id, def])));
    return {p, d};
  }

  // These coordinates are authored independently of queries, caches, GPU buffers
  // or the reference raster. Each region sees one named feature with clear space
  // around it. Void witnesses check the hole and a nearby copper/edge witness
  // checks that the whole surrounding object has not vanished.
  const witnesses = [
    {name: "courtyard", at: [8, 10], layer: "Mechanical 15"},
    {name: "fabrication-assembly", at: [9, 12], layer: "Mechanical 13"},
    {name: "component-outline", at: [10, 12], layer: "Mechanical 5"},
    {name: "footprint-silk", at: [12, 11.55], layer: "Silk"},
    {name: "footprint-cutout", at: [22.5, 9.2], radius: 1.3, layer: "Mechanical 6", dashed: true},
    {name: "footprint-keepout", at: [31.5, 12], radius: 2, layer: "Keepout", dashed: true},
    {name: "footprint-pad", at: [12, 19], layer: "Top"},
    {name: "board-edge", at: [17, 0], system: "edge"},
    {name: "cutout-edge", at: [28, 1], system: "edge"},
    {name: "cutout-void", at: [28, 3], system: "workspace"},
    {name: "track", track: true, id: "fixture-track", at: [16, 30], layer: "Top"},
    {name: "bottom-track", track: true, at: [15, 33], layer: "Bottom"},
    {name: "arc", track: true, at: [42, 12], layer: "Top"},
    {name: "free-pad", at: [26.55, 17], layer: "Top", radius: .25},
    {name: "via-ring", at: [26.15, 28], layer: "Multi", radius: .3},
    {name: "via-hole", at: [25, 28], layer: "Multi", system: "hole", radius: .3, maxScale: 4.25},
    {name: "via-manufacturing-mark", at: [25, 28], layer: "Multi", ink: "#b58a4c", radius: .3, authoredLod: 6 / 1.3},
    {name: "pad-hole", at: [31, 28], layer: "Multi", system: "padHole", radius: .35},
    {name: "pad-ring", at: [32.05, 28], layer: "Multi", radius: .3},
    {name: "pour", at: [58, 25], layer: "Top", pour: true},
    {name: "pour-hole", at: [54, 29], layer: "Top", system: "board", radius: .7},
    {name: "thermal-spoke", at: [48.5, 29], layer: "Top", pour: true, radius: .3},
    {name: "thermal-gap", at: [48.5, 30.5], layer: "Top", system: "board", radius: .4},
    {name: "layer-keepout", at: [35, 23], radius: 1.5, layer: "Top", dashed: true},
    {name: "dimension", at: [38, 37], layer: "Top"},
    {name: "graphic-fill", at: [35, 33.5], layer: "Silk"},
    {name: "mask", at: [44.5, 19.5], layer: "Top mask"},
    {name: "paste", at: [49.5, 18.5], layer: "Top paste"},
    {name: "back-silk", at: [54, 14], layer: "Bottom silk"}
  ];

  // These coordinates are the named R1 and SIG primitives in demo.kicad_pcb.
  const kiCadWitnesses = [
    {name: "R1 courtyard", at: [20.73, 15.4], layer: "Mechanical 15", radius: .15, minScale: 9, coveredByPour: "Bottom"},
    {name: "R1 fabrication", at: [20.4, 15.27], layer: "Mechanical 13", radius: .13, minScale: 9, coveredByPour: "Bottom"},
    {name: "SIG track", at: [20, 18], layer: "Top", radius: .25, minScale: 4},
    {name: "SIG arc", at: [21.464466, 23.535534], layer: "Top", radius: .25, minScale: 4},
    {name: "GND pour", at: [23, 22], layer: "Bottom", pour: true, radius: .3, minScale: 4}
  ];

  const out = {dpr: devicePixelRatio, device: null, mutations, boards: {}, failures: [], rendererErrors: []};
  let transaction = 0;
  // Power/visibility and hardware checks describe the shipping decision. A
  // renderer accidentally falling back in the middle of the replay is a failure.
  const openSynthetic = async () => {
    const {p, d} = syntheticBoard();
    await H.replaceProject(p, {force: true});
    H.selectDocument(d.id);
  };
  async function openFixture(fixture) {
    const file = new File([Uint8Array.from(atob(fixture.data), c => c.charCodeAt(0))], fixture.name);
    const before = H.project();
    const opening = H.openFiles([file]);
    const accept = setInterval(() => {
      const draft = document.querySelector('dialog.foreign-import-close[open] button[data-choice="discard"]:not(:disabled)');
      const replace = [...document.querySelectorAll("dialog[open] button")].find(b => ["Open here", "Replace project", "Don’t Save"].includes(b.textContent.trim()));
      (draft || replace)?.click();
    }, 60);
    try {
      await until(() => H.project() !== before && H.project()?.documents.some(d => d.kind === "pcb" && d.items.length > 10), "import of " + fixture.name);
      if (await Promise.race([opening, wait(3000)]) === false) throw new Error("Failed to open " + fixture.name);
    } finally { clearInterval(accept); }
    for (const tab of document.querySelectorAll(".view-tab-close")) tab.click();
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
    H.selectDocument(H.project().documents.find(d => d.kind === "pcb" && d.items.length > 10).id);
  }

  function raster(cv) {
    const g = cv.getContext("2d", {willReadFrequently: true});
    const {width, height} = cv;
    return {width, height, data: g.getImageData(0, 0, width, height).data};
  }
  function ink(w, opts) {
    if (w.ink) return rgb(w.ink);
    if (w.system) return rgb(PCB.system[w.system]);
    if (w.id && (opts.selected === w.id || opts.selectedIds?.has(w.id))) return rgb(PCB.system.selection);
    const layer = w.name === "via-ring" ? opts.layer : w.layer;
    const tint = rgb(opts.layerMode === "dim" && layer !== opts.layer && layer !== "Multi" ? PCB.system.dim : PCB.color(layer));
    if (w.coveredByPour) return mix(rgb(PCB.color(w.coveredByPour)), tint, PCB.opacity.pour);
    const alpha = PCB.layerAlpha(w.layer) * (w.pour ? PCB.opacity.pour : w.track ? PCB.opacity.track : 1);
    return alpha === 1 ? tint : mix(tint, rgb(PCB.system.board), alpha);
  }
  function count(r, b, color, tolerance) {
    let n = 0;
    for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++)
      if (distance(r.data, color, (y * r.width + x) * 4) <= tolerance) n++;
    return n;
  }
  function regions(geometry, cam, r) {
    const [cx, cy, scale, flipped, width, height, dpr] = cam;
    return geometry.flatMap(w => {
      if (scale < (w.minScale || 1.5) || scale > (w.maxScale || Infinity)) return [];
      // Inside the threshold's AA margin the disc can be partial. Elsewhere
      // enforce both its absence below and its presence above the authored LOD.
      if (w.authoredLod && Math.abs(scale - w.authoredLod) < .38) return [];
      const x = (flipped ? cx - w.at[0] : w.at[0] - cx) * scale + width / 2;
      const y = (w.at[1] - cy) * scale + height / 2;
      const rad = Math.min(32, Math.max(3, (w.radius || .55) * scale * dpr));
      const b = [Math.floor(x * dpr - rad), Math.floor(y * dpr - rad), Math.ceil(x * dpr + rad), Math.ceil(y * dpr + rad)];
      return b[0] < 0 || b[1] < 0 || b[2] >= r.width || b[3] >= r.height ? [] : [[w, b]];
    });
  }
  function featurePixels(r, ref, cam, opts, row, geometry) {
    const scale = cam[2], results = {};
    for (const [w, b] of regions(geometry, cam, r)) {
      const layerShown = !w.layer || !opts.hidden.has(w.layer) && (opts.layerMode !== "single" || w.layer === opts.layer || w.layer === "Multi");
      const boardShown = !opts.hidden.has("Board");
      const visible = w.system === "workspace" ? boardShown : w.system === "edge" ? boardShown :
        layerShown && !(opts.hidden.has("Source pours") && w.pour) && (!w.authoredLod || scale >= w.authoredLod);
      // In dim mode each nonactive layer shares one ink. Dedicated all-layer
      // frames distinguish them, while the Top keepout/dimension still have
      // distinct witnesses in the caption crossover sequence.
      const color = ink(w, opts);
      const tolerance = w.dashed ? 36 : 28;
      const expected = count(ref, b, color, tolerance);
      const actual = count(r, b, color, tolerance);
      const enough = w.dashed ? 5 : 3;
      const result = results[w.name] = {expected, actual, visible, at: w.at, bounds: b};
      if (w.authoredLod && (expected >= enough) !== visible) result.oracleLod = true;
      if (visible && expected >= enough) {
        row.checked[w.name] = (row.checked[w.name] || 0) + 1;
        // Stroke rasterisation can be filtered during the legacy 2D gesture,
        // especially for dashed boundaries. Require substantial retained ink
        // for ordinary strokes and at least one visible dash for dashed shapes.
        if (actual < (w.dashed ? 1 : Math.max(1, Math.ceil(expected * .12)))) result.loss = true;
      } else if (!visible && !w.system && expected < enough) {
        row.hidden[w.name] = (row.hidden[w.name] || 0) + 1;
        if (actual >= Math.max(5, expected * 3)) result.extra = true;
      }
    }
    return results;
  }

  function fineSilk(actual, expected, cam) {
    const region = regions([{at: [30.5, 20.5], radius: .15}], cam, expected)[0];
    if (!region) return null;
    const [, [x0, y0, x1, y1]] = region, x = Math.floor((x0 + x1) / 2);
    // Independently measure the partial-coverage fringe around the thin
    // horizontal line. Scaling an old raster widens its antialiased edges.
    const peak = mix(rgb(PCB.color("Silk")), rgb(PCB.system.board), PCB.layerAlpha("Silk"))[0];
    const profile = pixels => {
      let fringe = 0, core = 0;
      for (let y = y0; y < y1; y++) {
        const red = pixels.data[(y * pixels.width + x) * 4];
        if (red >= peak - 12) core++;
        else if (red > 12) fringe++;
      }
      return {fringe, core};
    };
    const a = profile(actual), e = profile(expected);
    return {actual: a, expected: e, loss: e.core < 3 || a.core < 3 || a.fringe > e.fringe + 4};
  }

  function realPixels(actual, expected, row) {
    const board = rgb(PCB.system.board);
    const layers = ["Top", "Bottom", "Multi", "Silk", "Bottom silk", "Mechanical", "Top mask", "Top paste", "Bottom mask"];
    const pours = ["Top", "Bottom"].map(layer => {
      const color = mix(rgb(PCB.color(layer)), board, PCB.opacity.pour);
      const influence = color.map((v, i) => Math.abs(v - board[i]));
      return [layer + " pour", color, influence.indexOf(Math.max(...influence))];
    });
    const flat = [...layers.map(layer => [layer, rgb(PCB.color(layer))]), ...pours];
    const results = {};
    for (const [name] of flat) results[name] = {expected: 0, actual: 0, visible: true};
    const {width, height, data} = expected;
    // An interior comparison is independent of the production primitive
    // counting path. Take the closest matching color within 2 device pixels to
    // absorb legitimate tessellation, shader AA and fractional-pixel changes.
    // The browser can blend the other layer's color into a thin shared edge
    // during a zoom. Identify copper by its own channel once the exact frame
    // establishes a solid core, separately from that background contribution.
    for (let y = 4; y < height - 4; y += 7) for (let x = 4; x < width - 4; x += 7) {
      const i = (y * width + x) * 4;
      const cls = flat.find(([, c]) => distance(data, c, i) < 12 &&
        distance(data, c, i - 4) < 20 && distance(data, c, i + 4) < 20 &&
        distance(data, c, i - 4 * width) < 20 && distance(data, c, i + 4 * width) < 20);
      if (!cls) continue;
      const result = results[cls[0]];
      result.expected++;
      let found = false;
      const [, color, channel] = cls;
      for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2; dx++) {
        const at = i + (dy * width + dx) * 4;
        const diff = channel === undefined ? distance(actual.data, color, at) : Math.abs(actual.data[at + channel] - color[channel]);
        if (diff < 55) { found = true; break; }
      }
      if (found) result.actual++;
    }
    for (const [name, result] of Object.entries(results)) {
      if (result.expected < 16) { delete results[name]; continue; }
      row.checked[name] = (row.checked[name] || 0) + 1;
      if (result.actual < result.expected * .66) result.loss = true;
    }
    return results;
  }

  const wheel = (canvas, dy, xf, yf, mode) => {
    const b = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent("wheel", {clientX: b.left + xf * b.width, clientY: b.top + yf * b.height,
      deltaY: dy, deltaMode: mode, ctrlKey: mode === 0, bubbles: true, cancelable: true}));
  };

  async function runBoard(name, authored) {
    await until(() => H.doc()?.kind === "pcb" && H.doc().items?.length > 10 && H.canvas()?.width, "PCB view");
    act("fit");
    await wait(650);
    const v = H.view(), cv = H.canvas(), I = v.internals();
    const originalCamera = v.camera(), originalView = H.captureViewState(), render = v.render, moving = v.moving;
    const refCanvas = document.createElement("canvas"), refView = AtriumCanvas.create(refCanvas);
    refCanvas.getBoundingClientRect = () => cv.getBoundingClientRect();
    const spots = authored ? witnesses : name === "demo.kicad_pcb" ? kiCadWitnesses : [];
    const layerAlpha = ["Top", "Silk"].map(layer => [layer, PCB.layerAlpha(layer)]);
    const board = out.boards[name] = {items: H.doc().items.length, namedFeatures: spots.map(w => w.name), renders: {}};
    out.device ||= AtriumCanvasGPUPref?.decision?.();
    for (const renderer of renderers) {
      if (renderer === "gpu" && !out.device?.use) {
        board.renders.gpu = {skipped: "no hardware WebGL2"};
        continue;
      }
      GPU.enable(renderer === "gpu");
      H.redraw(true);
      await wait(700);
      const opts0 = {grid: false, origin: false, showUnrouted: false};
      const {width, height} = cv.getBoundingClientRect();
      const coverageScale = 65;
      const diag = authored ? [
        {name: "all", cx: 35, cy: 22, scale: 4, steps: [44, 44, 44, -46, -46, -46, -46, -46, 42, 42, 42], cursor: [.49, .54]},
        {name: "flipped-hidden", cx: 35, cy: 22, scale: 5, flipped: true, hidden: ["Top mask", "Mechanical 13", "Bottom", "Source pours"],
          steps: [-44, -44, 44, 44, 44, -44, -44, -44, 44, 44], cursor: [.59, .42]},
        // Track and fill are outside even the half-scale cache. The first
        // wheel brings both into view with translucent layer ordering active.
        {name: "clipped-band-coverage", cx: 16 + 1.15 * width / coverageScale, cy: 33.5 - 1.15 * height / coverageScale,
          scale: coverageScale, flipped: true, layerAlpha: .65,
          steps: [120, 65, [-120, -120], -65, 120, -120], cursor: [.5, .5]},
        {name: "caption-crossover", cx: 35, cy: 24, scale: 11, layerMode: "single", steps: [32, 32, 32, 32, 32, 32, -32, -32, -32, -32, -32, -32, -32], cursor: [.5, .5]},
        {name: "top-dim-opacity", cx: 38, cy: 25, scale: 8, opacity: .55, layerMode: "dim", steps: [44, 44, -48, -48, -48, 44, 44, 44], cursor: [.49, .49]},
        {name: "min-scale", cx: 35, cy: 22, scale: .00016, steps: [3, 3, 3, -3, -3, -3, 3, 3, 3], cursor: [.5, .5], line: true},
        {name: "max-scale", cx: 16, cy: 30, scale: 1800, selected: ["fixture-track"], steps: [-3, -3, -3, 3, 3, 3, -3, -3, -3], cursor: [.5, .5], line: true}
      ] : [
        {name: "reversal", ...originalCamera, scale: originalCamera.scale * 2.5,
          steps: [49, 49, 49, 49, -48, -48, -48, -48, -48, -48, 49, 49, 49, 49, 49], cursor: [.62, .44]},
        {name: "flipped", ...originalCamera, scale: originalCamera.scale * 3, flipped: true,
          steps: [49, 49, 49, -49, -49, -49, -49, -49, 49, 49, 49, 49, 49], cursor: [.4, .56]},
        ...(spots.length ? [{name: "R1-and-SIG", cx: 21, cy: 18, scale: 30,
          steps: [42, 42, 42, -44, -44, -44, -44, -44, 44, 44], cursor: [.49, .56]}] : [])
      ];
      const rows = board.renders[renderer] = [];
      try {
        for (const step of diag.filter(step => (!presentationOnly || movingScreenCases.includes(step.name) || settledScreenCases.includes(step.name)) &&
            (!cases || cases.includes(step.name)))) {
          const row = {name: step.name, frames: [], checked: {}, movingChecked: {}, hidden: {}, screens: [], staleScreens: 0};
          rows.push(row);
          PCB.setOpacity("track", step.opacity ?? 1);
          for (const [layer, alpha] of layerAlpha)
            if (PCB.layerAlpha(layer) !== (step.layerAlpha ?? alpha)) PCB.setLayerOpacity(layer, step.layerAlpha ?? alpha);
          if (!H.applyViewState({...originalView,
            camera: {...originalCamera, cx: step.cx, cy: step.cy, scale: step.scale, flipped: !!step.flipped},
            layers: {active: "Top", mode: step.layerMode || "all", hidden: step.hidden || []},
            selection: step.selected || []
          })) throw new Error("Could not set the editor's view state for " + step.name);
          let mark = false, active = false, pending = 0, target = null, shown = null, injected = 0;
          let inputIndex = -1, capture = null, display, scaleBeforeBurst;
          const watchMoving = movingScreenCases.includes(step.name);
          const coverageWitnesses = step.name === "clipped-band-coverage" ? ["track", "graphic-fill"] : [];
          const screenInput = i => coverageWitnesses.length ? i === 0 : i >= 2 && i <= 4;
          const coverage = (matches, where) => {
            const witnesses = {};
            for (const feature of coverageWitnesses) {
              const witness = matches[feature];
              if (!witness || witness.expected < 3 || witness.actual < 3 || witness.loss)
                out.failures.push([name, renderer, step.name, where, feature]);
              witnesses[feature] = witness ?? null;
            }
            return witnesses;
          };
          let start = 0;
          const actualCanvas = document.createElement("canvas"), frameEvidence = [];
          v.moving = function (...args) { mark = true; return moving.apply(this, args); };
          v.render = function (doc, defs, opts) {
            const isMoving = mark;
            mark = false;
            const camera = v.camera();
            const o = {...opts, ...opts0, overlay: null};
            const ans = render.call(this, doc, defs, o);
            if (!active) return ans;
            const cam = I.cam();
            const status = GPU.status(I);
            const source = presentationOnly ? null : renderer === "gpu" ? GPU.composite(I) : cv;
            const result = {n: row.frames.length, ms: +(performance.now() - start).toFixed(2), moving: isMoving, renderer: status.renderer, camera: cam.slice(0, 4)};
            const notes = isMoving ? row.movingChecked : row.checked;
            row.frames.push(result);
            // WindowServer can still hold an earlier WebKit transaction even
            // when this JS-side buffer is current. Stamp an unused corner of
            // the editor's top surface to associate the physical screenshot
            // with the frame that supplied its independent reference.
            const serial = presentationOnly ? transaction++ : result.n;
            const stamp = screen && [71 + (serial * 61) % 163, 47 + (serial * 37) % 176, 201 - serial % 113];
            if (stamp) {
              const top = cv.getContext("2d");
              top.save();
              top.setTransform(1, 0, 0, 1, 0, 0);
              top.globalAlpha = 1;
              top.globalCompositeOperation = "source-over";
              top.fillStyle = "rgb(" + stamp.join(",") + ")";
              top.fillRect(12, 12, 8, 8);
              top.restore();
            }
            shown = {result, o, cam, stamp, camera, doc, defs, width: cv.width, height: cv.height};
            if ((!presentationOnly && !source) || result.renderer !== renderer) {
              const reason = status.reason || "missing rendered surface";
              result.rendererReason = reason;
              out.failures.push([name, renderer, step.name, result.n, "renderer", reason]);
              return ans;
            }
            if (presentationOnly) {
              // Ask the host to capture the moving transaction while it is
              // being published. Readbacks and the oracle run after the photo
              // has matched the actual stamp for this camera.
              if (watchMoving && isMoving && screenInput(inputIndex) && !capture &&
                  !row.screens.some(s => s.moving)) capture = display(shown);
              return ans;
            }
            if (actualCanvas.width !== source.width) actualCanvas.width = source.width;
            if (actualCanvas.height !== source.height) actualCanvas.height = source.height;
            const g = actualCanvas.getContext("2d", {willReadFrequently: true});
            g.globalCompositeOperation = "copy";
            g.drawImage(source, 0, 0);
            const mutation = mutations[injected];
            if (mutation && authored && renderer === "gpu" && step.name === "all" && isMoving) {
              const regionsToDrop = regions(witnesses.filter(w => w.name === mutation), cam, actualCanvas);
              if (regionsToDrop.length || mutation === "one-frame") {
                g.globalCompositeOperation = "source-over";
                g.fillStyle = PCB.system.board;
                for (const [, b] of regionsToDrop) g.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
                if (mutation === "one-frame") g.fillRect(0, 0, actualCanvas.width, actualCanvas.height);
                result.mutated = mutation;
                injected++;
              }
            }
            const {reuseBase, editorPane, ...oracleOpts} = o;
            refView.restoreCamera(camera);
            refView.render(doc, defs, {...oracleOpts, noReuse: true});
            const actual = raster(actualCanvas), expected = raster(refCanvas);
            if (frameImages && evidence) {
              const key = name + "-" + renderer + "-" + step.name + "-frame-" + String(result.n).padStart(3, "0");
              frameEvidence.push([key, actualCanvas.toDataURL(), refCanvas.toDataURL(), result]);
            }
            const matches = {
              ...(!authored && realPixels(actual, expected, {checked: notes})),
              ...featurePixels(actual, expected, cam, o, {checked: notes, hidden: row.hidden}, spots)
            };
            if (step.name === "caption-crossover") {
              const direct = ["layer-keepout", "dimension", "via-manufacturing-mark"];
              result.witnesses = Object.fromEntries(direct.map(name => [name, matches[name] ?? null]));
            }
            if (isMoving && inputIndex === 0 && coverageWitnesses.length)
              result.witnesses = coverage(matches, result.n);
            if (isMoving && scaleBeforeBurst && cam[2] / scaleBeforeBurst > 3 && renderer === "gpu") {
              result.sharpness = fineSilk(actual, expected, cam);
              if (!result.sharpness || result.sharpness.loss)
                out.failures.push([name, renderer, step.name, result.n, "magnified Silk edge"]);
            }
            const lost = Object.entries(matches).filter(([, m]) => m.loss || m.extra || m.oracleLod);
            if (lost.length) {
              result.loss = Object.fromEntries(lost);
              out.failures.push([name, renderer, step.name, result.n, ...lost.map(([name]) => name)]);
              const key = name + "-" + renderer + "-" + step.name + (isMoving ? "-moving" : "-exact");
              if (evidence && result.mutated) {
                (row.mutationImages ||= []).push([key + "-" + result.mutated, actualCanvas.toDataURL(), refCanvas.toDataURL(), result]);
              } else if (evidence && !target) target = [key, actualCanvas.toDataURL(), refCanvas.toDataURL(), result];
            }
            return ans;
          };
          H.redraw(true);
          await wait(350);
          if (warmGPU && renderer === "gpu")
            await until(() => GPU.status(I).renderer === "gpu" && !!GPU.composite(I),
              "compositable GPU surface before " + step.name);
          start = performance.now();
          active = true;
          H.redraw(true);
          await frame(); await frame();
          display = async (present = shown) => {
            if (!screen || !present) return;
            const b = cv.getBoundingClientRect();
            const clip = {x: Math.ceil(b.left), y: Math.ceil(b.top), width: Math.floor(b.width) - 2, height: Math.floor(b.height) - 2};
            const grab = await screen(clip, {moving: present.result.moving, n: present.result.n});
            if (!presentationOnly && shown !== present) return;
            const img = new Image();
            img.src = "data:image/png;base64," + grab.png;
            await img.decode();
            if (!presentationOnly && shown !== present) return;
            const size = [img.naturalWidth, img.naturalHeight];
            if (size[0] !== clip.width * devicePixelRatio || size[1] !== clip.height * devicePixelRatio) {
              out.failures.push([name, renderer, step.name, "screen backing size", ...size]);
              return;
            }
            // Match the backing stores before testing the authored witnesses:
            // snapshot origin is rounded for screenshot APIs that accept CSS
            // pixels while the editor canvas can have a fractional origin.
            const x = Math.round((clip.x - b.left) * devicePixelRatio), y = Math.round((clip.y - b.top) * devicePixelRatio);
            const s = document.createElement("canvas");
            s.width = present.width; s.height = present.height;
            s.getContext("2d", {willReadFrequently: true}).drawImage(img, x, y);
            const pixels = raster(s);
            const markerOffset = (15 * pixels.width + 15) * 4;
            if (present.stamp && distance(pixels.data, present.stamp, markerOffset) > 12) {
              row.staleScreens++;
              return;
            }
            if (presentationOnly) {
              const {reuseBase, editorPane, ...oracleOpts} = present.o;
              refView.restoreCamera(present.camera);
              refView.render(present.doc, present.defs, {...oracleOpts, noReuse: true});
            }
            const reference = raster(refCanvas);
            if (pixels.width !== reference.width || pixels.height !== reference.height) {
              out.failures.push([name, renderer, step.name, "different screenshot and reference backing sizes"]);
              return;
            }
            const matches = {
              ...(!authored && realPixels(pixels, reference, {checked: {}})),
              ...featurePixels(pixels, reference, present.cam, present.o, {checked: {}, hidden: {}}, spots)
            };
            const loss = Object.entries(matches).filter(([, m]) => m.loss || m.extra || m.oracleLod);
            const receipt = {n: present.result.n, moving: present.result.moving, source: grab.source, pixels: size, loss: Object.fromEntries(loss)};
            if (presentationOnly || coverageWitnesses.length) {
              receipt.camera = present.result.camera;
              receipt.stamp = [...pixels.data.slice(markerOffset, markerOffset + 3)];
            }
            if (presentationOnly) {
              const positive = Object.entries(matches).filter(([, w]) => w.at && w.visible && w.expected >= 3 && w.actual > 0 && !w.loss);
              receipt.witnesses = Object.fromEntries(positive);
              const realFeatures = ["R1 courtyard", "SIG track"];
              if ((spots.length && !positive.length) || step.name === "R1-and-SIG" &&
                  realFeatures.some(feature => !receipt.witnesses[feature]))
                out.failures.push([name, renderer, step.name, "no positive named feature in the stamped screenshot"]);
            }
            if (present.result.moving && coverageWitnesses.length) receipt.witnesses = coverage(matches, "screen");
            row.screens.push(receipt);
            if (loss.length) out.failures.push([name, renderer, step.name, "screen", ...loss.map(([name]) => name)]);
            const captureName = name + "-" + renderer + "-" + step.name + "-screen";
            if (evidence) await evidence(presentationOnly ? captureName + "-frame-" + receipt.n : captureName,
              s.toDataURL(), refCanvas.toDataURL(), present.result);
          };
          for (let i = 0; i < step.steps.length; i++) {
            const previous = row.frames.length;
            inputIndex = i;
            const deltas = step.steps[i];
            scaleBeforeBurst = Array.isArray(deltas) ? v.camera().scale : null;
            for (const delta of [].concat(deltas)) wheel(cv, delta, ...step.cursor, step.line ? 1 : 0);
            await frame(); await frame();
            if (row.frames.length === previous) pending++;
            if (capture) { await capture; capture = null; }
            if (!presentationOnly && screenInput(i) && watchMoving && !row.screens.some(s => s.moving)) {
              await display();
              if (!row.screens.some(s => s.moving)) { await frame(); await display(); }
            }
          }
          await wait(250);
          await frame(); await frame();
          row.idle = row.frames.at(-1)?.moving === false;
          v.settle();
          H.redraw(true);
          await frame(); await frame();
          if (settledScreenCases.includes(step.name)) {
            await display();
            if (presentationOnly && !row.screens.some(s => !s.moving))
              out.failures.push([name, renderer, step.name, "no settled screen snapshot matched its camera"]);
          }
          const motions = row.frames.filter(f => f.moving);
          const scales = motions.map(f => f.camera[2]);
          const direction = scales.slice(1).map((s, i) => Math.sign(s - scales[i]));
          if (motions.length + pending < step.steps.length || !direction.includes(-1) || !direction.includes(1) || row.frames.at(-1)?.moving !== false)
            out.failures.push([name, renderer, step.name, "missing moving, reversal or settled frame"]);
          if (step.name === "min-scale" && !scales.some(s => Math.abs(s - .0001) < 1e-9) ||
              step.name === "max-scale" && !scales.includes(2000))
            out.failures.push([name, renderer, step.name, "zoom did not reach clamp"]);
          if (screen && watchMoving && !row.screens.some(s => s.moving))
            out.failures.push([name, renderer, step.name, "no moving screen snapshot matched its camera"]);
          if (!presentationOnly && renderer === "gpu" && coverageWitnesses.length && !row.frames.some(f => f.sharpness))
            out.failures.push([name, renderer, step.name, "no usable Silk edge above 3× magnification"]);
          row.clampedInputs = pending + direction.filter(d => d === 0).length;
          row.final = v.camera();
          active = false;
          if (target) await evidence(...target);
          for (const args of row.mutationImages || []) await evidence(...args);
          for (const args of frameEvidence) await evidence(...args);
          delete row.mutationImages;
        }
      } finally {
        v.render = render;
        v.moving = moving;
        PCB.setOpacity("track", 1);
        for (const [layer, alpha] of layerAlpha)
          if (PCB.layerAlpha(layer) !== alpha) PCB.setLayerOpacity(layer, alpha);
      }
      for (const w of cases || presentationOnly ? [] : spots) {
        if (!rows.some(row => (row.movingChecked[w.name] || 0) >= 2 && (row.checked[w.name] || 0) >= 1))
          out.failures.push([name, renderer, "no usable moving and settled witness", w.name]);
      }
    }
  }

  const originalError = console.error;
  console.error = function (...args) {
    if (String(args[0]).includes("GPU board renderer"))
      out.rendererErrors.push(args.map(arg => arg?.stack || String(arg)).join("\n").slice(0, 4000));
    originalError.apply(console, args);
  };
  try {
    if (nativeBoard) {
      const pcb = H.project()?.documents.find(d => d.kind === "pcb" && !d.missing);
      if (!pcb) throw new Error("The open native project has no PCB.");
      H.selectDocument(pcb.id);
      await runBoard(nativeBoard, false);
    }
    if (synthetic) { await openSynthetic(); await runBoard("synthetic", true); }
    for (const fixture of fixtures) { await openFixture(fixture); await runBoard(fixture.name, false); }
    return out;
  } finally {
    console.error = originalError;
  }
};
