"use strict";
// GPU board renderer pixel test (app/canvas/canvas-gpu.js): the composited GPU frame
// (WebGL2 canvas plus the 2D layer above it) against the 2D renderer's exact frame of the same inputs, in the
// real editor. Runs in headless Chrome (scripts/gpu-pixels.sh, over the DevTools protocol) and in WKWebView
// (native/tests/macos-harness/gpu-pixels.sh, through the real Desktop class).
//
// Boards: the 25.6k-object board of tests/pcb/dense-board.js with 64 nets and ten pours (plus objects it lacks:
// stacked, tented, filled, back-drilled, blind and buried vias, a custom pad, large pads), a 900-object board
// whose own pours follow a drag ("pours"), the starter board, and the imported boards the runner hands over in
// globalThis.__gpuFixtures ({file name: base64}): the KiCad demo board and the PiDP-11 I/O Expander (Altium).
// Each is drawn at fit, zoomed in, and close enough for pad numbers and net names, in these cases:
//   base, dim, single (Bottom), flipped, selection (a track, a via, a part), hide (the same left out), highlight, net colours, a light
//   canvas, the high-contrast canvas, board-shape handles, Board Planning, opacity (tracks and pours 0.5,
//   Bottom 0.6), and pourDrag: a frame in the middle of a part drag with live pour tile patches.
//
// Metrics per case:
//   interiorPx  pixels away from the 2D frame's edges (a step over 16 levels to a neighbour, widened by one
//               pixel) whose largest channel differs by more than 24 levels. Anti-aliasing lives on edges;
//               an interior difference is a missing, extra or recoloured object.
//   edgeMean    the mean difference on those edge pixels: a shifted, thinner or reordered object raises it.
//   solidPx     centres of 3×3 blocks all over 48 levels anywhere.
//   c_<class>   interiorPx split by object class (per-class masks from the frames' colours: hole, sel, top, bottom,
//               inner, silk, conn, other), each with its own budget.
//   (over8, over48, meanAbs: for information.)
// Budgets are per case and per host (tests/canvas/gpu-pixels-budgets.json, o.budgets): 1.2 × the real GPU output's
// interiorPx, solidPx and c_* + 6 px, 1.1 × its edgeMean + 0.15, from a calibration run (CALIBRATE=1). The runs are
// deterministic per host (connection lines computed before each view, idle-time 2D indexes built first), so
// the margins can be that tight. Fault injection (FAULTS=all; app/canvas/canvas-gpu.js fault()) proves each budget
// set catches: dropped hole colours, a layer offset by 1 px, a layer out of order, missing pad numbers, wrong
// net colours, missing small vias, selected copper drawn above everything, tracks 10 % thin, unclipped pour
// patches, missing Board Planning. A case without a calibrated budget uses the global fallback (o.budget):
// over8 <= 40 %, over48 <= 6 %, solidPx <= 100. Runs of a subset (BOARDS, VIEWS, CASES) can measure a little
// differently from the full run the budgets come from.
// A failing case returns its 2D, GPU and diff images (red: interior or solid differences, white over 48
// levels, grey over 8).
// Exact signed RGB differences make each admitted raster discrepancy local. Within a
// 64-pixel square a change in position, intensity or colour changes its fingerprint.
const RASTER_TILE = 64;
const rgbDifference = (a, b, i, j = i) => Math.max(Math.abs(a[i]-b[j]), Math.abs(a[i+1]-b[j+1]), Math.abs(a[i+2]-b[j+2]));
function differentPixels(a, b, threshold) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) if (rgbDifference(a,b,i) > threshold) count++;
  return count;
}
function differentBytes(a, b) {
  if (a.length !== b.length) return Math.max(a.length,b.length);
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
}
function rasterResidual(A, B, width, height) {
  const cols = Math.ceil(width / RASTER_TILE), rows = Math.ceil(height / RASTER_TILE);
  const tiles = new Uint32Array(cols * rows).fill(2166136261);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / RASTER_TILE) * cols;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = A[i] - B[i], g = A[i + 1] - B[i + 1], b = A[i + 2] - B[i + 2];
      if (!(r || g || b)) continue;
      const tile = row + Math.floor(x / RASTER_TILE);
      const position = (y % RASTER_TILE) * RASTER_TILE + x % RASTER_TILE;
      const rgb = ((r + 255) << 18) | ((g + 255) << 9) | (b + 255);
      tiles[tile] = Math.imul(Math.imul(tiles[tile] ^ position, 16777619) ^ rgb, 16777619);
    }
  }
  return {width, height, tiles:Array.from(tiles, hash => hash.toString(16).padStart(8, "0")).join("")};
}

function changedRasterTiles(current, expected) {
  if (current.width !== expected.width || current.height !== expected.height || current.tiles.length !== expected.tiles.length)
    return "backing " + current.width + "×" + current.height + " vs " + expected.width + "×" + expected.height;
  const changed = [], cols = Math.ceil(current.width / RASTER_TILE);
  for (let i = 0; i < current.tiles.length; i += 8) {
    if (current.tiles.slice(i, i + 8) === expected.tiles.slice(i, i + 8)) continue;
    const tile = i / 8;
    changed.push([tile % cols * RASTER_TILE, Math.floor(tile / cols) * RASTER_TILE]);
  }
  if (changed.length) return changed.length + " changed 64 px tile(s) at " + changed.slice(0, 8).map(p => p.join(",")).join(" / ");
  return "";
}

// The board layer may retain a padded backing during a resize. Its visible
// bottom-left device rectangle must still line up with the overlay on that draw.
function resizeFrameMismatch(frame, dpr) {
  if (!frame?.readback || !frame.gpu || !frame.gpuCss || !frame.gpuPosition) return "no GPU composite in the first frame";
  const inset = /^inset\(([^()]+)\)$/.exec(frame.clip);
  const sides = frame.clip === "none" || frame.clip === "" ? [0,0,0,0] :
    inset?.[1].trim().split(/\s+/).map(n => n === "0" ? 0 : /^-?(?:\d+(?:\.\d*)?|\.\d+)px$/.test(n) ? parseFloat(n) : NaN);
  if (!sides?.length || sides.length > 4 || sides.some(n => !Number.isFinite(n))) return "unsupported board clip";
  const [top, right = top, bottom = top, left = right] = sides;
  const [w,h] = frame.overlay, [gw,gh] = frame.gpu, [cw,ch] = frame.css;
  const [gx,gy] = frame.gpuPosition, [x,y] = frame.position;
  if (frame.dpr !== dpr || w !== Math.round(cw*dpr) || h !== Math.round(ch*dpr) ||
      gw < w || gh < h || gw !== frame.buffer[0] || gh !== frame.buffer[1] ||
      w !== frame.readback[0] || h !== frame.readback[1] ||
      frame.viewport[0] !== 0 || frame.viewport[1] !== 0 || frame.viewport[2] !== w || frame.viewport[3] !== h)
    return "backing, viewport, readback or DPR mismatch";
  // Allow for two independently quantized CSS layout coordinates.
  const near = (a,b) => Math.abs(a-b) <= 1/32, [gWidth,gHeight] = frame.gpuCss;
  const xUnit = cw/w, yUnit = ch/h;
  if (left || bottom || !near(right,(gw-w)*xUnit) || !near(top,(gh-h)*yUnit) ||
      !near(gWidth,gw*xUnit) || !near(gHeight,gh*yUnit) ||
      !near(gx+left,x) || !near(gy+top,y) ||
      !near(gWidth-left-right,cw) || !near(gHeight-top-bottom,ch))
    return "clipped board layer and overlay disagree";
  return "";
}

function probeHiddenChunk(GPU) {
  const host = document.createElement("div"), canvas = document.createElement("canvas");
  host.style.cssText = "position:fixed;left:-1000px;top:0";
  canvas.style.cssText = "display:block;width:240px;height:160px";
  host.append(canvas); document.body.append(host);
  const view = AtriumCanvas.create(canvas), I = view.internals(), wasEnabled = GPU.enabled();
  const doc = Atrium.sheet("pcb", "Hidden chunk");
  doc.outline = [[-6,-4], [6,-4], [6,4], [-6,4]];
  const track = {id:"moving-track", kind:"track", layer:"Top", width:.45, points:[[0,1.5],[2,1.5]]};
  const part = {id:"stationary-part", kind:"part", layer:"Top", def:"test-footprint", x:1, y:.5, showRef:false};
  const pad = {number:"1", layer:"Top", shape:"rect", x:0, y:0, w:.6, h:.6};
  const defs = new Map([[part.def, {footprint:{shapes:[], pads:[pad]}}]]);
  doc.items = [track, part];
  view.restoreCamera({cx:0, cy:0, scale:20, referenceScale:20});
  const opts = {editorPane:true, noReuse:true, grid:false, origin:false, showUnrouted:false, netNames:false};
  const sample = (gpu, batched, hide) => {
    GPU.enable(gpu); I.lodForce = batched; view.render(doc, defs, {...opts, hide});
    const surface = gpu ? GPU.composite(I) : canvas;
    if (!surface) throw Error("no GPU frame for hidden chunk");
    const dpr = I.cam()[6];
    return [[1,.5], [1,1.5]].map(at => {
      const pixel = view.worldToScreen(at).map(p => Math.floor(p * dpr));
      return [...surface.getContext("2d").getImageData(...pixel, 1, 1).data].join(",");
    });
  };
  try {
    const shown = sample(false, true), lod = I.cache.lod;
    const chunk = lod?.info.get(track)?.chunk;
    if (!I.lodUsed || !chunk || lod.info.get(part)?.chunk !== chunk) throw Error("track and footprint did not share a batch");
    const hide = new Set([track]);
    const batched = sample(false, true, hide), unbatched = sample(false, false, hide), gpu = sample(true, false, hide);
    return {shown, batched, unbatched, gpu};
  } finally {
    GPU.release(I);
    GPU.enable(wasEnabled);
    host.remove();
  }
}

function probeBoardProfile(GPU) {
  const host = document.createElement("div"), canvas = document.createElement("canvas");
  host.style.cssText = "position:fixed;left:-1000px;top:0";
  canvas.style.cssText = "display:block;width:320px;height:240px";
  host.append(canvas); document.body.append(host);
  const view = AtriumCanvas.create(canvas), I = view.internals(), wasEnabled = GPU.enabled();
  const doc = Atrium.sheet("pcb", "Nested profile"), defs = new Map(), S = AtriumBoardShape;
  const shape = S.rect({x:-6, y:5, width:12, height:10});
  const routing = S.fromPolygon([[4,0],[0,4],[-4,0],[0,-4]]).contour;
  const hole = [S.arc([0,0],4,0,0,false)], island = [S.arc([0,0],1.25,90,90,true)];
  S.apply(doc, {...shape, cutouts:[routing]}, "altium");
  doc.boardShape.cutoutRegions = {0:{version:1, contour:hole, cutouts:[island], sig:S.signature(S.flattenContour(doc.boardShape.cutouts[0]))}};
  view.restoreCamera({cx:0, cy:0, scale:20, referenceScale:20});
  const opts = {editorPane:true, noReuse:true, grid:false, origin:false, showUnrouted:false};
  const sample = gpu => {
    GPU.enable(gpu); view.render(doc, defs, opts);
    const surface = gpu ? GPU.composite(I) : canvas;
    if (!surface) throw Error("no GPU frame for nested profile");
    return [[5,3],[2.5,2.5],[0,0],[0,2],[-7,0]].map(point => {
      const pixel = view.worldToScreen(point).map(v => Math.floor(v * I.cam()[6]));
      return [...surface.getContext("2d").getImageData(...pixel,1,1).data].join(",");
    });
  };
  try {
    const coverage = ([board, chord, island, voidColor, workspace]) =>
      [board !== workspace, chord === workspace, island === board, voidColor === workspace];
    return {canvas:coverage(sample(false)), gpu:coverage(sample(true))};
  } finally {
    GPU.release(I); GPU.enable(wasEnabled); host.remove();
  }
}

function probeGpuStrokes(GPU, PCB, doc) {
  const host = document.createElement("div"), canvas = document.createElement("canvas");
  host.style.cssText = "position:fixed;left:-1000px;top:0";
  canvas.style.cssText = "display:block;width:400px;height:270px";
  host.append(canvas); document.body.append(host);
  // Stay on one raster backend for this readback-heavy alpha-mask probe.
  canvas.getContext("2d", {willReadFrequently:true});
  const view = AtriumCanvas.create(canvas), I = view.internals(), defs = new Map();
  const outline = [[-300,-250], [300,-250], [300,250], [-300,250]];
  const witness = {kind:"track", id:"witness", net:"base", layer:"Top", width:.43, points:[[500,500],[501,500]]};
  const board = {...doc, id:"stroke-probes", outline, grid:0, pcbDrawing:{annotations:{}, pours:[]}, items:[witness]};
  const inspect = AtriumConnectivity.inspect, wasEnabled = GPU.enabled();
  let wires = [];
  AtriumConnectivity.inspect = (d, ...args) => d.id === board.id ? {airwires:wires} : inspect(d, ...args);
  view.restoreCamera({cx:0, cy:0, scale:1, referenceScale:1});
  const world = p => [p[0] - 200, p[1] - 135];
  const line = (a, b, net = "base") => ({from:world(a), to:world(b), net});
  const options = {editorPane:true, noReuse:true, grid:false, origin:false, showUnrouted:true};
  const draw = (gpu, netColors = null, moving = false) => {
    GPU.enable(gpu);
    if (moving) view.moving();
    view.render(board, defs, {...options, netColors, noReuse:!moving});
    const c = gpu ? GPU.composite(I) : canvas;
    if (!c) throw Error("missing WebGL frame");
    return c.getContext("2d").getImageData(0, 0, c.width, c.height);
  };
  const get = (image, x, y) => image.data.subarray((y * image.width + x) * 4, (y * image.width + x + 1) * 4);
  const inkAt = (image, x, y) => {
    const rgba = get(image, x, y); return Math.round(rgba[0] * rgba[3] / 255);
  };
  try {
    // Compare alpha masks with a transparent 2D reference here. The dense cases above
    // still compare the resulting opaque frames, including backdrop compositing.
    return PCB.withPalette({board:"#00000000", workspace:"#00000000", connection:"#b4b4b4",
      boardGrid:"#222222", boardGridCoarse:"#cccccc", layers:{Top:"#ff0000"}}, () => {
      const blank2D = draw(false), blankGPU = draw(true), samples = [], tracks = [];
      const length = 48;
      for (const feature of ["wire", "track"]) for (const phase of [.5, 0]) for (const [k, degrees] of [0, 30, 45, 90].entries()) {
        const angle = degrees * Math.PI / 180, dx = Math.cos(angle), dy = Math.sin(angle), xMajor = degrees <= 45;
        const x = 12 + k * 95 + (xMajor ? .5 : phase);
        const y = 9 + (feature === "wire" ? 0 : 116) + (phase ? 0 : 58) + (xMajor ? phase : .5);
        const geometry = line([x, y], [x + dx * length, y + dy * length]);
        if (feature === "wire") wires.push(geometry);
        else tracks.push({...witness, id:"stroke-" + k + "-" + phase, points:[geometry.from, geometry.to]});
        samples.push({feature, degrees, phase, x, y, dx, dy, xMajor});
      }
      board.items = [witness, ...tracks];
      // The first green wire is outside the viewport. The visible red group must be painted before
      // the visible green group, even though the untinted connection is last in graph order.
      const overlap = net => line([20,255.5], [110,255.5], net);
      wires.push(line([20,-30], [110,-30], "green"), overlap("red"), overlap("green"), overlap("base"));
      const tints = new Map([["red", "#ff0000"], ["green", "#00ff00"]]);
      view.invalidate(); view.boardConnectivity(board, defs);
      const a = draw(false, tints), b = draw(true, tints);
      const center = image => [...get(image, 65, 255).subarray(0, 3)];
      const moving = draw(true, tints, true), gestureFrames = GPU.stats(I)?.acc?.gesture || 0;
      draw(true);
      const overlapColours = {canvas2d:center(a), gpu:center(b), gpuMoving:center(moving), gpuRestored:center(draw(true, tints))};
      const coverage = samples.map(({feature, degrees, phase, x, y, dx, dy, xMajor}) => {
        const strips = new Map();
        let reference = 0, actual = 0, max = 0;
        for (let py = Math.floor(y) - 3; py <= Math.ceil(y + dy * length) + 3; py++) {
          for (let px = Math.floor(x) - 3; px <= Math.ceil(x + dx * length) + 3; px++) {
            const X = px + .5 - x, Y = py + .5 - y, along = xMajor ? X / dx : Y / dy;
            if (along < 4 || along > length - 4 || Math.abs(X * dy - Y * dx) > 2) continue;
            const e = Math.max(0, inkAt(a,px,py) - inkAt(blank2D,px,py));
            const g = Math.max(0, inkAt(b,px,py) - inkAt(blankGPU,px,py));
            reference += e; actual += g; max = Math.max(max, Math.abs(e - g));
            const index = xMajor ? px : py, peaks = strips.get(index) || [0,0];
            peaks[0] = Math.max(peaks[0], e); peaks[1] = Math.max(peaks[1], g); strips.set(index, peaks);
          }
        }
        const gaps = [...strips.values()].filter(([expected, gpu]) => expected >= 50 && gpu < 50).length;
        const ideal = feature === "track" ? strips.size * 255 / (xMajor ? dx : dy) : reference;
        return {feature, degrees, phase, reference, actual, ratio:+(actual / reference).toFixed(4),
          idealRatio:+(actual / ideal).toFixed(4), max, gaps};
      });
      board.grid = 24; options.grid = true; options.showUnrouted = false;
      // One side of the rounding boundary is less than a GPU float away from the
      // other. Both axes must still select distinct device pixels on either side.
      const grid = [-1e-8, 1e-8].map(delta => {
        view.restoreCamera({cx:-.5-delta, cy:-.5-delta, scale:1, referenceScale:1});
        const values = image => [...[200,201].map(x => get(image,x,100)[0]), ...[135,136].map(y => get(image,180,y)[0])];
        return {delta, canvas2d:values(draw(false)), gpu:values(draw(true))};
      });
      return {overlapColours, coverage, gestureFrames, grid};
    });
  } finally {
    AtriumConnectivity.inspect = inspect;
    host.remove();
    GPU.enable(wasEnabled);
  }
}

globalThis.atriumGpuPixels = async function (o = {}) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const lifecycle = {contextLost, powerVisibility, memoryCap, viewportResources, hidden, parked, splitPane, layoutResize, gridCapacity, emptyTextBands, padCaptionBounds, emptyBandPan, panStripUpload, drcMarkerPan, earlySettle, zoomOutGesture, zoomOutMemory, zoomOutFailure, terminalOverlay, pourCoverageBounds, pourCoverageLod};
  const selected = o.robustness && new Set(o.robustness);
  if (selected) for (const name of selected) {
    if (!Object.hasOwn(lifecycle,name)) throw new Error("Unknown GPU robustness check: " + name);
  }
  const wholeSuite = o.robust !== false && !selected;
  const robust = name => o.robust !== false && (!selected || selected.has(name));
  const H = () => AtriumNavHost, cv = () => H().canvas(), GPU = () => globalThis.AtriumCanvasGPU, PCB = AtriumPCBAppearance;
  const act = a => window.dispatchEvent(new CustomEvent("atrium-command", {detail: a}));
  const settle = async ms => { await wait(ms); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); };
  const budget = {over8: 40, over48: 6, solidPx: 100, ...(o.budget || {})};
  globalThis.confirm = () => true;
  let startup = null;
  const startupPower = globalThis.AtriumPower;
  if (wholeSuite && H().isStarter() && H().doc()?.kind !== "pcb" && startupPower?.visible?.()) {
    const was = startupPower.state();
    startupPower.host({lowPower: true});
    await settle(650); // Idle while Home or the initial schematic is showing.
    const settings = globalThis.AtriumCanvasGPUPref;
    const idle = !GPU() && (!settings || settings.describe() === "No PCB view is using a renderer");
    const initial = H().currentId(), board = H().project().documents.find(d => d.kind === "pcb");
    document.querySelector("dialog.sp-dialog[open] [data-start-action=close]")?.click();
    H().selectDocument(board.id);
    for (let n = 0; n < 26 && !GPU()?.stats()?.acc?.frames; n++) {
      await wait(80);
      const pref = globalThis.AtriumCanvasGPUPref;
      if (pref && !pref.decision().use && pref.describe() !== "No PCB view is using a renderer") break;
    }
    const mode = globalThis.AtriumCanvasGPUPref?.decision();
    const demanded = mode && globalThis.AtriumCanvasGPUPref.describe() !== "No PCB view is using a renderer" && (!mode.use || !!GPU()?.stats()?.acc?.frames);
    startup = {idle, demanded: !!demanded, hardware: mode?.use ?? false};
    H().selectDocument(initial);
    startupPower.host(was);
  }
  await AtriumLazy.need(["AtriumRules", "AtriumPCBDraw", "AtriumCanvasFast", "AtriumCanvasGPU", "AtriumViaStack", "AtriumStackup", "AtriumRigidFlex"]);
  // WebGL2 here at all? (No context: the test is skipped, not failed.)
  const probe = (() => { try { const g = document.createElement("canvas").getContext("webgl2"); if (!g) return null;
    const x = g.getExtension("WEBGL_debug_renderer_info"); const r = g.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : g.RENDERER); g.getExtension("WEBGL_lose_context")?.loseContext(); return r; } catch { return null; } })();
  if (!probe) return {skipped: "no WebGL2 context", ua: navigator.userAgent};
  globalThis.AtriumDRCMarkers?.setVisible?.(false, H());
  document.documentElement.setAttribute("data-motion", "off");

  // Object-class masks: an interior difference is counted against the class whose colour the 2D pixel (else the
  // GPU pixel) has, within 12 levels: holes (via and pad holes, drill edges), the selection colour, Top, Bottom and
  // inner copper (solid, or poured at the pour opacity over the board), silk and pad text, connection lines; the rest
  // is "other" (blended, dimmed and highlighted colours, the grid). Each class has its own budget, so a small class
  // (holes, the selection) cannot hide inside a case's total.
  const CLASSES = ["hole", "sel", "top", "bottom", "inner", "silk", "conn", "other"];
  const hexRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); if (!m) return null; const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255]; };
  const classColours = () => {
    const S = PCB.system, board = hexRgb(S.board) || [0, 0, 0], pa = PCB.opacity.pour;
    const poured = c => c && c.map((x, k) => Math.round(x * pa + board[k] * (1 - pa)));
    const L = l => hexRgb(PCB.color(l)), inner = [1, 2, 3, 4, 5, 6].map(k => L("Inner " + k));
    const list = [["hole", hexRgb(S.hole)], ["hole", hexRgb(S.padHole)], ["hole", hexRgb(S.drillEdge)], ["sel", hexRgb(S.selection)],
      ["top", L("Top")], ["top", poured(L("Top"))], ["bottom", L("Bottom")], ["bottom", poured(L("Bottom"))],
      ...inner.flatMap(c => [["inner", c], ["inner", poured(c)]]), ["silk", L("Silk")], ["silk", L("Bottom silk")], ["silk", hexRgb(S.padText)], ["conn", hexRgb(S.connection)]];
    return list.filter(x => x[1]);
  };
  const classOf = (list, D, i) => { for (const [c, v] of list) if (Math.abs(D[i] - v[0]) <= 12 && Math.abs(D[i + 1] - v[1]) <= 12 && Math.abs(D[i + 2] - v[2]) <= 12) return c; return null; };

  // ---------------------------------------------------------------- boards
  const PP = globalThis.AtriumPolygonPour, doc0 = () => H().doc();
  let previousFixture = null;
  const boards = {
    async dense() {
      const p = Atrium.project("Dense", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
      const {d} = makeAtriumBenchmarkBoard(); p.documents = p.documents.map(x => x === old ? d : x);
      let k = 0;
      for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else i.net = "N" + (k % 64); k++; }
      // A few objects the plain board lacks: a stacked via, a tented and a filled via, a blind via, a
      // custom-shape pad, a free pad with a pad stack, large pads (pad numbers and nets), a footprint graphic.
      const at = (x, y) => [x, y];
      const extra = [
        {id: "x-tmb", kind: "via", x: 30, y: 30, diameter: .9, drill: .35, layer: "Multi", net: "N1", stackMode: "tmb", padStack: {Top: {diameter: 1.2}, Mid: {diameter: .7}, Bottom: {diameter: 1.0}}},
        {id: "x-tent", kind: "via", x: 31.5, y: 30, diameter: .9, drill: .45, layer: "Multi", net: "N2", tent: {top: true, bottom: true}},
        {id: "x-fill", kind: "via", x: 33, y: 30, diameter: .9, drill: .45, layer: "Multi", net: "N3", ipc4761: "VII"},
        {id: "x-back", kind: "via", x: 34.5, y: 30, diameter: .9, drill: .45, layer: "Multi", net: "N4", backdrill: {from: "Bottom", to: "Inner 2", diameter: .6}},
        {id: "x-blind", kind: "via", x: 36, y: 30, diameter: .8, drill: .4, layer: "Multi", net: "N5", fromLayer: "Top", toLayer: "Inner 1"},
        {id: "x-bur", kind: "via", x: 37.5, y: 30, diameter: .8, drill: .4, layer: "Multi", net: "N6", fromLayer: "Inner 1", toLayer: "Bottom"},
        {id: "x-cust", kind: "pad", x: 40, y: 30, w: 2, h: 1.4, angle: 30, layer: "Top", shape: "custom", net: "N7", poly: [at(-1, -.7), at(1, -.7), at(1, 0), at(0, .7), at(-1, .7)]},
        {id: "x-big", kind: "pad", x: 44, y: 30, w: 3, h: 2, angle: 0, layer: "Top", shape: "roundrect", net: "BIGNET"},
        {id: "x-th", kind: "pad", x: 48, y: 30, w: 2.4, h: 2.4, layer: "Multi", shape: "octagon", drill: 1.1, net: "N8"},
        {id: "x-np", kind: "pad", x: 51, y: 30, w: 1.5, h: 1.5, layer: "Multi", shape: "round", drill: 1.5},
        {id: "x-stk", kind: "pad", x: 54, y: 30, w: 1.6, h: 1.6, layer: "Multi", shape: "round", drill: .6, net: "N9", stackMode: "tmb", padStack: {Top: {w: 2.2, h: 1.6}, Bottom: {w: 1.2, h: 1.2}, Mid: {w: 1, h: 1}}},
        {id: "x-poly", kind: "graphic", layer: "Top", width: .2, fill: true, closed: true, net: "N10", points: [at(57, 28), at(60, 28), at(60, 32), at(57, 32)]}
      ];
      d.items.push(...extra);
      d.stackup = d.stackup || undefined;
      const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
      const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
      for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
      polys.forEach(([layer, net, ol], j) => d.items.push(PP.make(ol, {layer, net, pourIndex: j, removeDeadCopper: false})));
      await H().replaceProject(p, {force: true}); H().selectDocument(d.id); await wait(300);
      H().edit(() => PP.apply(H().doc(), H().defs(), {project: H().project()}));
      return {close: [26, 27, 58, 33]};
    },
    // A small board (900 objects) whose own pours follow a dragged part (live pour tile patches).
    async pours() {
      const p = Atrium.project("Pours", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
      const {d} = makeAtriumBenchmarkBoard(30); p.documents = p.documents.map(x => x === old ? d : x);
      let k = 0;
      for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 8), "2": "GND"}; else i.net = "N" + (k % 8); k++; }
      const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
      d.items.push(PP.make(rect(1, 1, 68, 50), {layer: "Top", net: "GND", pourIndex: 0, removeDeadCopper: false}), PP.make(rect(1, 1, 68, 50), {layer: "Bottom", net: "N1", pourIndex: 1, removeDeadCopper: false}));
      if (globalThis.__gpuNoWorker) { PP.tiles.useWorker(false); PP.tiles.reset(); }
      await H().replaceProject(p, {force: true}); H().selectDocument(d.id); await wait(300);
      H().edit(() => PP.apply(H().doc(), H().defs(), {project: H().project()}));
      return {};
    },
    async starter() {
      const p = Atrium.project("Starter", AtriumParts.catalogue);
      await H().replaceProject(p, {force: true});
      const d = p.documents.find(x => x.kind === "pcb"); H().selectDocument(d.id); await wait(300);
      return {};
    },
    async fixture(name) {
      const b64 = globalThis.__gpuFixtures?.[name];
      if (!b64) return null;
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], name);
      const predecessor = previousFixture;
      // Only discard the recovery draft made by the preceding injected test file.
      // This choice is distinct from the ordinary project replacement prompt.
      const accept = setInterval(() => {
        const draft = H().fileSession().imported;
        if (predecessor && draft === predecessor.draft && draft.sourceFile === predecessor.file) {
          const discard = document.querySelector('dialog.foreign-import-close[open] button[data-choice="discard"]:not(:disabled)');
          if (discard) { discard.click(); return; }
        }
        // Keep the comparison in this editor when offered a choice of windows.
        const button = [...document.querySelectorAll("dialog[open] button")].find(b => ["Open here", "Replace project", "Don’t Save"].includes(b.textContent.trim()));
        button?.click();
      }, 50);
      let opened;
      try { opened = await H().openFiles([file]); } finally { clearInterval(accept); }
      if (!opened) return null;
      const draft = H().fileSession().imported;
      previousFixture = draft?.sourceFile === file && draft.sourceFiles?.length === 1 && draft.sourceFiles[0] === file
        ? {file, draft} : null;
      for (let n = 0; n < 600 && H().doc()?.kind !== "pcb"; n++) {
        const d = H().project()?.documents?.find(x => x.kind === "pcb");
        if (d) { H().selectDocument(d.id); break; }
        await wait(50);
      }
      // Import may already select the board underneath its report. Choose its actual tab.
      if (cv().inert) document.querySelector('#document-tabs [data-tab="' + CSS.escape(H().currentId()) + '"]')?.click();
      await wait(500);
      const c = cv(), r = c.getBoundingClientRect();
      return H().doc()?.kind === "pcb" && !c.inert && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) === c ? {} : null;
    }
  };

  const out = {ua: navigator.userAgent, renderer: probe, pixelRatio: {effective: globalThis.devicePixelRatio},
    viewport: {width: innerWidth, height: innerHeight}, budget, boards: {}, failures: [], fault: o.fault || null};
  if (startup) {
    out.startup = startup;
    if (!startup.idle || !startup.demanded) out.failures.push("startup GPU demand: " + JSON.stringify(startup));
  }
  // Fault injection (app/canvas/canvas-gpu.js fault()): every view is rebuilt with the fault in place.
  if (o.fault) globalThis.__atriumGpuFault = o.fault; else delete globalThis.__atriumGpuFault;
  GPU().reset();
  const list = o.boards || ["dense", "pours", "starter", ...Object.keys(globalThis.__gpuFixtures || {})];
  for (const name of list) {
    const t0 = performance.now();
    const info = await (boards[name] ? boards[name]() : boards.fixture(name));
    if (!info) { out.boards[name] = {skipped: "board did not open"}; out.failures.push(name + ": board did not open"); continue; }
    globalThis.AtriumDRCMarkers?.setVisible?.(false, H());
    act("fit"); await settle(800);
    for (let n = 0; n < 200 && PP?.live?.busy; n++) await wait(50);
    // Idle-time indexes and batches of the 2D path (canvas.js LOD, canvas-fast.js pour rings) build after a
    // quiet period: let them, so a board measures the same first in a page or later.
    await settle(doc0().items.length > 6000 ? 2500 : 300);
    // The editor's own render options (navRender's overlays included) for this board.
    let lastArgs = null;
    const v = H().view(), r0 = v.render;
    v.render = (...a) => { lastArgs = a; return r0(...a); };
    H().redraw(); await settle(100);
    v.render = r0;
    if (!lastArgs) {
      out.boards[name] = {skipped: "no render"};
      out.failures.push(name + ": no render (" + JSON.stringify(startupPower?.state?.()) + ")");
      continue;
    }
    const doc = H().doc(), defs = H().defs();
    // Objects for the selection and highlight cases: a track, a via, a part; the busiest net.
    const visibleNow = () => { const r = cv().getBoundingClientRect(); return i => { const q = v.worldToScreen(i.x != null ? [i.x, i.y] : i.points?.[0] || [0, 0]); return q[0] > 40 && q[1] > 40 && q[0] < r.width - 40 && q[1] < r.height - 40; }; };
    const nets = new Map(); for (const i of doc.items) if (i.net) nets.set(i.net, (nets.get(i.net) || 0) + 1);
    const busiest = [...nets].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const pick = test => { const ok = visibleNow(); return doc.items.find(i => test(i) && ok(i)) || doc.items.find(test); };
    // Close view: the box handed by the board, else around a part with large pads.
    const bigPart = doc.items.filter(i => i.kind === "part").map(i => ({i, pads: defs.get(i.def)?.footprint?.pads || []})).sort((a, b) => b.pads.length - a.pads.length)[0]?.i;
    const close = info.close || (bigPart ? [bigPart.x - 6, bigPart.y - 4, bigPart.x + 6, bigPart.y + 4] : null);
    const ob = doc.outline?.length ? doc.outline.reduce((b, q) => [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])], [Infinity, Infinity, -Infinity, -Infinity]) : null;
    const mid = ob ? [(ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2, (ob[2] - ob[0]) / 8, (ob[3] - ob[1]) / 8] : null;
    const views = {
      fit: async () => { act("fit"); await settle(500); },
      zoomed: mid ? async () => { H().zoomTo([mid[0] - mid[2], mid[1] - mid[3], mid[0] + mid[2], mid[1] + mid[3]]); await settle(400); } : null,
      close: close ? async () => { H().zoomTo(close); await settle(400); } : null
    };
    // Cases: option overrides for one render; set/unset change global state around it.
    const cases = {
      base: {},
      dim: {opts: {layerMode: "dim", layer: "Top"}},
      single: {opts: {layerMode: "single", layer: "Bottom"}},
      flipped: {set: () => v.setFlipped(true), unset: () => v.setFlipped(false)},
      selection: {opts: () => { const t = pick(i => i.kind === "track"), w = pick(i => i.kind === "via"), p = pick(i => i.kind === "part"); const ids = new Set([t, w, p].filter(Boolean).map(i => i.id)); return {selected: t?.id ?? null, selectedIds: ids}; }},
      // A collaborator's edits still animating (collab-object-motion.js): both renderers leave out these objects. The 2D
      // renderer draws the LOD chunks holding them item by item, so overlapping copper there blends a little differently.
      hide: {solidPx: 400, opts: () => ({hide: new Set([pick(i => i.kind === "track"), pick(i => i.kind === "via"), pick(i => i.kind === "part")].filter(Boolean))})},
      highlight: {opts: () => ({highlight: busiest[0] || ""})},
      netColors: {solidPx: 300, opts: () => ({netColors: new Map(busiest.slice(0, 3).map((n, k) => [n, ["#ff8800", "#22ccff", "#aa44ff"][k]]))})},
      light: {set: () => AtriumTheme.canvasPalette("pcb", {...AtriumTheme.get(), preset: "light", followSystem: false, canvas: {follow: true, pcbBackground: "#f2f2ee"}})},
      contrast: {set: () => AtriumTheme.canvasPalette("pcb", {...AtriumTheme.get(), preset: "hc", followSystem: false, canvas: {follow: true}})},
      // Board-shape edit handles: squares on the outline's vertices, circles on edge midpoints, one active.
      handles: {opts: () => { const ol = doc.outline || [], hs = [];
        ol.forEach((p, k) => { const q = ol[(k + 1) % ol.length]; hs.push({type: "vertex", at: p, ref: {contour: 0, index: k}}, {type: "mid", at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], ref: {contour: 0, index: k}}); });
        return {boardHandles: hs, boardHandleActive: hs[0] || null}; }},
      // Board Planning mode (key 1): board regions tinted, with their labels.
      planning: {set: () => { AtriumStackup.setPlanning(true); }, unset: () => { AtriumStackup.setPlanning(false); }},
      opacity: {solidPx: 1000, set: () => { PCB.setOpacity("track", .5); PCB.setOpacity("pour", .5); PCB.setLayerOpacity("Bottom", .6); },
        unset: () => { PCB.setOpacity("track", PCB.defaultOpacity.track); PCB.setOpacity("pour", PCB.defaultOpacity.pour); PCB.setLayerOpacity("Bottom", 1); }}
    };
    const only = o.cases ? new Set(o.cases) : null;
    const R = out.boards[name] = {items: doc.items.length, cases: {}};
    // One case: the same frame drawn by both renderers and compared (see the header for the metrics).
    const measureCase = (vname, cname, c, [d0, f0, opts0], record = true) => {
      const extra = typeof c.opts === "function" ? c.opts() : c.opts || {};
      const palette = c.set?.();
      // Caller overlays (DRC markers) are painted by the same code on both paths: left out.
      const opts = {...opts0, overlay: undefined, ...extra, noReuse: true};
      const draw = gpu => { GPU().enable(gpu); v.render(d0, f0, opts); };
      let a, g, W, Hh, comp;
      let classes = null;
      const both = () => {
        classes = classColours();
        draw(false); W = cv().width; Hh = cv().height; a = cv().getContext("2d").getImageData(0, 0, W, Hh);
        draw(true);
        comp = GPU().composite(v.internals());
        if (comp?.width === W && comp.height === Hh && cv().width === W && cv().height === Hh)
          g = comp.getContext("2d").getImageData(0, 0, W, Hh);
      };
      try { if (palette) PCB.withPalette(palette, both); else both(); }
      finally { c.unset?.(); }
      if (!record) return;
      if (!g) {
        const error = comp ? `frame backing: 2D ${W}×${Hh}, overlay ${cv().width}×${cv().height}, GPU ${comp.width}×${comp.height}` : "no GPU frame";
        R.cases[vname + "." + cname] = {error};
        out.failures.push(name + " " + vname + "." + cname + ": " + error);
        return;
      }
      R.backing ??= {width: W, height: Hh};
      const n = W * Hh, A = a.data, G = g.data, dm = new Uint8Array(n);
      let n8 = 0, n48 = 0, sum = 0, solid = 0;
      for (let i = 0, p = 0; p < n; i += 4, p++) {
        const d = rgbDifference(A,G,i);
        dm[p] = d > 48 ? 2 : d > 8 ? 1 : 0; if (d > 8) n8++; if (d > 48) n48++; sum += d;
      }
      const solidAt = new Uint8Array(n);
      for (let y = 1; y + 1 < Hh; y++) for (let x = 1; x + 1 < W; x++) {
        const p = y * W + x;
        if (dm[p] === 2 && dm[p - 1] === 2 && dm[p + 1] === 2 && dm[p - W] === 2 && dm[p + W] === 2 && dm[p - W - 1] === 2 && dm[p - W + 1] === 2 && dm[p + W - 1] === 2 && dm[p + W + 1] === 2) { solid++; solidAt[p] = 1; }
      }
      // Edge-tolerant comparison: the 2D frame's edges (a channel step over 16 levels to a neighbour), widened by a
      // pixel, hold all anti-aliasing differences; everywhere else (interiors) the frames must agree to 24 levels.
      // On the edges the mean difference is kept: a shifted, thinner or thicker object raises it.
      const edge = new Uint8Array(n), wide = new Uint8Array(n);
      const step = (p, q) => rgbDifference(A,A,p*4,q*4);
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const p = y * W + x; if ((x + 1 < W && step(p, p + 1) > 16) || (y + 1 < Hh && step(p, p + W) > 16)) { edge[p] = 1; if (x + 1 < W) edge[p + 1] = 1; if (y + 1 < Hh) edge[p + W] = 1; } }
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const p = y * W + x; if (!edge[p]) continue; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < Hh) wide[Y * W + X] = 1; } }
      let interior = 0, eSum = 0, eN = 0;
      const perClass = {}; for (const c of CLASSES) perClass["c_" + c] = 0;
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        const d = rgbDifference(A,G,i);
        if (wide[p]) { eSum += d; eN++; } else if (d > 24) { interior++; dm[p] = 3; perClass["c_" + (classOf(classes, A, i) || classOf(classes, G, i) || "other")]++; }
      }
      const pc = x => +(x / n * 100).toFixed(3);
      const m = {over8: pc(n8), over48: pc(n48), solid: pc(solid), solidPx: solid, meanAbs: +(sum / n).toFixed(2), interiorPx: interior, edgeMean: +(eN ? eSum / eN : 0).toFixed(2), ...perClass};
      const key = name + "." + vname + "." + cname;
      const lim = o.budgets?.[key] || {...budget, ...(c.solidPx && !o.budget?.solidPx ? {solidPx: c.solidPx} : {})};
      const bad = Object.keys(lim).filter(k => m[k] > lim[k]);
      const limits = bad.map(k => k + " " + m[k] + " > " + lim[k]);
      const expectedRaster = o.raster?.[key], captureRaster = o.captureRaster?.includes(key);
      if (expectedRaster || captureRaster) {
        const raster = rasterResidual(A, G, W, Hh);
        if (captureRaster) m.raster = raster;
        if (expectedRaster) {
          (out.rasterCases ??= []).push(key);
          const changed = changedRasterTiles(raster, expectedRaster);
          if (changed) { bad.push("raster"); limits.push("raster residual: " + changed); }
        }
      }
      if (bad.length) { m.fail = bad; out.failures.push(name + " " + vname + "." + cname + ": " + limits.join(", ")); }
      if (o.images === true || (bad.length && o.images !== false)) {
        const dc = document.createElement("canvas"); dc.width = W; dc.height = Hh; const dg = dc.getContext("2d"), di = dg.createImageData(W, Hh);
        for (let p = 0, i = 0; p < n; p++, i += 4) {
          const s = solidAt[p] || solidAt[p - 1] || solidAt[p + 1] || solidAt[p - W] || solidAt[p + W];
          di.data[i] = s || dm[p] === 3 ? 255 : dm[p] === 2 ? 255 : dm[p] ? 90 : 0; di.data[i + 1] = di.data[i + 2] = s || dm[p] === 3 ? 0 : di.data[i]; di.data[i + 3] = 255;
        }
        dg.putImageData(di, 0, 0);
        const c2 = document.createElement("canvas"); c2.width = W; c2.height = Hh; c2.getContext("2d").putImageData(a, 0, 0);
        (out.images ??= {})[name + "." + vname + "." + cname] = {"2d": c2.toDataURL("image/png"), gpu: comp.toDataURL("image/png"), diff: dc.toDataURL("image/png")};
      }
      R.cases[vname + "." + cname] = m;
    };
    for (const [vname, go] of Object.entries(views)) {
      if (!go || (o.views && !o.views.includes(vname))) continue;
      await go();
      // Connection lines of a large board follow an edit by an idle pass (canvas.js airwireConnectivity): compute
      // them now, so both renderers of every case see the same ones.
      try { v.boardConnectivity?.(doc, defs); } catch {}
      H().redraw(); await settle(doc.items.length > 6000 ? 600 : 100);
      // Run the earlier paints and readbacks even when a case is selected. The browser
      // may choose a different Canvas raster backend after repeated pixel reads.
      for (const [cname, c] of Object.entries(cases)) measureCase(vname, cname, c, lastArgs, !only || only.has(cname));
    }
    // Live pour tile patches (polygon-pour.js): a part dragged inside a pour, compared in the middle of the drag
    // (pointer down), when the tiles have patched the pours around it.
    if (doc.pcbDrawing?.pours?.length && PP?.tiles && (!only || only.has("pourDrag")) && (!o.views || o.views.includes("zoomed")) && views.zoomed) {
      await views.zoomed();
      const r = cv().getBoundingClientRect(), ok = visibleNow();
      const scr = w => { const q = v.worldToScreen(w); return [q[0] + r.left, q[1] + r.top]; };
      const pev = (type, [x, y], e = {}) => cv().dispatchEvent(new PointerEvent(type, {clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", ...e}));
      // Parts inside a pour, nearest the middle of the view first: a part whose move changes no copper (its pads
      // already clear of the pour there) gives no patch, so up to four are tried.
      const mid0 = v.screenToWorld([r.width / 2, r.height / 2]);
      const parts = doc.items.filter(i => i.kind === "part" && ok(i) && doc.pcbDrawing.pours.some(g => g.bounds && i.x > g.bounds[0] && i.x < g.bounds[2] && i.y > g.bounds[1] && i.y < g.bounds[3]))
        .sort((x, y) => Math.hypot(x.x - mid0[0], x.y - mid0[1]) - Math.hypot(y.x - mid0[0], y.y - mid0[1])).slice(0, 4);
      if (!parts.length) R.cases["zoomed.pourDrag"] = {skipped: "no part inside a pour in view"};
      // Synthetic pointers cannot be captured: the editor's capture calls become no-ops for the drag.
      const P0 = HTMLCanvasElement.prototype, cap = [P0.setPointerCapture, P0.releasePointerCapture];
      P0.setPointerCapture = P0.releasePointerCapture = function () {};
      const tried = [];
      try {
        for (const part of parts) {
          const q = scr([part.x, part.y]), x0 = part.x; H().select([part.id]); await settle(50);
          pev("pointermove", q, {buttons: 0}); pev("pointerdown", q);
          let patched = false, last = null;
          const r0 = v.render; v.render = (...a) => { last = a; return r0(...a); };
          for (let i = 1; i <= 40 && !patched; i++) { pev("pointermove", [q[0] + i * 2, q[1] + i]); await wait(60); patched = !PP.tiles.busy && !!last?.[2]?.transientGeometry && !!PP.displayPours(doc)?.some(g => g.patch); }
          await settle(100); v.render = r0;
          tried.push(part.id + (patched ? " patched" : " (moved " + +(part.x - x0).toFixed(3) + " mm, tile runs " + PP.tiles.history.length + ", follows the drag " + !!PP.tiles.dragVisible?.(doc) + ")"));
          if (patched && last) { measureCase("zoomed", "pourDrag", {}, last); out.pourDrag = (out.pourDrag || 0) + 1; }
          pev("pointerup", [q[0] + 120, q[1] + 60]); await settle(400); H().select([]); act("undo"); await settle(800);
          if (patched) break;
        }
      } finally { [P0.setPointerCapture, P0.releasePointerCapture] = cap; }
      // A board whose pours are too large to follow a drag (the dense board) hides them instead: nothing to compare.
      if (parts.length && !R.cases["zoomed.pourDrag"]) R.cases["zoomed.pourDrag"] = {skipped: "no live pour patches during the drag: " + tried.join("; ")};
      R.pourDrag = {tried};
    }
    R.seconds = +((performance.now() - t0) / 1000).toFixed(1);
    GPU().enable(true); H().redraw();
  }
  if ((!o.cases || o.cases.includes("pourDrag")) && (!o.views || o.views.includes("zoomed")) && !o.boards && !out.pourDrag) out.failures.push("pourDrag: no board had live pour patches to compare");
  // A retained edit must match a fresh GPU scene byte for byte, including draw order after a
  // mid-list insert, repeated changes before paint and undo of both membership and geometry.
  if (wholeSuite && H().doc()?.kind === "pcb") {
    const h = H(), doc = h.doc(), v = h.view(), U = globalThis.AtriumUndoStore;
    const opts = {editorPane: true, noReuse: true, layer: "Top", layerMode: "all", hidden: new Set(["Source pours"]), showUnrouted: false};
    const [x, y] = v.screenToWorld([cv().clientWidth / 2, cv().clientHeight / 2]), scale = v.camera().scale;
    const id = "gpu-edit-test-" + Date.now(), size = 20 / scale;
    const a = {kind: "track", id: id + "a", layer: "Top", width: size / 3, points: [[x - size, y], [x + size, y]]};
    const b = {kind: "pad", id: id + "b", layer: "Top", w: size, h: size, x, y, shape: "rect", net: "EDIT"};
    const label = {kind: "label", id: id + "text", x, y: y + size, layer: "Silk", text: "T1", size: size / 2};
    const via = {kind:"via", id:id+"mask", layer:"Multi", x:x+2*size, y:y+2*size, diameter:size, drill:size*.55, tent:{top:false,bottom:false}};
    const results = out.incremental = {};
    const frame = () => {
      v.render(doc, h.defs(), opts);
      const image = GPU().composite();
      if (!image) throw Error("GPU frame unavailable");
      return image.getContext("2d").getImageData(0, 0, image.width, image.height).data;
    };
    const check = (name, mutate, before) => {
      const builds = GPU().stats().builds;
      mutate(); U?.sync(); const actual = frame(), retained = GPU().stats();
      v.invalidate(); const fresh = frame();
      const diff = differentBytes(actual, fresh);
      results[name] = {differentBytes: diff, builds: retained.builds - builds, upload: retained.frameUpload, textUpload: retained.textUpload, dead: retained.dead};
      if (before) results[name].visualChange = differentBytes(before, actual);
      const localText = !before || results[name].visualChange > 0 && retained.textUpload > 0 && retained.textUpload < actual.length;
      if (diff || builds !== retained.builds || !localText) out.failures.push("retained edit " + name + ": " + JSON.stringify(results[name]));
      return actual;
    };
    try {
      GPU().enable(true); U?.mark(h.project()); U?.sync(); v.invalidate(); frame();
      check("append", () => h.edit(() => doc.items.push(a, b, label)));
      check("move", () => h.edit(() => { b.x += size / 3; }));
      check("label", () => h.edit(() => { label.x += size; label.text = "T17"; }));
      check("grow", () => h.edit(() => { a.points.push([x + size, y + size]); }));
      check("coalesced", () => {
        h.edit(() => { b.y -= size; }); U?.sync(); v.hit(doc, h.defs(), [x, y]);
        h.edit(() => { b.y += size / 2; });
      });
      check("remove", () => h.edit(() => doc.items.splice(doc.items.indexOf(a), 1)));
      check("restoreInOrder", () => act("undo"));
      check("redo", () => act("redo"));
      const unselected = frame();
      const selected = check("selectText", () => { opts.selected = label.id; }, unselected);
      check("deselectText", () => { opts.selected = null; }, selected);
      const withoutMark=check("appendVia",()=>h.edit(()=>doc.items.push(via),undefined,[via]));
      // Tenting draws nothing of its own; filling the via closes its drill (viastack.js paintMarks).
      const withMark=check("fillVia",()=>h.edit(()=>{via.ipc4761="V";},undefined,[via]));
      results.fillVia.visualChange=differentBytes(withoutMark,withMark);
      if(!results.fillVia.visualChange)out.failures.push("filled via edit left the frame unchanged");
      // Translucent via copper goes through an ordered texture band. Warm the band with
      // the mark visible before toggling its appearance without a geometry edit.
      const previousViaOpacity = PCB.opacity.via;
      try {
        PCB.setOpacity("via", .5);
        const shownMark = frame();
        const hiddenMark = check("hideViaMarks", () => { opts.viaMarks = false; });
        results.hideViaMarks.visualChange = differentBytes(shownMark, hiddenMark);
        const restoredMark = check("restoreViaMarks", () => { delete opts.viaMarks; });
        if (!results.hideViaMarks.visualChange || differentBytes(shownMark, restoredMark))
          out.failures.push("retained via mark visibility did not change and restore its pixels");
      } finally { PCB.setOpacity("via", previousViaOpacity); delete opts.viaMarks; }
      const previousOpacity = PCB.opacity.track;
      try {
        PCB.setOpacity("track", .5);
        const opaqueLabel = frame();
        check("translucentSelection", () => { opts.selected = label.id; }, opaqueLabel);
      } finally { PCB.setOpacity("track", previousOpacity); opts.selected = null; }
      // The origin marks are uploaded once per camera and origin: an unchanged frame (a window
      // uncovered) sends nothing. A moved origin matches marks rebuilt from scratch.
      frame(); frame();
      results.unchangedFrame = {upload: GPU().stats().frameUpload};
      if (results.unchangedFrame.upload !== 0) out.failures.push("an unchanged GPU frame uploaded " + results.unchangedFrame.upload + " bytes");
      const origin = doc.origin;
      try {
        h.edit(() => { doc.origin = [x + size, y - size]; }); U?.sync();
        const moved = frame(), upload = GPU().stats().frameUpload;
        opts.origin = false; frame(); delete opts.origin;
        results.origin = {upload, differentBytes: differentBytes(moved, frame())};
        if (results.origin.differentBytes || !upload) out.failures.push("moved origin: " + JSON.stringify(results.origin));
      } finally { h.edit(() => { doc.origin = origin; }); delete opts.origin; }
    } catch (e) { out.failures.push("retained edit: " + e.message); }
    finally { h.edit(() => { for (const i of [a, b, label, via]) if (doc.items.includes(i)) doc.items.splice(doc.items.indexOf(i), 1); }); }
  }
  // Robustness on the last board: a lost context is restored (2D meanwhile), the memory cap falls back to 2D
  // with a reason, a document switch takes the parked scene back, a split pane gets its own context and gives
  // it back when closed; after each, the GPU frame still matches the 2D frame.
  const failLifecycle = (name, why) => { out.robust[name] = "FAIL " + why; out.failures.push("robustness " + name + ": " + why); };
  const okLifecycle = (name, note = "ok") => { out.robust[name] = note; };
  const same = async (pane = H().panes().find(p => p.active)) => {
    const {canvas, view: v} = pane, r0 = v.render;
    let last = null; v.render = (...a) => { last = a; return r0(...a); };
    if (pane.active) H().redraw(); else H().showInOther(pane.docId);
    await settle(80); v.render = r0;
    if (!last) return "no render";
    const [d, f, op] = last, opts = {...op, overlay: undefined, noReuse: true}, W = canvas.width, Hh = canvas.height;
    GPU().enable(false); v.render(d, f, opts); const A = canvas.getContext("2d").getImageData(0, 0, W, Hh).data;
    GPU().enable(true); v.render(d, f, opts);
    const gpu = canvas.previousElementSibling;
    if (!gpu?.matches(".atrium-gpu-board") || gpu.style.display === "none") return "no GPU frame";
    const composite = document.createElement("canvas"); composite.width = W; composite.height = Hh;
    const ctx = composite.getContext("2d"); ctx.drawImage(gpu, 0, 0); ctx.drawImage(canvas, 0, 0);
    const B = ctx.getImageData(0, 0, W, Hh).data;
    const pct = differentPixels(A,B,48) / (W * Hh) * 100;
    return pct <= budget.over48 ? "" : "over48 " + pct.toFixed(2) + " %";
  };
  // A view's first GPU frame is prepared in idle time after a 2D frame (canvas-gpu.js render): wait for it.
  const ready = async () => { for (let n = 0; n < 60 && !(GPU().stats()?.acc?.frames); n++) { H().redraw(); await settle(50); } };
  const until = async (predicate, polls = 80) => {
    for (let n = 0; n < polls; n++) {
      if (predicate()) return true;
      await wait(50);
    }
    return false;
  };
  const lossExtension = () => cv().previousElementSibling?.matches(".atrium-gpu-board") ?
    cv().previousElementSibling.getContext("webgl2")?.getExtension("WEBGL_lose_context") : null;

  if (Object.keys(lifecycle).some(robust)) {
    out.robust = {};
    try {
      GPU().enable(true); act("fit"); await settle(400); H().redraw(); await settle(100); await ready();
      for (const [name, check] of Object.entries(lifecycle)) if (robust(name)) await check();
    } catch (error) { failLifecycle("error", error.message); }
  }

  // Hold the loss until Canvas2D takes over.
  async function contextLost() {
    const contextLoss = lossExtension();
    if (!contextLoss) okLifecycle("contextLost", "skipped: no WEBGL_lose_context");
    else {
      contextLoss.loseContext();
      await until(() => GPU().stats()?.lost);
      const lost = GPU().status();
      contextLoss.restoreContext();
      await until(() => GPU().stats()?.restored && GPU().status().renderer === "gpu");
      const back = GPU().status(), st = GPU().stats(), why = await same();
      if (lost.renderer !== "2d" || !/lost/.test(lost.reason)) failLifecycle("contextLost", "while lost: " + JSON.stringify(lost));
      else if (back.renderer !== "gpu" || !st?.restored) failLifecycle("contextLost", "not restored: " + JSON.stringify(back));
      else if (why) failLifecycle("contextLost", "after restore: " + why);
      else okLifecycle("contextLost");
    }
  }

  async function powerVisibility() {
    const outcome = out.powerVisibility = await gpuPowerVisibility(H(), GPU(), wait, until);
    if (outcome.ok) okLifecycle("powerVisibility");
    else failLifecycle("powerVisibility", JSON.stringify(outcome));
  }

  async function memoryCap() {
    let capLabel;
    if ((GPU().stats()?.gpuBytes || 0) <= 1048576) {
      const v=H().view(), [x,y]=v.screenToWorld([cv().clientWidth/2,cv().clientHeight/2]);
      capLabel={id:"gpu-cap-"+Date.now(),kind:"label",x,y,layer:"Silk",size:10/v.camera().scale,text:"Memory test"};
      H().edit(()=>H().doc().items.push(capLabel));
    }
    globalThis.__atriumGpuCapMB = 1; GPU().reset(); H().redraw();
    await until(() => /GPU memory/.test(GPU().status().reason));
    const capped = GPU().status();
    delete globalThis.__atriumGpuCapMB; GPU().reset(); H().redraw(); await settle(60); await ready();
    if (capped.renderer !== "2d" || !/GPU memory/.test(capped.reason)) failLifecycle("memoryCap", JSON.stringify(capped));
    else if (GPU().status().renderer !== "gpu") failLifecycle("memoryCap", "not back on the GPU after the cap was lifted");
    else okLifecycle("memoryCap", "2D: " + capped.reason);
    if(capLabel)H().edit(()=>H().doc().items.splice(H().doc().items.indexOf(capLabel),1));
  }

  async function viewportResources() {
    const stage = document.createElement("div"), canvas = document.createElement("canvas");
    stage.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
    canvas.style.cssText = "display:block;width:100%;height:100%";
    stage.append(canvas); document.body.append(stage);
    const v = AtriumCanvas.create(canvas), I = v.internals();
    const board = Atrium.sheet("pcb", "Viewport resources"), defs = new Map();
    const track = {id:"resource-track",kind:"track",layer:"Top",points:[[0,0],[4,2],[8,0]],width:.5};
    board.items.push(track);
    const dpr = Math.max(1, Math.min(4, devicePixelRatio || 1)), opacity = PCB.opacity.track;
    const opts = {editorPane:true,noReuse:true,grid:false,origin:false};
    const size = (w,h) => {
      stage.style.width = w/dpr + "px"; stage.style.height = h/dpr + "px";
      v.resized();
    };
    const sample = () => {
      v.render(board,defs,opts);
      const s = GPU().stats(I), gpu = canvas.previousElementSibling, status = GPU().status(I);
      return {renderer:status.renderer,reason:status.reason,backing:gpu && [gpu.width,gpu.height],
        bytes:s?.gpuBytes,backingBytes:gpu && gpu.width * gpu.height * 4,builds:s?.builds,frames:s?.acc?.frames};
    };
    try {
      PCB.setOpacity("track", .5);
      size(384,384); v.fit(board,defs);
      const control = sample(), cap = 1048576;
      globalThis.__atriumGpuCapMB = 1;
      const rejected = sample(), repeated = sample();
      size(180,160); const recovered = sample();
      size(720,480); const tooLarge = sample();
      size(180,160); const back = sample();
      const states = {control,rejected,repeated,recovered,tooLarge,back};
      if (control.renderer !== "gpu" || !(control.backingBytes < cap && control.bytes < cap && control.backingBytes + control.bytes > cap) ||
          rejected.renderer !== "2d" || !/GPU memory/.test(rejected.reason) || rejected.bytes !== 0 || rejected.backing?.join("x") !== "1x1" ||
          JSON.stringify(rejected) !== JSON.stringify(repeated) || recovered.renderer !== "gpu" || recovered.backing?.join("x") !== "180x160" ||
          tooLarge.renderer !== "2d" || tooLarge.bytes !== 0 || back.renderer !== "gpu" || back.bytes !== recovered.bytes)
        failLifecycle("viewportResources", JSON.stringify(states));
      else okLifecycle("viewportResources", JSON.stringify(states));

      PCB.setOpacity("track", 1); size(96,96);
      globalThis.__atriumGpuCapMB = .08;
      const original = sample();
      const gl = canvas.previousElementSibling.getContext("webgl2");
      const {bufferData,getError} = gl, clock = performance.now.bind(performance);
      const previousClock = Object.getOwnPropertyDescriptor(performance,"now");
      let time = clock(), offset = 0, uploads = 0, injectOOM = false;
      Object.defineProperty(performance,"now",{configurable:true,value:() => time ?? clock() + offset});
      gl.bufferData = function (...args) { uploads++; return bufferData.apply(this,args); };
      gl.getError = function () {
        if (!injectOOM) return getError.call(this);
        injectOOM = false;
        return this.OUT_OF_MEMORY;
      };
      const witness = () => ({...sample(), uploads});
      const ordinaryEdits = () => Array.from({length:6}, (_,i) => {
        track.width = .6+i/100;
        v.invalidate(board,[track]);
        return witness();
      });
      const stayed = (blocked, rows) => rows.every(row => row.renderer === "2d" && row.builds === blocked.builds &&
        row.uploads === blocked.uploads && row.bytes === 0 && row.reason === blocked.reason);
      try {
        const added = Array.from({length:2500}, (_,i) => ({...track,id:"resource-growth-"+i}));
        board.items = [...board.items,...added];
        const edited = witness(), retry = witness();
        board.items = [track]; const shrunk = witness();
        const growth = {original,edited,retry,shrunk};
        const withinCap = state => state.renderer === "gpu" && state.backing?.join("x") === "96x96" &&
          state.bytes > 0 && state.bytes + state.backingBytes <= .08*1048576;
        if (!withinCap(original) || edited.renderer !== "2d" || !/GPU memory/.test(edited.reason) ||
            edited.bytes !== 0 || edited.backing?.join("x") !== "1x1" ||
            !stayed(edited,[retry]) || retry.frames !== edited.frames ||
            !withinCap(shrunk) || shrunk.builds !== edited.builds+1 || shrunk.frames <= retry.frames || shrunk.uploads <= retry.uploads)
          failLifecycle("geometryCap", JSON.stringify(growth));
        else okLifecycle("geometryCap", JSON.stringify(growth));

        // Replace one track's contour without changing its identity or the number of items.
        const longPath = {id:"resource-contour",kind:"track",layer:"Top",width:.5,
          points:Array.from({length:2500},(_,n) => [n / 420,1 + n%2 / 40])};
        globalThis.__atriumGpuCapMB = .09;
        board.items.push(longPath);
        const contour = witness(), cappedEdits = ordinaryEdits();
        longPath.points = longPath.points.slice(0,2);
        v.invalidate(board,[longPath]);
        const simplified = witness();
        if (contour.renderer !== "2d" || !/GPU memory/.test(contour.reason) || !stayed(contour,cappedEdits) ||
            simplified.renderer !== "gpu" || simplified.builds !== cappedEdits.at(-1).builds + 1 ||
            simplified.uploads <= cappedEdits.at(-1).uploads)
          failLifecycle("geometryRetry", JSON.stringify({contour,cappedEdits,simplified}));
        else okLifecycle("geometryRetry", JSON.stringify({contour,lastEdit:cappedEdits.at(-1),simplified}));

        // Inject the driver's response after the real WebGL allocation and fence.
        time = null;
        delete globalThis.__atriumGpuCapMB;
        injectOOM = true;
        size(128,112); witness();
        const rejectedByDriver = await until(() => /GPU ran out of memory/.test(GPU().status(I).reason));
        if (!rejectedByDriver) { failLifecycle("driverMemoryRetry", JSON.stringify(GPU().status(I))); return; }
        time = clock();
        const oom = witness(), oomEdits = ordinaryEdits();
        const rev = I.cache.rev;
        const beforeIdle = {builds:GPU().stats(I).builds, uploads, ...GPU().resourceCounters(I)};
        time += 520;
        await settle(0);
        const afterIdle = {builds:GPU().stats(I).builds, uploads, ...GPU().resourceCounters(I)};
        offset = time - clock(); time = null;
        const resumed = witness();
        const fenced = await until(() => GPU().resourceCounters(I).driverMemoryChecks > beforeIdle.driverMemoryChecks);
        if (!stayed(oom,oomEdits) || beforeIdle.builds !== afterIdle.builds || beforeIdle.uploads !== afterIdle.uploads ||
            beforeIdle.driverFenceSubmissions !== afterIdle.driverFenceSubmissions || resumed.renderer !== "gpu" ||
            resumed.builds !== oom.builds+1 || resumed.uploads <= oom.uploads || I.cache.rev !== rev || !fenced ||
            GPU().status(I).renderer !== "gpu")
          failLifecycle("driverMemoryRetry", JSON.stringify({oom,oomEdits,beforeIdle,afterIdle,resumed,fenced}));
        else okLifecycle("driverMemoryRetry", JSON.stringify({oom,lastEdit:oomEdits.at(-1),resumed,fenced}));
      } finally {
        Object.assign(gl,{bufferData,getError});
        if (previousClock) Object.defineProperty(performance,"now",previousClock); else delete performance.now;
      }
    } finally {
      delete globalThis.__atriumGpuCapMB;
      PCB.setOpacity("track", opacity);
      if (v.dispose) v.dispose(); else GPU().release(I);
      stage.remove();
    }
  }

  function gridCapacity() {
    const stage = document.createElement("div"), canvas = document.createElement("canvas");
    stage.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:320px;height:240px";
    canvas.style.cssText = "display:block;width:100%;height:100%";
    stage.append(canvas); document.body.append(stage);
    const board = Atrium.sheet("pcb", "Grid capacity"), defs = new Map(), view = AtriumCanvas.create(canvas), I = view.internals();
    board.outline = []; board.grid = 1;
    const opts = {editorPane:true,noReuse:true,grid:true,origin:false};
    view.restoreCamera({cx:1.3,cy:-2.7,scale:13,referenceScale:13});
    view.render(board,defs,{...opts,grid:false});
    const gl = canvas.previousElementSibling?.getContext("webgl2");
    if (!gl) { view.dispose(); stage.remove(); failLifecycle("gridCapacity", "no GPU drawing context"); return; }
    const bufferData = gl.bufferData, bufferSubData = gl.bufferSubData;
    let allocations = 0, writes = 0;
    gl.bufferData = function (target,data,usage) {
      if (target === this.ARRAY_BUFFER && usage === this.DYNAMIC_DRAW) allocations++;
      return bufferData.apply(this,arguments);
    };
    gl.bufferSubData = function (target) {
      if (target === this.ARRAY_BUFFER) writes++;
      return bufferSubData.apply(this,arguments);
    };
    const image = () => {
      const c = GPU().composite(I);
      return c?.getContext("2d").getImageData(0,0,c.width,c.height).data;
    };
    const counts = () => ({allocations,writes,reported:GPU().resourceCounters(I).gridBufferAllocations});
    try {
      view.render(board,defs,opts);
      const first = image();
      for (let i = 0; i < 24; i++) {
        view.zoom(Math.exp(i % 8 < 4 ? .112 : -.112),[181,103]);
        view.render(board,defs,opts);
      }
      const stable = counts();
      view.zoom(1.19,[181,103]); view.render(board,defs,opts);
      const moved = image();
      stage.style.width = "1050px"; view.resized(); view.render(board,defs,opts);
      const wider = counts();
      const queries = ["getParameter","getError","fenceSync","clientWaitSync","readPixels"];
      const original = queries.map(k => gl[k]);
      let queried = 0, reports;
      try {
        queries.forEach((key,i) => { gl[key] = function () { queried++; return original[i].apply(this,arguments); }; });
        reports = Array.from({length:4}, () => [GPU().resourceCounters(I),GPU().diagnosticState?.(I)]);
      } finally {
        queries.forEach((key,i) => { gl[key] = original[i]; });
      }
      const recorded = reports[0][0], unchanged = reports.every(report => JSON.stringify(report) === JSON.stringify(reports[0]));
      if (stable.allocations !== 1 || stable.writes !== 25 || wider.allocations !== 2 || wider.writes !== 27 ||
          stable.reported !== stable.allocations || wider.reported !== wider.allocations ||
          queried || !unchanged || typeof recorded.exactCamera !== "boolean" || typeof recorded.slicing !== "boolean" ||
          reports[0][1]?.work?.gridBufferAllocations !== wider.allocations ||
          !first || !moved || !differentBytes(first,moved))
        failLifecycle("gridCapacity", JSON.stringify({stable,wider,queried,unchanged,changed:!!first && !!moved && differentBytes(first,moved)}));
      else okLifecycle("gridCapacity", "25 updates shared one buffer, a resize grew it once, and diagnostic reads issued zero driver queries");
    } finally {
      gl.bufferData = bufferData; gl.bufferSubData = bufferSubData;
      view.dispose(); stage.remove();
    }
  }

  function earlySettle() {
    const row = gpuEarlySettle(GPU());
    if (!row.moved || !row.sharpening || !row.retained || !row.markerDrawn || !row.appearanceExact || row.appearanceMismatch || !row.hiddenPixels)
      failLifecycle("earlySettle", JSON.stringify(row));
    else okLifecycle("earlySettle", "early repaint draws the marker over the retained zoom and hiding silk draws the new appearance");
  }

  function zoomOutGesture() {
    const row = gpuZoomOutGesture(GPU());
    if (row.fullFrames || !row.builds || row.builds > row.limit || !row.exactInk || row.unmatched > .03)
      failLifecycle("zoomOutGesture", JSON.stringify(row));
    else okLifecycle("zoomOutGesture", `${row.frames} outward gesture frames scaled retained layers, with ${row.builds} wider builds and ${(row.unmatched * 100).toFixed(2)}% of exact pixels unmatched`);
  }

  // The same zoom out when the wider layers cannot fit under the memory cap, or their build throws:
  // the exact frames draw it, the build is not retried on every frame, and the GPU renderer stays on.
  function zoomOutMemory() {
    const row = gpuZoomOutGesture(GPU(), "cap");
    if (row.builds || row.attempts > 1 || !row.alive || !row.frames) failLifecycle("zoomOutMemory", JSON.stringify(row));
    else okLifecycle("zoomOutMemory", `${row.frames} outward frames under a ${row.capMB} MB cap: no wider build, GPU kept`);
  }
  function zoomOutFailure() {
    const row = gpuZoomOutGesture(GPU(), "throw");
    if (row.builds || row.attempts !== 1 || !row.alive || row.fullFrames !== row.frames) failLifecycle("zoomOutFailure", JSON.stringify(row));
    else okLifecycle("zoomOutFailure", `a failed wider build was tried once; ${row.frames} exact gesture frames on the GPU`);
  }

  async function terminalOverlay() {
    const row = await gpuTerminalOverlay(GPU());
    if (!row.marker || !row.coverage || row.beforeCallback || row.beforeAfter || row.nextFresh || row.nextFreshComposite)
      failLifecycle("terminalOverlay", JSON.stringify(row));
    else okLifecycle("terminalOverlay", "analytic coverage preserves the visible overlay until the fresh exact frame");
  }

  function pourCoverageBounds() {
    const usesReadback = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent);
    const stage = document.createElement("div"), canvas = document.createElement("canvas");
    stage.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:360px;height:256px";
    canvas.style.cssText = "display:block;width:100%;height:100%";
    stage.append(canvas); document.body.append(stage);
    const ctx = canvas.getContext("2d",{willReadFrequently:true}), view = AtriumCanvas.create(canvas), I = view.internals();
    const rect = (x,y,w,h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
    const region = (x,y,layer,escaped=false) => {
      const thin = Array.from({length:96}, (_,n) => [x+2+.37*Math.cos(n*Math.PI/48),y+2+.24*Math.sin(n*Math.PI/48)]);
      const rings = [rect(x,y,9,7), thin];
      if (escaped) rings.push(rect(x+14,y+3,2,2));
      return AtriumPCBPours.region(rings,layer,"GND");
    };
    const board = Atrium.sheet("pcb","Pour mask bounds"), defs = new Map();
    const top = region(-12,-9,"Top");
    const original = {...top}, bottom = region(-7,3,"Bottom",true);
    board.outline = rect(-45,-35,90,70);
    board.pcbDrawing = {annotations:{},pours:[top,bottom,AtriumPCBPours.region([rect(-14,-4,2,3)],"Top","SIG")]};
    board.sourcePourSignature = AtriumPCBPours.signature(board,defs);
    const opts = {editorPane:true,noReuse:true,grid:false,origin:false,showUnrouted:false,netNames:false};
    const getImage = ctx.getImageData;
    let bytes = 0, allocated = 0;
    const proto = globalThis.WebGL2RenderingContext.prototype;
    const storage = ["texImage2D","texStorage2D"].map(name =>
      [name,proto[name],Object.getOwnPropertyDescriptor(proto,name)]);
    for (const [name,call] of storage) proto[name] = function (...args) {
      if (new Error().stack?.includes("pourCoverage")) allocated += args[3]*args[4]*(args[2]===this.ALPHA?1:4);
      return call.apply(this,args);
    };
    ctx.getImageData = function (...args) {
      if (new Error().stack?.includes("pourCoverage")) bytes += args[2]*args[3]*4;
      return getImage.apply(this,args);
    };
    const paint = (cx,cy,scale,flipped=false,highlight=undefined,moving=false,viewOptions={}) => {
      view.restoreCamera({cx,cy,scale,flipped,referenceScale:10});
      if (moving) view.moving();
      bytes = allocated = 0;
      view.render(board,defs,{...opts,...viewOptions,highlight,noReuse:!moving});
      const stats = GPU().stats(I), c = GPU().composite(I);
      if (!c || !stats) throw Error("no GPU coverage frame");
      return {image:c.getContext("2d").getImageData(0,0,c.width,c.height), bytes, allocated,
        uploaded:stats.coverageUpload, memory:stats.gpuBytes, fanUploads:stats.pourUploads, coverageMs:stats.last.coverage};
    };
    try {
      const close = paint(0,-1,10), retreat = paint(8,-2,8), reverse = paint(0,-1,10,true,"GND");
      const moving = paint(-3,-1,11,true,"GND",true);
      const settled = paint(0,-1,10,true,"GND");
      Object.assign(top,region(-4,-12,"Top"));
      view.invalidate();
      const edited = paint(0,-1,10,true,"GND");
      const repeated = paint(0,-1,10,true,"GND");
      GPU().release(I); view.invalidate();
      const fresh = paint(0,-1,10,true,"GND");
      Object.assign(top,original);
      view.invalidate();
      const restored = paint(0,-1,10,true,"GND");
      const withIsland = paint(0,-1,10);
      Object.assign(bottom,region(-7,3,"Bottom")); view.invalidate();
      const removedIsland = paint(0,-1,10);
      GPU().release(I); view.invalidate();
      const freshWithoutIsland = paint(0,-1,10);
      const islandRemoved = differentBytes(withIsland.image.data,freshWithoutIsland.image.data);
      const islandStale = differentBytes(removedIsland.image.data,freshWithoutIsland.image.data);
      const rows = out.pourCoverageBounds = Object.fromEntries(Object.entries({close,retreat,reverse,moving,settled,edited,repeated,fresh,restored})
        .map(([key,{image:{data,width,height},...work}]) => [key,{...work,raster:rasterResidual(new Uint8ClampedArray(data.length),data,width,height)}]));
      const frameBytes = close.image.data.length;
      const changes = differentBytes(settled.image.data,edited.image.data), stale = differentBytes(edited.image.data,fresh.image.data);
      const restoredDiff = differentBytes(settled.image.data,restored.image.data);
      const {data,width,height} = close.image, dpr = width/360;
      const at = (x,y) => (Math.floor(height/2 + (y+1)*10*dpr)*width + Math.floor(width/2+x*10*dpr))*4;
      const thinHole = rgbDifference(data,data,at(-10,-7),at(-9,-7));
      const escapedInk = rgbDifference(data,data,at(8,7),at(10,7));
      if (!changes || stale || restoredDiff || !islandRemoved || islandStale || thinHole <= 16 || escapedInk <= 16 || repeated.uploaded ||
          usesReadback && [close,retreat,reverse].some(row => row.bytes <= 0 || row.bytes >= frameBytes))
        failLifecycle("pourCoverageBounds", JSON.stringify({changes,stale,restoredDiff,islandRemoved,islandStale,thinHole,escapedInk,frameBytes,reads:Object.values(rows).map(r=>r.bytes),
          repeated:repeated.uploaded,memory:[settled.memory,fresh.memory]}));
      else okLifecycle("pourCoverageBounds","camera reversal and edit match fresh copper, with bounded mask readbacks");

      // Hiding one copper layer should leave the other layer's exact mask ready.
      const hiddenOptions = {hidden:new Set(["Top"])};
      const paintHidden = () => paint(0,-1,10,false,undefined,false,hiddenOptions);
      const hidden = paintHidden(), shownAgain = paint(0,-1,10);
      GPU().release(I); view.invalidate();
      const freshHidden = paintHidden(), freshShown = paint(0,-1,10);
      const delta = (a,b) => differentBytes(a.image.data,b.image.data);
      const visibility = rows.visibility = {
        uploaded:[hidden.uploaded,shownAgain.uploaded,freshHidden.uploaded,freshShown.uploaded],
        allocated:[hidden.allocated,shownAgain.allocated],
        differences:[delta(hidden,freshHidden),delta(shownAgain,freshWithoutIsland),delta(hidden,shownAgain)],
        layerVisible:freshHidden.uploaded>0
      };
      if (hidden.uploaded || hidden.allocated || !shownAgain.uploaded ||
          shownAgain.uploaded >= freshWithoutIsland.uploaded || !visibility.layerVisible ||
          visibility.differences[0] || visibility.differences[1] || !visibility.differences[2])
        failLifecycle("pourCoverageVisibility",JSON.stringify(visibility));
      else okLifecycle("pourCoverageVisibility","a visibility toggle keeps untouched copper pixels ready");

      // Sample both sides of a winding void inside a stored pour, far enough
      // from its edges that antialiasing cannot account for a missing sample.
      const wave=Array.from({length:97},(_,i)=>{const x=-12+i/4; return [x,2*Math.sin(.7*x)];});
      const slot=[...wave.map(([x,y])=>[x,y-1]),...wave.slice().reverse().map(([x,y])=>[x,y+1])];
      board.pcbDrawing.pours=[AtriumPCBPours.region([rect(-14,-9,28,16),slot],"Top","GND")];
      view.invalidate();
      const winding=paint(0,-1,10);
      GPU().enable(false);
      view.render(board,defs,opts);
      const canvasWinding=ctx.getImageData(0,0,width,height).data;
      GPU().enable(true);
      const clearSample=at(16,0), metalSample=at(0,5);
      const windingCoverage=pixels=> {
        const matches=(x,y,sample)=>rgbDifference(pixels,pixels,at(x,y),sample)===0;
        return rgbDifference(pixels,pixels,clearSample,metalSample)>16 &&
          wave.slice(4,-4).every(([x,y])=>matches(x,y,clearSample) &&
            matches(x,y-2.5,metalSample) && matches(x,y+2.5,metalSample));
      };
      if (!winding.fanUploads || winding.uploaded || !windingCoverage(canvasWinding) || !windingCoverage(winding.image.data))
        failLifecycle("pourStencilInterior","stored copper or its winding clearance disagreed with interior samples");
      else okLifecycle("pourStencilInterior","solid copper and a winding void survive native stencil drawing");

      // Center a 0.55-device-pixel clearance on a sample column. Its contrast
      // must survive Canvas coverage and the actual GPU composite.
      const k = 10*dpr, x = (Math.floor(width/2+6*k)+.5-width/2)/k;
      const widthPx = .55, body = rect(4,-8,4,6);
      const gapAt = (cx,y=-7,h=3) => rect(cx-widthPx/(2*k),y,widthPx/k,h);
      const otherGap = gapAt(7);
      const narrow = AtriumPCBPours.region([body,gapAt(x),otherGap],"Top","GND");
      board.pcbDrawing.pours = [narrow];
      view.invalidate();
      GPU().enable(false);
      view.restoreCamera({cx:0,cy:-1,scale:10,referenceScale:10});
      view.render(board,defs,opts);
      const reference = ctx.getImageData(0,0,width,height).data;
      GPU().enable(true);
      const actual = paint(0,-1,10);
      // Keep the second clearance so the fault controls use the same coverage path.
      const repaint = holes => {
        Object.assign(narrow,AtriumPCBPours.region([body,...holes,otherGap],"Top","GND"));
        view.invalidate();
        return paint(0,-1,10);
      };
      const filled = repaint([]), shiftX = x+1/k, shifted = repaint([gapAt(shiftX)]);
      const interrupted = repaint([gapAt(x,-7,2),gapAt(x,-5+1/k,1-1/k)]);
      const clear = at(3,-6), copper = at(5,-6);
      const channel = [0,1,2].reduce((a,b) => Math.abs(reference[copper+b]-reference[clear+b]) >
        Math.abs(reference[copper+a]-reference[clear+a]) ? b : a);
      const start = reference[clear+channel], contrast = reference[copper+channel]-start;
      const profile = (pixels,cx=x) => {
        const row = width*4, ink = [];
        for (let i = at(cx,-7)+row; i < at(cx,-4)-row; i += row) ink.push((pixels[i+channel]-start)/contrast);
        return ink;
      };
      const a = profile(reference), b = profile(actual.image.data), c = profile(filled.image.data);
      const oldPosition = profile(shifted.image.data), newPosition = profile(shifted.image.data,shiftX);
      // A half-covered pixel can show nearly the same gap as Canvas. Check the
      // contrast along the entire slit so a one-pixel interruption is still detected.
      const retainsContrast = (ink,i) => 1-ink >= .75*(1-a[i]);
      const brokenRows = profile(interrupted.image.data).filter((ink,i) => !retainsContrast(ink,i)).length;
      const result = rows.narrowGap = {reference:a,composite:b,filled:c,oldPosition,newPosition,brokenRows,uploaded:[actual.uploaded,filled.uploaded]};
      if (Math.abs(contrast)<16 || !a.every(ink => 1-ink >= .75*widthPx) || !b.every(retainsContrast) ||
          c.some(ink => ink<.9) || oldPosition.some(retainsContrast) || !newPosition.every(retainsContrast) ||
          !brokenRows || brokenRows>3)
        failLifecycle("pourCoverageNarrowGap",JSON.stringify(result));
      else okLifecycle("pourCoverageNarrowGap","a subpixel clearance retains contrast where drawn, including after a one-pixel move");

      // Offscreen admission and exact re-entry apply to both texture upload paths.
      {
        rows.offscreen = [];
        board.outline = rect(-100,-100,200,200);
        // Keep the copper layer in the draw list even when both pours leave the viewport.
        board.items.push({id:"visible-track",kind:"track",layer:"Top",width:.4,points:[[-2,0],[2,0]]});
        board.sourcePourSignature = AtriumPCBPours.signature(board,defs);
        for (const [w,h,flipped] of [[360,256,false],[842,717,true]]) {
          stage.style.width = w+"px"; stage.style.height = h+"px";
          GPU().release(I); view.invalidate();
          const poses = offset => paint(offset,0,10,flipped);
          board.pcbDrawing.pours = [];
          const enteringCamera = 3.2;
          const empty = poses(0), emptyEnter = poses(enteringCamera);
          const edge = w/20, north = -h/20+.3, south = h/20-7-.3;
          const right = region(edge+.4,north,"Top"), left = region(-edge-9.5,south,"Top");
          board.pcbDrawing.pours = [right];
          const single = poses(0);
          board.pcbDrawing.pours = [right,left];
          const disjoint = poses(0), enter = poses(enteringCamera), exit = poses(0);
          Object.assign(right,region(edge+.45,north,"Top"));
          view.invalidate();
          const edited = poses(0);
          GPU().release(I); view.invalidate();
          const fresh = poses(0);
          const imageDelta = (a,b) => differentBytes(a.image.data,b.image.data);
          const track = [single,disjoint,enter,exit,edited,fresh];
          const sample = (x,y) => {
            const {width,height,data} = enter.image, density = 10*width/w;
            const i = Math.floor(width/2+(x-enteringCamera)*density*(flipped?-1:1));
            const j = Math.floor(height/2+y*density);
            return rgbDifference(emptyEnter.image.data,data,(j*width+i)*4);
          };
          const report = {flipped,width:empty.image.width,height:empty.image.height,
            upload:track.map(frame=>frame.uploaded), readback:track.map(frame=>frame.bytes),
            allocated:track.map(frame=>frame.allocated), fanUploads:track.map(frame=>frame.fanUploads),
            noInk:[single,disjoint,exit,edited,fresh].map(frame=>imageDelta(empty,frame)),
            entered:rasterResidual(emptyEnter.image.data,enter.image.data,enter.image.width,enter.image.height),
            hole:sample(edge+2.4,north+2), ink:sample(edge+1.4,north+2)};
          rows.offscreen.push(report);
          const limit = empty.image.width * empty.image.height / 25;
          if (report.noInk.some(Boolean) || report.hole>8 || report.ink<=16 ||
              [single,disjoint,exit,edited,fresh].some(frame=>frame.uploaded || frame.bytes) ||
              !enter.uploaded || (usesReadback ? enter.uploaded>=limit || !enter.bytes || enter.bytes>=limit*4 : enter.bytes!==0))
            failLifecycle("pourCoverageOffscreen",JSON.stringify({...report,entered:undefined}));
          if ([single,disjoint,exit,edited,fresh].some(frame=>frame.allocated) || !enter.allocated || report.fanUploads.some(Boolean))
            failLifecycle("pourCoverageOffscreenStorage",JSON.stringify({allocated:report.allocated,fanUploads:report.fanUploads}));

          // Repeated offscreen/onscreen reversals keep the existing mask, even
          // with multiple ink colors in one RGBA layer.
          GPU().release(I); view.invalidate();
          const mixed = {...region(edge+.45,north+4,"Top"),net:"SIG"};
          board.pcbDrawing.pours = [];
          const clear = paint(0,0,10,flipped,"GND");
          board.pcbDrawing.pours = [right,mixed];
          const visible = paint(enteringCamera,0,10,flipped,"GND");
          const bounces = [];
          for (let n=0;n<3;n++) {
            const a = paint(0,0,10,flipped,"GND"), b = paint(enteringCamera,0,10,flipped,"GND");
            bounces.push({read:a.bytes+b.bytes,upload:a.uploaded+b.uploaded,allocated:a.allocated+b.allocated,
              emptyDelta:imageDelta(a,clear),returnDelta:imageDelta(b,visible),exitCoverageMs:a.coverageMs});
          }
          report.bounces = {visibleAllocated:visible.allocated,rows:bounces};
          if (visible.allocated!==empty.image.width*empty.image.height*4 ||
              bounces.some(row=>row.upload || row.read || row.allocated || row.emptyDelta || row.returnDelta))
            failLifecycle("pourCoverageOffscreenBounce",JSON.stringify(report.bounces));

          const mixedAt = offset => paint(offset,0,10,flipped,"GND");
          const dormant = mixedAt(0);
          const backing = dormant.image.width * dormant.image.height * 4;
          const cap = globalThis.__atriumGpuCapMB;
          let pressured;
          try {
            globalThis.__atriumGpuCapMB = (dormant.memory + backing - 1) / 1048576;
            pressured = mixedAt(0);
          } finally {
            if (cap === undefined) delete globalThis.__atriumGpuCapMB;
            else globalThis.__atriumGpuCapMB = cap;
          }
          const returned = mixedAt(enteringCamera);
          const emptyAgain = mixedAt(0), retainedAgain = mixedAt(enteringCamera);
          GPU().release(I); view.invalidate();
          const freshReturn = mixedAt(enteringCamera);
          report.pressure = {freed: dormant.memory - pressured.memory, expected: visible.allocated,
            whileOffscreen: imageDelta(clear,pressured), allocationOnReturn: returned.allocated,
            uploadOnReturn: returned.uploaded, freshDelta: imageDelta(returned,freshReturn),
            nextUpload: emptyAgain.uploaded + retainedAgain.uploaded,
            nextAllocation: emptyAgain.allocated + retainedAgain.allocated};
          if (report.pressure.freed !== visible.allocated || report.pressure.whileOffscreen ||
              pressured.uploaded || pressured.allocated || returned.allocated !== visible.allocated ||
              !returned.uploaded || report.pressure.freshDelta || report.pressure.nextUpload || report.pressure.nextAllocation)
            failLifecycle("pourCoveragePressure",JSON.stringify(report.pressure));

          mixedAt(0);
          const otherCamera = mixedAt(enteringCamera+1);
          GPU().release(I); view.invalidate();
          const freshCamera = mixedAt(enteringCamera+1);
          mixedAt(0);
          Object.assign(right,region(edge+1.25,north,"Top")); view.invalidate();
          mixedAt(0);
          const changed = mixedAt(enteringCamera+1);
          GPU().release(I); view.invalidate();
          const freshEdit = mixedAt(enteringCamera+1);
          if (!otherCamera.uploaded || !changed.uploaded || !imageDelta(visible,otherCamera) ||
              !imageDelta(freshCamera,changed) || imageDelta(otherCamera,freshCamera) || imageDelta(changed,freshEdit))
            failLifecycle("pourCoverageOffscreenReturn","a changed camera or edited contour did not restore fresh copper");
        }
        if (!out.failures.some(f=>f.includes("pourCoverageOffscreen")))
          okLifecycle("pourCoverageOffscreen","empty padded pours skip allocation and repeat camera visits reuse the mask");
      }
    } finally {
      ctx.getImageData = getImage;
      for (const [name,,descriptor] of storage) {
        if (descriptor) Object.defineProperty(proto,name,descriptor);
        else delete proto[name];
      }
      view.dispose(); stage.remove();
    }
  }

  async function pourCoverageLod() {
    const stage = document.createElement("div"), canvas = document.createElement("canvas");
    stage.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:360px;height:256px";
    canvas.style.cssText = "display:block;width:100%;height:100%";
    stage.append(canvas); document.body.append(stage);
    const view = AtriumCanvas.create(canvas), I = view.internals(), P = AtriumPCBPours, {lod} = P;
    const board = Atrium.sheet("pcb","Coverage display detail"), defs = new Map();
    const opacity = PCB.opacity.track, enabled = lod.enabled, dpr = Math.min(4,Math.max(1,devicePixelRatio));
    const rect = (x,y,w,h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
    const shape = offset => P.region([rect(-17,-12,34,24), ...Array.from({length:30},(_,n) =>
      Array.from({length:96},(_,i)=>{
        const a = i*Math.PI/48;
        return [-13+(n%6)*5+offset+.45*Math.cos(a),-9+Math.floor(n/6)*4+.65*Math.sin(a)];
      }))],"Top","GND");
    board.outline = rect(-21,-16,42,32);
    board.items = [{id:"lod-ordered-track",kind:"track",layer:"Top",width:.4,points:[[-16,0],[16,0]]}];
    board.sourcePourSignature = P.signature(board,defs);
    const rows = out.pourCoverageLod = {};
    let region;
    try {
      for (const ordered of [false,true]) {
        PCB.setOpacity("track",ordered?.5:1);
        lod.enabled = true;
        region = shape(0);
        board.pcbDrawing = {annotations:{},pours:[region]};
        board.sourcePourSignature = P.signature(board,defs);
        view.invalidate();
        const paint = deviceScale => {
          view.restoreCamera({cx:0,cy:0,scale:deviceScale/dpr,referenceScale:deviceScale/dpr});
          view.render(board,defs,{editorPane:true,noReuse:true,grid:false,origin:false,netNames:false,showUnrouted:false});
          const work=GPU().resourceCounters(I), image=GPU().composite(I);
          if (!work || !image) throw Error("no coverage display-detail frame");
          return {bytes:ordered?work.textUpload:work.coverageUpload,
            pixels:image.getContext("2d").getImageData(0,0,image.width,image.height).data};
        };
        const high=paint(26), firstVersion=lod.version;
        // Let an actual idle result arrive for the same copper at another scale.
        const waiting=P.lodRingsAt(region,4);
        if (waiting || !await until(()=>lod.version!==firstVersion && P.lodRingsAt(region,4)))
          throw Error("low-scale display detail did not finish");
        const highAgain=paint(26);
        // The low-scale view must use a real new level, even at a fixed pose.
        P.release([region],[]);
        const secondVersion=lod.version, low=paint(4);
        if (!await until(()=>lod.version!==secondVersion && P.lodRingsAt(region,4)))
          throw Error("the low-scale painter did not request its display detail");
        const upgraded=paint(4), repeated=paint(4);
        lod.enabled=false;
        const disabled=paint(4);
        lod.enabled=true;
        const enabledAgain=paint(4);
        const raw={...region}, moved=shape(.22);
        Object.assign(region,moved); view.invalidate();
        const edited=paint(26);
        Object.assign(region,raw); view.invalidate();
        const restored=paint(26);
        Object.assign(region,moved); view.invalidate();
        const redone=paint(26);
        const report = rows[ordered?"ordered":"mask"] = {
          initial:high.bytes, highAgain:highAgain.bytes, highDelta:differentBytes(high.pixels,highAgain.pixels),
          upgraded:upgraded.bytes, lowDelta:differentBytes(low.pixels,upgraded.pixels), repeated:repeated.bytes,
          disabled:disabled.bytes, enabledAgain:enabledAgain.bytes,
          disabledDelta:differentBytes(low.pixels,disabled.pixels), enabledDelta:differentBytes(upgraded.pixels,enabledAgain.pixels),
          editDelta:differentBytes(high.pixels,edited.pixels), restoreDelta:differentBytes(high.pixels,restored.pixels),
          redoDelta:differentBytes(edited.pixels,redone.pixels)};
        if (!report.initial || report.highAgain || report.highDelta || !report.upgraded || !report.lowDelta ||
            report.repeated || !report.disabled || !report.enabledAgain || report.disabledDelta || report.enabledDelta ||
            !report.editDelta || report.restoreDelta || report.redoDelta)
          failLifecycle("pourCoverageLod",JSON.stringify(report));
        P.release([region],[]);
      }
      if (!out.failures.some(f=>f.includes("pourCoverageLod")))
        okLifecycle("pourCoverageLod","only applicable display detail invalidates coverage and ordered copper");
    } finally {
      if (region) P.release([region],[]);
      lod.enabled=enabled; PCB.setOpacity("track",opacity);
      view.dispose(); stage.remove();
    }
  }

  function emptyTextBands() {
    const readsImageData = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent);
    const stage = document.createElement("div"), canvas = document.createElement("canvas");
    stage.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:324px;height:240px";
    canvas.style.cssText = "display:block;width:100%;height:100%";
    stage.append(canvas); document.body.append(stage);
    // Keep this diagnostic's repeated readbacks on one Canvas2D raster backend.
    canvas.getContext("2d",{willReadFrequently:true});
    const board = Atrium.sheet("pcb", "Ordered text bands"), view = AtriumCanvas.create(canvas), I = view.internals();
    const part = {id:"band-part",kind:"part",def:"band-footprint",layer:"Top",x:0,y:0,showRef:false};
    const track = {id:"band-track",kind:"track",layer:"Top",width:.4,points:[[-4,4],[4,4]]};
    const visible = {kind:"text",layer:"Top",x:0,y:0,text:"Occupied",size:1.2,width:.13};
    const moved = {kind:"text",layer:"Mechanical 15",x:35,y:-2,text:"Refill",size:1.3,width:.16,angle:37,align:"center"};
    const hairline = {id:"band-stroke",kind:"graphic",layer:"Mechanical 15",keepout:true,width:.06,
      points:[[9.02,-4],[9.02,2]]};
    const opts = {editorPane:true,noReuse:true,grid:false,origin:false,showUnrouted:false,netNames:false};
    const defs = x => new Map([[part.def,{footprint:{shapes:[visible,{...moved,x}],pads:[]}}]]);
    board.items = [track,part];
    view.restoreCamera({cx:0,cy:0,scale:18,referenceScale:18});
    view.render(board,defs(35),{...opts,hidden:new Set(["Top","Mechanical 15"])});
    const gl = canvas.previousElementSibling?.getContext("webgl2");
    if (!gl) { view.dispose(); stage.remove(); failLifecycle("emptyTextBands", "no GPU drawing context"); return; }
    const upload = gl.texSubImage2D, ctx2d = canvas.getContext("2d");
    let uploads = [];
    gl.texSubImage2D = function (...args) {
      const [target,level,x,bottom,w,h,format,type,source] = args;
      // This fixture has no pours. Only RGBA canvas and ImageData transfers carry text bands.
      if (args.length === 9 && target === gl.TEXTURE_2D && level === 0 && format === gl.RGBA && type === gl.UNSIGNED_BYTE &&
          (source === canvas || source instanceof ImageData)) {
        const y = canvas.height-bottom-h;
        const valid = w > 0 && h > 0 && x >= 0 && y >= 0 && x+w <= canvas.width && y+h <= canvas.height &&
          (source === canvas || source.width === w && source.height === h);
        const pixels = valid && (source === canvas ? ctx2d.getImageData(x,y,w,h) : source);
        uploads.push({rect:[x,y,w,h],valid,cropped:w < canvas.width || h < canvas.height,
          ink:!!pixels && pixels.data.some((value,index) => index%4===3 && value!==0)});
      }
      return upload.apply(this,args);
    };
    const paint = (x, stroke=false) => {
      uploads = [];
      board.items = stroke ? [track,part,hairline] : [track,part];
      view.invalidate();
      view.render(board,defs(x),opts);
      return {uploads,bands:uploads.map(row => row.ink),pixels:GPU().composite(I)?.toDataURL()};
    };
    try {
      const empty = paint(35), occupied = paint(1), edgeText = paint(9.02), edgeStroke = paint(35,true), cleared = paint(35);
      const withText = GPU().stats(I).gpuBytes;
      board.items = [track]; view.invalidate(); view.render(board,defs(35),opts);
      const released = withText - GPU().stats(I).gpuBytes;
      const restored = paint(35);
      const cases = {empty,occupied,edgeText,edgeStroke,cleared}, ref = document.createElement("canvas"), dpr = I.cam()[6];
      ref.width=canvas.width; ref.height=canvas.height;
      const ctx = ref.getContext("2d",{willReadFrequently:true}), k = view.scale()*dpr;
      ctx.setTransform(k,0,0,k,ref.width/2,ref.height/2);
      AtriumPCBDraw.drawKeepout(ctx,hairline,{scale:view.scale(),ink:"#ff0000"});
      const ink = ctx.getImageData(ref.width-2,0,2,ref.height).data.some((value,index) => index%4===3 && value!==0);
      const emptyBands = readsImageData ? "true" : "false,true";
      const croppedText = occupied.uploads.some(row => row.cropped && row.ink);
      const croppedEdge = edgeText.uploads.some(({rect:[x,,w],cropped,ink}) => cropped && ink && x+w === canvas.width);
      if (!ink || !Object.values(cases).every(row => row.pixels && row.uploads.every(upload => upload.valid)) ||
          readsImageData && (!croppedText || !croppedEdge) ||
          String(empty.bands)!==emptyBands || String(cleared.bands)!==emptyBands ||
          [occupied,edgeText,edgeStroke].some(row => String(row.bands)!=="true,true" || row.pixels===empty.pixels) ||
          empty.pixels!==cleared.pixels || released < canvas.width*canvas.height*4 || restored.pixels!==cleared.pixels)
        failLifecycle("emptyTextBands", JSON.stringify({ink,croppedText,croppedEdge,released,restored:restored.pixels===cleared.pixels,cases:Object.fromEntries(Object.entries(cases).map(([k,row]) =>
          [k,{uploads:row.uploads,pixelsChanged:!!row.pixels&&row.pixels!==empty.pixels}]))}));
      else okLifecycle("emptyTextBands", "edge ink restored, deleting the final artwork released its textures, restoring it matched");
    } finally {
      gl.texSubImage2D = upload;
      view.dispose(); stage.remove();
    }
  }

  function padCaptionBounds() {
    const name = "padCaptionBounds";
    if (!/AppleWebKit/.test(navigator.userAgent) || /Chrome\/|Chromium\//.test(navigator.userAgent)) {
      okLifecycle(name,"skipped: caption bounds apply to WebKit readback");
      return;
    }
    const stage = document.createElement("div"), canvas = document.createElement("canvas");
    stage.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:300px;height:220px";
    canvas.style.cssText = "display:block;width:100%;height:100%";
    stage.append(canvas); document.body.append(stage);
    const ctx = canvas.getContext("2d",{willReadFrequently:true}), view = AtriumCanvas.create(canvas), I = view.internals();
    const board = Atrium.sheet("pcb","Pad caption bounds"), scale = 22;
    board.outline = [[-15,-12],[15,-12],[15,12],[-15,12]];
    const part = (id,x,y,angle,mirror,number,net) => ({
      id,kind:"part",def:id,layer:mirror?"Bottom":"Top",x,y,angle,mirror,showRef:false,showValue:false,pinNets:{[number]:net}
    });
    board.items = [part("front",-3.6,-2.3,12,false,"Pq7","AgypΩ"), part("mirrored",1.65,2.15,97,true,"Rgj","ω_NPg"),
      {id:"caption-via",kind:"via",layer:"Multi",x:6.79,y:-2.15,diameter:2.8,drill:.6,net:"Δgy"}];
    const defs = new Map(board.items.slice(0,2).map(item => [item.def,{footprint:{shapes:[],pads:[
      {number:Object.keys(item.pinNets)[0],layer:"Top",shape:"rect",x:0,y:0,w:4.6,h:3.1,angle:21}
    ]}}]));
    const rest = {editorPane:true,noReuse:true,grid:false,origin:false,showUnrouted:false,layer:"Top"};
    const seed = {cx:0,cy:0,scale:2,referenceScale:scale};
    const geometry = [
      {id:"start",cx:0,cy:0,netNames:true},
      {id:"shifted",cx:-1.4,cy:1.35,netNames:true},
      {id:"numberOnly",cx:-1.4,cy:1.35,netNames:false}
    ];
    const poses = [false,true].flatMap(flipped=>geometry.map(pose=>({...pose,flipped})));
    view.restoreCamera(seed); view.render(board,defs,rest);
    const gl = canvas.previousElementSibling?.getContext("webgl2");
    if (!gl) { view.dispose(); stage.remove(); failLifecycle(name,"no GPU drawing context"); return; }
    const upload = gl.texSubImage2D, fillText = ctx.fillText;
    let full = false, uploads, captions;
    try {
      ctx.fillText = function(text,x,y,...more) {
        if (captions) {
          const {a,b,c,d} = ctx.getTransform();
          captions.push({text,upright:a>0 && d>0 && Math.abs(b)+Math.abs(c)<.001});
        }
        return fillText.call(this,text,x,y,...more);
      };
      gl.texSubImage2D = function(...args) {
        const [target,level,x,bottom,w,h,format,type,source] = args;
        // With no pours or other artwork in the bands, these are the caption transfers.
        if (uploads && args.length===9 && target===gl.TEXTURE_2D && level===0 && format===gl.RGBA &&
            type===gl.UNSIGNED_BYTE && source instanceof ImageData) {
          const W=canvas.width, H=canvas.height, y=H-bottom-h;
          uploads.push({rect:[x,y,w,h],cropped:w<W || h<H,edge:x===0 || x+w===W,
            ink:source.data.some((value,index)=>index%4===3 && value!==0)});
          // Sample the same freshly painted source before scratch reuse. Full-band upload is
          // independent of the crop calculations and also clears all previous text pixels.
          if (full) return upload.call(this,target,level,0,0,W,H,format,type,ctx.getImageData(0,0,W,H));
        }
        return upload.apply(this,args);
      };
      const paint = ({cx,cy,flipped,netNames}) => {
        uploads = []; captions = [];
        view.restoreCamera({cx,cy,scale,referenceScale:scale,flipped});
        view.render(board,defs,{...rest,netNames});
        const surface = GPU().composite(I);
        if (!surface) throw Error("no GPU frame for pad captions");
        const image = surface.getContext("2d").getImageData(0,0,surface.width,surface.height).data;
        return {image,uploads,captions};
      };
      const cropped = poses.map(paint);
      full = true;
      const fallback = poses.map(paint);
      const report = poses.map(({id,flipped},n) => {
        const row=cropped[n];
        return {id,flipped,delta:differentBytes(row.image,fallback[n].image),uploads:row.uploads,
          referenceUploads:fallback[n].uploads.length,captions:row.captions};
      });
      out.padCaptionBounds = {dpr:I.cam()[6],rows:report};
      const text = ["Pq7","Rgj","AgypΩ","ω_NPg","Δgy"];
      const valid = report.every(({id,uploads,referenceUploads,captions,delta}) => !delta && referenceUploads>0 &&
        uploads.some(row=>row.cropped && row.ink) && captions.every(row=>row.upright) &&
        (id==="start" ? text.every(t=>captions.some(row=>row.text===t)) && uploads.some(row=>row.cropped && row.edge && row.ink) :
          id==="shifted" ? text.slice(0,4).every(t=>captions.some(row=>row.text===t)) :
            text.slice(0,2).every(t=>captions.some(row=>row.text===t)) && captions.every(row=>text.slice(0,2).includes(row.text))));
      if (!valid || differentBytes(cropped[0].image,cropped[1].image)===0 ||
          differentBytes(cropped[1].image,cropped[2].image)===0)
        failLifecycle(name,JSON.stringify(out.padCaptionBounds));
      else okLifecycle(name,"cropped captions match full source uploads through camera, edge and visibility changes");
    } finally {
      ctx.fillText = fillText;
      gl.texSubImage2D = upload;
      view.dispose(); stage.remove();
    }
  }

  function panStripUpload() {
    const key = "panStripUpload";
    if (!/(?:Chrome|Chromium)\//.test(navigator.userAgent)) { okLifecycle(key,"skipped: Chromium direct strip path"); return; }
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:257px;height:183px";
    document.body.append(canvas);
    const view = AtriumCanvas.create(canvas), I = view.internals(), defs = new Map();
    const doc = Atrium.sheet("pcb","Pan strip upload");
    doc.outline = [[-25,-16],[25,-16],[25,16],[-25,16]];
    doc.items = [
      {kind:"label",id:"east",layer:"Silk",x:10.2,y:1,size:1.4,width:.18,text:"Pgq"},
      {kind:"label",id:"west",layer:"Silk",x:-11.8,y:-1,size:1.6,width:.19,text:"Qjy"},
      {kind:"label",id:"north",layer:"Silk",x:-2,y:-7.6,size:1.3,width:.16,text:"Ag"},
      {kind:"label",id:"south",layer:"Silk",x:1,y:7.4,size:1.1,width:.18,text:"dj"},
      {kind:"label",id:"corner",layer:"Silk",x:10.4,y:7.45,size:1.9,width:.21,text:"Jq"}
    ];
    const opts={editorPane:true,grid:false,origin:false,showUnrouted:false,netNames:false};
    const opacity=PCB.layerAlpha("Silk"), rows=out.panStripUpload=[];
    try {
      PCB.setLayerOpacity("Silk",.63);
      for (const flipped of [false,true]) {
        const initial={cx:0,cy:0,scale:12,referenceScale:12,flipped};
        view.restoreCamera(initial); view.render(doc,defs,{...opts,noReuse:true});
        const gl=canvas.previousElementSibling?.getContext("webgl2");
        if (!gl) throw Error("no GPU strip context");
        const texSub=gl.texSubImage2D, fb=gl.createFramebuffer(), uploads=[], frames=[];
        const dpr=I.cam()[6];
        const pixels=()=>{
          const c=GPU().composite(I);
          if (!c) throw Error("no GPU strip frame");
          return c.getContext("2d").getImageData(0,0,c.width,c.height).data;
        };
        gl.texSubImage2D=function(...args) {
          const [target,level,x,y,w,h,format,type,source]=args;
          const direct=source instanceof HTMLCanvasElement && source!==canvas;
          if (args.length!==9 || target!==gl.TEXTURE_2D || level!==0 || format!==gl.RGBA ||
              type!==gl.UNSIGNED_BYTE || !(direct || source instanceof ImageData))
            return texSub.apply(this,args);
          const tex=gl.getParameter(gl.TEXTURE_BINDING_2D), prior=gl.getParameter(gl.FRAMEBUFFER_BINDING);
          const skip=gl.getParameter(gl.UNPACK_SKIP_ROWS), flip=gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
          const straight=!gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
          const expected=direct?source.getContext("2d").getImageData(0,0,w,h).data:source.data;
          const out=texSub.apply(this,args), actual=new Uint8Array(w*h*4);
          try {
            gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
            gl.readPixels(x,y,w,h,gl.RGBA,gl.UNSIGNED_BYTE,actual);
          } finally {
            gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,null,0);
            gl.bindFramebuffer(gl.FRAMEBUFFER,prior);
          }
          let delta=0, max=0, alphaDelta=0, ink=0;
          for(let i=0;i<actual.length;i++){
            const row=Math.floor(i/(w*4)), j=(h-1-row)*w*4+i%(w*4);
            const change=Math.abs(actual[i]-expected[j]);
            if(change) delta++;
            if(i%4===3) { if(change) alphaDelta++; if(expected[j]>0 && expected[j]<255) ink++; }
            max=Math.max(max,change);
          }
          uploads.push({direct,rect:[x,y,w,h],source:[source.width,source.height],skip,flip,straight,delta,max,alphaDelta,ink});
          return out;
        };
        try {
          const start=GPU().resourceCounters(I).retainedFrames;
          for(const [dx,dy] of [[13,-19],[-7,9],[3,1],[-1,-3],[-19,13]]) {
            view.pan(dx/dpr,dy/dpr); view.moving(); view.render(doc,defs,opts);
            frames.push({camera:view.camera(),pixels:pixels()});
            if (gl.getParameter(gl.UNPACK_SKIP_ROWS)!==0 || gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL))
              throw Error("strip upload did not restore unpack state");
          }
          const retained=GPU().resourceCounters(I).retainedFrames-start;
          const comparisons=[];
          gl.texSubImage2D=texSub;
          for(const frame of frames){
            view.restoreCamera(frame.camera); view.render(doc,defs,{...opts,noReuse:true});
            const fresh=pixels();
            comparisons.push({bytes:differentBytes(frame.pixels,fresh),strong:differentPixels(frame.pixels,fresh,16)});
          }
          rows.push({flipped,dpr,retained,uploads,comparisons});
        } finally {
          gl.texSubImage2D=texSub;
          gl.deleteFramebuffer(fb);
        }
      }
      const passed=rows.every(row=>row.retained===5 && row.uploads.length>0 &&
        row.uploads.every(u=>u.direct && u.flip && u.straight && !u.delta) &&
        row.uploads.some(u=>u.ink>0 && u.skip>0 && u.rect[1]>0) &&
        row.uploads.some(u=>u.rect[2]%2===1 || u.rect[3]%2===1) &&
        row.uploads.some(u=>u.source[0]>u.rect[2] || u.source[1]>u.rect[3]) &&
        row.uploads.some(u=>u.rect[2]>u.rect[3]) && row.uploads.some(u=>u.rect[3]>u.rect[2]) &&
        row.comparisons.every(c=>!c.bytes));
      if (passed) okLifecycle(key,"wrapped strips match full frames and the requested source texels");
      else failLifecycle(key,JSON.stringify(rows.map(({uploads,...row})=>({...row,uploads:uploads.length,
        direct:uploads.filter(u=>u.direct).length,incorrect:uploads.filter(u=>u.delta||!u.flip||!u.straight).slice(0,5),
        oversized:uploads.filter(u=>u.skip>0 && u.ink>0).length}))));
    } finally {
      PCB.setLayerOpacity("Silk",opacity);
      view.dispose(); canvas.remove();
    }
  }

  function emptyBandPan() {
    const readsImageData = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent);
    if (!readsImageData) { okLifecycle("emptyBandPan", "skipped: empty textures are deferred on the WebKit upload path"); return; }
    const result = gpuEmptyBandPan(GPU());
    if (result.frames !== 8 || result.allocations || result.readbacks || result.clears || !result.refilled || !result.restored || !result.clearedInk)
      failLifecycle("emptyBandPan", JSON.stringify({frames:result.frames,allocations:result.allocations,
        readbacks:result.readbacks,clears:result.clears,refilled:result.refilled,restored:result.restored,clearedInk:result.clearedInk}));
    else okLifecycle("emptyBandPan", "blank strips need no writes, entering ink refills the band, and a pan clears old ink before it wraps");
  }

  async function drcMarkerPan() {
    await AtriumLazy.need("AtriumDRCMarkers");
    const board = Atrium.sheet("pcb", "DRC marker crossing the viewport edge"), defs = new Map();
    const track = (id, x, y) => ({id,kind:"track",layer:"Top",width:.09,points:[[x-.12,y],[x+.12,y]]});
    // At this scale the one-CSS-pixel outline covers whole device pixels at DPR 1 and 2.
    const via = {id:"selected",kind:"via",layer:"Multi",x:21/32,y:175/32,diameter:.5,drill:.25};
    board.items = [track("strong",.04,6.02),track("visible",.74,6.7),via];
    board.outline = [[-3,-2],[25,-2],[25,16],[-3,16]];
    const findings = [{id:"strong",type:"width",at:[.04,6.02]}, {id:"visible",type:"width",warning:true,at:[.74,6.7]}];
    const paint = AtriumDRCMarkers.overlay(board,defs,findings);
    let damage = [];
    const trace = (ctx, frame) => { damage = frame.damageRects || []; paint(ctx, frame); };
    trace.panDamage = paint.panDamage;
    const stage = document.createElement("div");
    stage.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
    document.body.append(stage);
    const make = () => {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:384px;height:192px";
      stage.append(canvas);
      return AtriumCanvas.create(canvas);
    };
    const view = make(), exact = make();
    const opts = {editorPane:true,grid:false,origin:false,showUnrouted:false,netNames:false,
      layer:"Top",selected:via.id,overlay:[trace]};
    const scale = 16, cropTop = 79, cropWidth = 24, cropHeight = 8;
    function draw(v, left, moving) {
      v.restoreCamera({cx:12+left,cy:6,scale,referenceScale:scale});
      if (moving) v.moving();
      v.render(board, defs, {...opts,noReuse:!moving});
      if (GPU().status(v.internals()).renderer !== "gpu") throw Error("no GPU frame");
      const I = v.internals(), dpr = I.cam()[6];
      // The top edge and upper arms are above the DRC glyph and the lower rounded joins.
      const pixels = I.ctx.getImageData(0,cropTop*dpr,cropWidth*dpr,cropHeight*dpr);
      return {pixels,dpr};
    }
    try {
      draw(view, -.5, false);
      const steps = [.125,.6875,-.5].map(left => {
        const retained = draw(view,left,true).pixels, rects = damage.length;
        const {pixels:fresh,dpr} = draw(exact,left,false);
        if (retained.width !== fresh.width || retained.height !== fresh.height) throw Error("DRC pan and fresh frame differ in backing size");
        const half = via.diameter * scale / 2 + 2, center = (via.x - left) * scale;
        const lo = center - half, hi = center + half, top = via.y * scale - half;
        const devicePixel = 1 / dpr, singleStroke = Math.round(.7 * 255);
        const covered = (at, from, to) => at >= from && at + devicePixel <= to;
        let maxAlpha = 0, core = 0, strokeErrors = 0, clearErrors = 0;
        for (let row = 0; row < fresh.height; row++) for (let col = 0; col < fresh.width; col++) {
          const x = col / dpr, y = cropTop + row / dpr, i = (row * fresh.width + col) * 4 + 3;
          const a = fresh.data[i], b = retained.data[i];
          maxAlpha = Math.max(maxAlpha, Math.abs(a - b));
          const topEdge = covered(y,top-.5,top+.5) && covered(x,lo+1,hi-1);
          const sideEdge = y >= top+1.5 && (covered(x,lo-.5,lo+.5) || covered(x,hi-.5,hi+.5));
          if (topEdge || sideEdge) {
            // A full straight stroke must be present, at one pass of the 70% selection opacity.
            core++;
            if (Math.abs(a-singleStroke) > 5 || Math.abs(b-singleStroke) > 5) strokeErrors++;
          } else if (y + devicePixel <= top-.5 || y >= top+1.5 &&
              (x + devicePixel <= lo-.5 || x >= hi+.5 || covered(x,lo+.5,hi-.5))) {
            // The pixels alongside each straight arm must stay clear as the repaired area moves.
            if (a > 8 || b > 8) clearErrors++;
          }
        }
        return {left,rects,maxAlpha,core,strokeErrors,clearErrors};
      });
      const zoom = [false,true].map(flipped => {
        const gpu = GPU(), drc = AtriumDRCMarkers, I = view.internals();
        const ink = v => {
          const {ctx,canvas} = v.internals();
          return ctx.getImageData(0,0,canvas.width,canvas.height).data;
        };
        const markerOpts = {...opts,selected:null};
        view.restoreCamera({cx:11.5,cy:6,scale,referenceScale:scale,flipped});
        view.render(board,defs,{...markerOpts,noReuse:true});
        const retained = gpu.resourceCounters(I).retainedFrames, whole = drc.overviewStats().whole;
        view.zoom(1.125,view.worldToScreen(findings[0].at)); view.moving();
        view.render(board,defs,markerOpts);
        const moving = ink(view), end = drc.overviewStats().whole, frames = gpu.resourceCounters(I).retainedFrames-retained;
        exact.restoreCamera(view.camera());
        exact.render(board,defs,{...markerOpts,noReuse:true});
        return {flipped,frames,offscreen:end-whole,different:differentBytes(moving,ink(exact)),
          marker:moving.some((v,i) => i%4 === 3 && v > 200)};
      });
      const composition = [false,true].map(flipped => {
        const gpu = GPU(), I = view.internals(), markerOpts = {...opts,selected:null,overlay:[paint]};
        const pose = cx => ({cx,cy:6,scale,referenceScale:scale,flipped});
        const pixel = v => {
          const image = gpu.composite(v.internals()), dpr = v.internals().cam()[6];
          if (!image) throw Error("expected the composited GPU frame");
          const [x,y] = v.worldToScreen(findings[0].at);
          return image.getContext("2d").getImageData(Math.floor(x*dpr),Math.floor(y*dpr),1,1).data;
        };
        const isMarker = p => p[0] > 180 && p[1] > 50 && p[1] < 140 && p[2] > 45 && p[2] < 135;
        view.restoreCamera(pose(8)); view.render(board,defs,{...markerOpts,noReuse:true});
        const first = isMarker(pixel(view)), before = gpu.resourceCounters(I).retainedFrames;
        view.restoreCamera(pose(9.25)); view.moving(); view.render(board,defs,markerOpts);
        const pan = isMarker(pixel(view)), retained = gpu.resourceCounters(I).retainedFrames - before;
        view.render(board,defs,{...markerOpts,noReuse:true});
        const exact = isMarker(pixel(view));
        view.render(board,defs,{...markerOpts,overlay:[],noReuse:true});
        const omitted = isMarker(pixel(view));
        return {flipped,first,pan,retained,exact,omitted};
      });
      out.drcMarkerPan = steps;
      out.drcMarkerZoom = zoom;
      out.drcMarkerComposite = composition;
      if (composition.some(row => !row.first || !row.pan || row.retained !== 1 || !row.exact || row.omitted))
        failLifecycle("drcMarkerComposite", JSON.stringify(composition));
      else okLifecycle("drcMarkerComposite", "the composed frame keeps the visible marker at its anchor through retained pan and repaint");
      if (steps[0].rects < 2 || steps[2].rects < 2 || steps.some(row => !row.rects || !row.core || row.strokeErrors || row.clearErrors) ||
          zoom.some(row => row.frames !== 1 || row.offscreen || row.different || !row.marker))
        failLifecycle("drcMarkerPan", JSON.stringify({steps,zoom}));
      else okLifecycle("drcMarkerPan", "edge repairs preserve the via outline and retained zoom draws exact markers directly");
    } finally {
      view.dispose(); exact.dispose(); stage.remove();
    }
  }

  async function hidden() {
    const pane = H().panes().find(p => p.active), {canvas, view: pv} = pane, r0 = pv.render;
    const via = H().doc().items.find(i => i.kind === "via");
    if (!via) okLifecycle("hidden", "skipped: no via");
    else {
      GPU().enable(true); H().zoomTo([via.x - 1.5, via.y - 1.5, via.x + 1.5, via.y + 1.5]); await settle(300); await ready();
      let last = null; pv.render = (...a) => { last = a; return r0(...a); }; H().redraw(); await settle(80); pv.render = r0;
      const [d, f, op] = last || [], dpr = canvas.width / (canvas.clientWidth || canvas.width);
      const q = pv.worldToScreen([via.x, via.y]), r = (via.diameter || .6) * pv.camera().scale / 2 * dpr;
      const box = [Math.floor(q[0] * dpr - r), Math.floor(q[1] * dpr - r), Math.ceil(2 * r), Math.ceil(2 * r)];
      const grab = (gpu, hide) => {
        GPU().enable(gpu); pv.render(d, f, {...op, overlay: undefined, noReuse: true, hide});
        const c = gpu ? GPU().composite() : canvas;
        return c ? c.getContext("2d").getImageData(...box).data : null;
      };
      const shown = grab(true, null), gone = grab(true, new Set([via])), flat = grab(false, new Set([via]));
      const area = box[2] * box[3];
      if (!shown || !gone) failLifecycle("hidden", "no GPU frame");
      else if (differentPixels(shown,gone,48) < area / 4) failLifecycle("hidden", "the GPU frame still draws a hidden via (" + differentPixels(shown,gone,48) + " of " + area + " px changed)");
      else if (differentPixels(gone,flat,48) > area / 10) failLifecycle("hidden", differentPixels(gone,flat,48) + " of " + area + " px differ from the 2D frame where the via was");
      else okLifecycle("hidden", "ok (" + differentPixels(shown,gone,48) + " of " + area + " px)");
      GPU().enable(true); act("fit"); await settle(400); H().redraw(); await settle(60); await ready();
    }
  }

  async function parked() {
    const board = H().doc(), other = H().project().documents.find(x => x !== board);
    if (!other) okLifecycle("parked", "skipped: one document");
    else {
      H().redraw(); await settle(60); const b0 = GPU().stats().builds;
      H().selectDocument(other.id); await settle(200); H().selectDocument(board.id); await settle(300); H().redraw(); await settle(60);
      const b1 = GPU().stats().builds, why = await same();
      if (why) failLifecycle("parked", why); else okLifecycle("parked", b1 === b0 ? "ok (no rebuild)" : "ok, rebuilt (" + (b1 - b0) + ") — canvas-fast.js did not park the cache");
    }
  }

  async function splitPane() {
    H().redraw();
    const oneDrawn = await until(() => {
      const pane = H().panes()[0], st = pane?.view?.internals();
      return st && GPU().stats(st)?.acc?.frames && GPU().status(st).renderer === "gpu";
    });
    if (!oneDrawn) { failLifecycle("splitPane", "the original PCB pane did not draw"); return; }
    const before = document.querySelectorAll(".atrium-gpu-board").length;
    const pcbDoc = H().doc();
    H().openSplit("right", pcbDoc.id); await settle(700);
    const during = [...document.querySelectorAll(".atrium-gpu-board")].filter(c => c.style.display !== "none").length;
    const splitErrors = [];
    for (const [i, pane] of H().panes().entries()) {
      const why = await same(pane);
      if (why) splitErrors.push("pane " + (i + 1) + ": " + why);
    }
    act("split-close"); await settle(400); H().selectDocument(pcbDoc.id); await settle(300); H().redraw(); await settle(200);
    const after = document.querySelectorAll(".atrium-gpu-board").length, why = await same();
    const counts = "GPU canvases " + before + " → " + during + " → " + after;
    if (why || splitErrors.length || before !== 1 || during !== 2 || after !== 1) failLifecycle("splitPane", [...splitErrors, why, counts].filter(Boolean).join("; "));
    else okLifecycle("splitPane", counts);
    // The closed GPU pane must let go immediately even when a schematic survives.
    const sheet = H().project().documents.find(d => d.kind === "schematic");
    if (sheet) {
      H().selectDocument(sheet.id);
      await until(() => H().doc().id === sheet.id);
      H().openSplit("right", pcbDoc.id, {focus:false});
      const other = H().panes().find(p => !p.active)?.view.internals();
      const rendered = other && await until(() => GPU().status(other).renderer === "gpu" && GPU().stats(other)?.acc?.frames);
      const resources = other && GPU().stats(other)?.gpuBytes;
      act("split-close");
      const released = !!other && GPU().stats(other) === null && other.canvas.width === 1 && other.canvas.height === 1;
      const survivor = H().doc().id === sheet.id;
      await settle(180);
      const settled = !!other && GPU().stats(other) === null && other.canvas.width === 1 && other.canvas.height === 1;
      if (!rendered || !released || !survivor || !settled) failLifecycle("splitRelease", JSON.stringify({rendered,released,survivor,settled,resources}));
      else okLifecycle("splitRelease", "released " + resources + " tracked bytes before any later PCB paint");
      H().selectDocument(pcbDoc.id); await settle(400); await ready();
    }
  }

  async function layoutResize() {
    const canvas = cv(), view = H().view(), I = view.internals(), draw = view.render;
    const shell = document.body, previousHeight = shell.style.height;
    const dpr = Math.max(1, Math.min(4, devicePixelRatio || 1));
    const sample = input => {
      const box = canvas.getBoundingClientRect(), gpu = canvas.previousElementSibling;
      const gl = gpu?.matches(".atrium-gpu-board") && gpu.style.display !== "none" ? gpu.getContext("webgl2") : null;
      const gpuBox = gl && gpu.getBoundingClientRect(), comp = gl && GPU().composite(I);
      const image = comp?.getContext("2d").getImageData(0, 0, comp.width, comp.height);
      return {input, camera:view.camera(), image, size:{
        css:[box.width,box.height], position:[box.left,box.top], dpr:I.cam()[6],
        gpuCss:gpuBox && [gpuBox.width,gpuBox.height], gpuPosition:gpuBox && [gpuBox.left,gpuBox.top],
        clip:gl && getComputedStyle(gpu).clipPath,
        overlay:[canvas.width,canvas.height], gpu:gl && [gpu.width,gpu.height],
        buffer:gl && [gl.drawingBufferWidth,gl.drawingBufferHeight], viewport:gl && [...gl.getParameter(gl.VIEWPORT)],
        readback:image && [image.width,image.height], frames:GPU().resourceCounters(I)?.frames
      }};
    };
    // Use the first render callback while its WebGL buffer is still live.
    let frame = null, before, smaller;
    view.render = (...args) => { const result = draw(...args); frame ??= sample(args); return result; };
    try {
      H().redraw(); await settle(0);
      before = frame; frame = null;
      shell.style.height = (shell.getBoundingClientRect().height - 56) + "px";
      await settle(0);
      smaller = frame;
    } finally {
      frame = null;
      shell.style.height = previousHeight;
      try { await settle(0); } finally { view.render = draw; }
    }
    const sizes = out.layoutResize = {before:before?.size, smaller:smaller?.size, restored:frame?.size};
    const errors = Object.entries(sizes).map(([name, size]) => [name,resizeFrameMismatch(size,dpr)]).filter(([, error]) => error);
    if (!errors.length && (sizes.before.css[0] !== sizes.smaller.css[0] || sizes.before.css[1] - sizes.smaller.css[1] !== 56 ||
        sizes.before.css.some((n, i) => n !== sizes.restored.css[i]) ||
        !(sizes.before.frames < sizes.smaller.frames && sizes.smaller.frames < sizes.restored.frames)))
      errors.push(["sequence","the first draws must reflect the resize and restoration"]);
    if (!errors.length) {
      // Independent exact Canvas2D rendering of the captured first smaller
      // frame. Do not repaint or change GPU preference on the measured pane.
      const c = document.createElement("canvas"), [w,h] = sizes.smaller.css;
      c.style.cssText = "position:fixed;left:-10000px;top:0;display:block;width:" + w + "px;height:" + h + "px";
      document.body.append(c);
      const exact = AtriumCanvas.create(c), [doc,defs,opts] = smaller.input;
      try {
        exact.restoreCamera(smaller.camera);
        const cpu = {...opts, noReuse:true, editorPane:false};
        delete cpu.reuseBase;
        exact.render(doc,defs,cpu);
        const [W,Hh] = sizes.smaller.overlay;
        if (c.width !== W || c.height !== Hh) errors.push(["2d","reference backing mismatch"]);
        else {
          const A = c.getContext("2d").getImageData(0,0,W,Hh).data;
          const pct = differentPixels(A,smaller.image.data,48) / (W*Hh) * 100;
          sizes.smaller.over48 = +pct.toFixed(3);
          if (pct > budget.over48) errors.push(["2d","first resized composite differs from the exact 2D frame"]);
        }
      } finally {
        exact.dispose(); c.remove();
      }
    }
    if (errors.length) failLifecycle("layoutResize", JSON.stringify({sizes,errors}));
    else okLifecycle("layoutResize", `height ${sizes.before.overlay[1]} → ${sizes.smaller.overlay[1]} → ${sizes.restored.overlay[1]} px`);
  }

  if (wholeSuite && !o.fault) {
    try {
      await AtriumLazy.need("AtriumBoardShapeAuthoring");
      const profiles = out.boardProfile = probeBoardProfile(GPU());
      if (Object.values(profiles).some(coverage => coverage.some(match => !match)))
        out.failures.push("nested board profile: " + JSON.stringify(profiles));
    } catch (e) { out.failures.push("nested board profile: " + e.message); }
    try {
      const pixels = out.hiddenChunk = probeHiddenChunk(GPU());
      if (pixels.unbatched[0] === pixels.unbatched[1] || pixels.shown[0] !== pixels.unbatched[0] ||
          pixels.shown[1] === pixels.unbatched[1] ||
          ![pixels.batched, pixels.gpu].every(p => p.every((color, n) => color === pixels.unbatched[n])))
        out.failures.push("hidden chunk footprint: " + JSON.stringify(pixels));
    } catch (e) { out.failures.push("hidden chunk footprint: " + e.message); }
    try {
      out.stationaryScope = gpuViewportScope(GPU());
      for (const [name, row] of Object.entries(out.stationaryScope)) {
        if (row.queries !== row.expected || row.referenceQueries !== 1 || row.differentBytes || !row.visualChange)
          out.failures.push("GPU viewport scope " + name + ": " + JSON.stringify(row));
      }
    } catch (e) { out.failures.push("GPU viewport scope: " + e.message); }
    try { out.layerPlan = await probeLayerPlan(GPU()); }
    catch (e) { out.failures.push("GPU layer plan: " + e.message); }
    try { out.firstPourLayer = probeFirstPourLayer(GPU()); }
    catch (e) { out.failures.push("GPU first pour layer: " + e.message); }
    try {
      await AtriumLazy.need("AtriumPCBNetLabels");
      out.netLabelScope = probeNetLabelScope(GPU());
    } catch (e) { out.failures.push("Net label viewport scope: " + e.message); }
  }
  if (wholeSuite && !o.fault) {
    try {
      const P = AtriumPCBPours, project = Atrium.project("Mutable stored copper"), d = project.documents.find(doc => doc.kind === "pcb");
      const rect = (x,y,w,h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
      // Preserve selection of antialiased masks on high-density backings.
      const area = x => P.region([rect(x,3,6,6), Array.from({length:192}, (_,i) => {
        const a = i*Math.PI/96; return [x+3+Math.cos(a)*.4,6+Math.sin(a)*.4];
      })],"Top","GND");
      const solid = x => P.region([rect(x,12,6,5)],"Bottom","GND");
      d.outline = rect(0,0,32,20); d.pcbDrawing = {annotations:{},pours:[area(2),solid(12)]};
      d.sourcePourSignature = P.signature(d,new Map());
      await H().replaceProject(project,{force:true}); H().selectDocument(d.id); act("fit"); await settle(200);
      const h=H(), v=h.view(), regs=h.doc().pcbDrawing.pours;
      const paint=()=>{v.render(h.doc(),h.defs(),{editorPane:true,noReuse:true,grid:false,showUnrouted:false});
        const c=GPU().composite();return c.getContext("2d").getImageData(0,0,c.width,c.height).data;};
      GPU().enable(true);const before=paint();
      h.edit(()=>{Object.assign(regs[0],area(12));Object.assign(regs[1],solid(22));});
      globalThis.AtriumUndoStore?.sync();const after=paint(),uploaded=GPU().stats().coverageUpload;
      paint();const repeated=GPU().stats().coverageUpload;
      act("undo");const undoBytes=differentBytes(before,paint());
      act("redo");const redoBytes=differentBytes(after,paint());
      const doc=h.doc(), edited=doc.pcbDrawing.pours;
      h.edit(()=>{doc.pcbDrawing.pours=edited.map(r=>({...r}));});
      P.release(edited,[]);GPU().reset();v.invalidate();const full=paint();
      out.mutablePours = {changedBytes:differentBytes(before,after),differentBytes:differentBytes(after,full),undoBytes,redoBytes,coverageUpload:uploaded,repeatedUpload:repeated};
      if (!out.mutablePours.changedBytes || out.mutablePours.differentBytes || undoBytes || redoBytes || !(uploaded>0 && uploaded<after.length) || repeated)
        out.failures.push("mutable stored copper: "+JSON.stringify(out.mutablePours));

      // A translucent layer initially draws the stored rings. Its cached fill must pick up the
      // display geometry that finishes in idle, just as it does after an animated Repour All.
      const previousOpacity=PCB.opacity.track, detail=P.lod;
      try {
        const holes=Array.from({length:32},(_,n)=>Array.from({length:96},(_,k)=>{
          const angle=k*Math.PI/48;
          return [2+(n%8)*4+1.1*Math.cos(angle),2+Math.floor(n/8)*4+1.1*Math.sin(angle)];
        }));
        const region=P.region([rect(0,0,32,18),...holes],"Top","GND");
        h.edit(()=>{
          doc.items.push({id:"lod-track",kind:"track",layer:"Top",width:.4,points:[[0,8],[32,8]]});
          doc.pcbDrawing.pours=[region];doc.sourcePourSignature=P.signature(doc,h.defs());
        });
        PCB.setOpacity("track",.5);
        v.restoreCamera({...v.camera(),cx:16,cy:9,scale:4/window.devicePixelRatio});
        globalThis.AtriumUndoStore?.sync();P.release([region],[]);v.invalidate();
        const exact=paint(),version=detail.version,render=v.render;
        // Capture this exact view again once display detail is ready. A scheduled editor paint
        // with different visibility options would replace the texture for an unrelated reason.
        try {
          v.render=()=>{};
          for(let n=0;n<100 && detail.version===version;n++)await wait(25);
        } finally { v.render=render; }
        const settled=paint();v.invalidate();const rebuilt=paint();
        out.translucentPourLod={versionChanged:detail.version!==version,changedBytes:differentBytes(exact,rebuilt),differentBytes:differentBytes(settled,rebuilt)};
        if(!out.translucentPourLod.versionChanged || !out.translucentPourLod.changedBytes || out.translucentPourLod.differentBytes)
          out.failures.push("translucent pour display detail: "+JSON.stringify(out.translucentPourLod));
      } finally { PCB.setOpacity("track",previousOpacity); }
    } catch(e) { out.failures.push("mutable stored copper: "+e.message); }
  }
  if (globalThis.devicePixelRatio === 1 && (!o.boards || o.boards.includes("dense")) && (!o.views || o.views.includes("fit"))) {
    try {
      const probes = out.strokeProbes = probeGpuStrokes(GPU(), PCB, H().doc());
      if (!probes.gestureFrames || Object.values(probes.overlapColours).some(rgb => rgb.join(",") !== "0,255,0"))
        out.failures.push("stroke tint order: " + JSON.stringify(probes.overlapColours));
      for (const row of probes.grid) {
        const expected = row.delta < 0 ? "204,0,204,0" : "0,204,0,204";
        if (row.canvas2d.join(",") !== expected || row.gpu.join(",") !== expected)
          out.failures.push("grid at half-pixel boundary: " + JSON.stringify(row));
      }
      for (const s of probes.coverage) {
        const ink = s.feature === "track" ? s.idealRatio : s.ratio;
        if (!s.reference || ink < .96 || ink > 1.04 || s.gaps || (s.feature === "wire" && s.max > 3))
          out.failures.push("stroke coverage: " + JSON.stringify(s));
      }
    } catch (e) { out.failures.push("stroke probes: " + e.message); }
  }
  if (o.fault) { delete globalThis.__atriumGpuFault; GPU().reset(); }
  return out;
};

// Keep the browser visible so the editor itself has to suppress redraws while covered.
async function gpuPowerVisibility(host, gpu, wait, until) {
  const power = globalThis.AtriumPower, {canvas, view} = host.panes().find(pane => pane.active);
  const viewState = view.internals();
  const surface = () => {
    const candidate = canvas.previousElementSibling;
    return candidate?.matches(".atrium-gpu-board") ? candidate : null;
  };
  const stats = () => gpu.stats(viewState);
  const frames = () => stats()?.acc?.frames || 0;
  const shown = () => {
    const current = surface();
    return power.visible() && current && current.style.display !== "none" &&
      gpu.status(viewState).renderer === "gpu" && frames() > 0;
  };
  if (!power?.visible?.() || !shown()) {
    return {ok: false, reason: "the active board must start visible on the GPU", power: power?.state(), status: gpu.status(viewState)};
  }

  const previous = power.state(), warmSurface = surface(), contexts = [];
  let scriptedState = previous, lastHostState = previous, hostUpdates = 0, renders = 0;
  const setHost = update => {
    scriptedState = {...scriptedState, ...update};
    power.host(scriptedState);
  };
  // AppKit may deliver a real window notification during the scripted host signals.
  // Apply the newest real state when the probe releases control. Browser visibility remains live.
  const rememberHostState = event => {
    lastHostState = {...lastHostState, ...event.detail};
    hostUpdates++;
    event.stopImmediatePropagation();
    // The editor's window listener may have already seen this notification.
    power.host(scriptedState);
  };
  window.addEventListener("atrium-power", rememberHostState, true);
  const render = view.render;
  view.render = (...args) => { renders++; return render(...args); };
  const proto = HTMLCanvasElement.prototype, get = proto.getContext;
  proto.getContext = function (kind, options) {
    const context = get.apply(this, arguments);
    if (kind === "webgl2" && options?.powerPreference && this.matches(".atrium-gpu-board")) {
      contexts.push({hint: options.powerPreference, created: !!context, covered: !power.visible()});
    }
    return context;
  };
  const covered = () => {
    const state = power.state(), status = gpu.status(viewState);
    return !state.visible && state.occluded && !state.hidden && status.renderer === "2d" && /hidden/.test(status.reason);
  };
  try {
    const warmFrames = frames(), warmRenders = renders;
    setHost({occluded: true, lowPower: true});
    host.redraw();
    await wait(400);
    const warmPaused = covered() && frames() === warmFrames && renders === warmRenders &&
      surface() === warmSurface && contexts.length === 0;
    const restored = stats()?.restored;
    const loss = warmSurface.getContext("webgl2")?.getExtension("WEBGL_lose_context");
    let restorePaused = true;
    if (loss) {
      loss.loseContext();
      const lost = await until(() => stats()?.lost === true);
      loss.restoreContext();
      const delivered = await until(() => stats()?.lost === false);
      restorePaused = lost && delivered && covered() && stats()?.restored === restored &&
        frames() === warmFrames && renders === warmRenders && surface() === warmSurface && contexts.length === 0;
    }
    setHost({occluded: false});
    const restoreResumed = await until(() => shown() && (!loss ||
      stats()?.restored === restored + 1 && surface() !== warmSurface && !warmSurface.isConnected));

    const made = contexts.length, coldRenders = renders;
    setHost({occluded: true});
    gpu.reset();
    host.redraw();
    await wait(400);
    const coldPaused = covered() && !stats() && !surface() && renders === coldRenders && contexts.length === made;
    const started = performance.now();
    setHost({occluded: false});
    // Cold setup runs in browser idle time. One default idle deadline is already 2 s,
    // and the renderer waits for a real idle slice if that deadline expires during input.
    const coldDrawn = await until(shown, 120);
    const hint = globalThis.AtriumPrefs?.get?.("display.renderer") === "gpu" ? "high-performance" : "low-power";
    const fresh = contexts[made];
    const coldResumed = coldDrawn && contexts.length === made + 1 && fresh?.created && !fresh.covered && fresh.hint === hint;
    return {
      ok: warmPaused && restorePaused && restoreResumed && coldPaused && coldResumed,
      warmPaused, restorePaused, restoreResumed, coldPaused, coldResumed, lossSupported: !!loss,
      hostUpdates, contexts, coldMs: Math.round(performance.now() - started), power: power.state(), status: gpu.status(viewState),
    };
  } finally {
    proto.getContext = get;
    view.render = render;
    window.removeEventListener("atrium-power", rememberHostState, true);
    power.host(lastHostState);
  }
}

function gpuEmptyBandPan(GPU) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:324px;height:240px";
  document.body.append(canvas);
  canvas.getContext("2d", {willReadFrequently:true});
  const view = AtriumCanvas.create(canvas), I = view.internals(), board = Atrium.sheet("pcb", "Empty band during pan");
  const part = {id:"pan-part",kind:"part",def:"pan-footprint",layer:"Top",x:0,y:0,showRef:false};
  const visible = {kind:"text",layer:"Top",x:0,y:0,text:"A",size:1.2,width:.13};
  const outside = {kind:"text",layer:"Mechanical 15",x:35,y:-2,text:"Refill",size:1.3,width:.16,angle:37,align:"center"};
  const defs = new Map([[part.def,{footprint:{shapes:[visible,outside],pads:[]}}]]);
  board.items = [{id:"pan-track",kind:"track",layer:"Top",width:.4,points:[[-4,4],[4,4]]},part];
  const opts = {editorPane:true,grid:false,origin:false,showUnrouted:false,netNames:false};
  function pan(dx) { view.pan(dx,0); view.moving(); view.render(board,defs,opts); }

  try {
    view.restoreCamera({cx:0,cy:0,scale:18,referenceScale:18});
    view.render(board,defs,{...opts,noReuse:true});
    const gl = canvas.previousElementSibling?.getContext("webgl2");
    if (!gl) throw Error("empty band needs a real GPU context");
    const texStorage = gl.texStorage2D, texUpload = gl.texSubImage2D;
    const uploads = [];
    let allocations = 0, clears = 0;
    gl.texStorage2D = function (...args) { allocations++; return texStorage.apply(this,args); };
    gl.texSubImage2D = function (...args) {
      const data = args.at(-1);
      if (data instanceof ImageData) uploads.push(data);
      else if (data instanceof Uint8Array && !data.some(Boolean)) clears++;
      return texUpload.apply(this,args);
    };
    try {
      const base = GPU.resourceCounters(I).retainedFrames;
      for (let i=0;i<8;i++) pan(-3);
      const result = {frames:GPU.resourceCounters(I).retainedFrames-base,allocations,readbacks:uploads.length,clears};
      const beforeRefill = GPU.composite(I)?.toDataURL(), before = view.camera();
      uploads.length=0;
      pan(-570);
      const refilled = uploads.some(({data}) => data.some((a,i) => i%4===3 && a!==0));
      const afterRefill = GPU.composite(I)?.toDataURL();
      view.restoreCamera(before); view.moving(); view.render(board,defs,opts);
      const restored = !!beforeRefill && beforeRefill === GPU.composite(I)?.toDataURL();
      // The Top glyph is now near x=138 CSS px. Its physical texels move
      // into the entering strip on the next pan and must be erased.
      const priorClears = clears;
      pan(-165);
      const wrapped = GPU.composite(I)?.toDataURL(), wroteClear = clears > priorClears;
      view.render(board,defs,{...opts,noReuse:true});
      const clearedInk = wroteClear && !!wrapped && wrapped === GPU.composite(I)?.toDataURL();
      return {...result,refilled,restored,clearedInk,beforeRefill,afterRefill};
    } finally { gl.texStorage2D = texStorage; gl.texSubImage2D = texUpload; }
  } finally { view.dispose(); canvas.remove(); }
}

// Wheel motion ends before the exact-camera timer. A repaint in that window
// should keep the moving image until there is new content or the timer settles it.
function gpuEarlySettle(GPU) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:320px;height:200px";
  document.body.append(canvas);
  canvas.getContext("2d", {willReadFrequently:true});
  const view = AtriumCanvas.create(canvas), I = view.internals(), defs = new Map();
  const doc = Atrium.sheet("pcb", "Early zoom settle");
  doc.outline = [[-25,-16],[25,-16],[25,16],[-25,16]];
  doc.items.push({kind:"label",id:"legend",layer:"Silk",x:-5,y:0,size:3,text:"Silk"},
    {kind:"track",id:"track",layer:"Top",width:.8,points:[[-10,6],[10,6]]});
  const hidden = new Set(), opts = {editorPane:true, hidden, grid:false, origin:false, showUnrouted:false};
  function frame(extra = {}) {
    view.render(doc, defs, {...opts,...extra});
    const counters = GPU.resourceCounters(I), image = GPU.composite(I);
    if (counters?.renderState !== "gpu" || !image) throw Error("early settle needs an actual GPU frame");
    return {counters, pixels:image.getContext("2d").getImageData(0,0,image.width,image.height).data};
  }

  try {
    view.restoreCamera({cx:0,cy:0,scale:5,referenceScale:5});
    frame({noReuse:true});
    view.zoom(1.6);
    view.moving(true); // The final frame of an eased wheel notch.
    const motion = frame();
    view.settle();
    // Keep these renders in one task so the real settle timer cannot have run.
    const marker = ctx => {
      ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle = "#ff00ff"; ctx.fillRect(5,5,1,1); ctx.restore();
    };
    const early = frame({reuseBase:true, overlay:[marker]});
    const offset = (5 * canvas.width + 5) * 4;
    const markerDrawn = early.pixels.subarray(offset,offset + 4).join(",") === "255,0,255,255";
    early.pixels.set(motion.pixels.subarray(offset,offset + 4),offset);
    hidden.add("Silk");
    const appearance = frame({reuseBase:false});
    view.invalidate();
    const coldHidden = frame({noReuse:true});
    hidden.delete("Silk");
    view.invalidate();
    const coldVisible = frame({noReuse:true});
    return {moved:!motion.counters.exactCamera && Math.abs(motion.counters.gestureScale - 1.6) < .001,
      sharpening:motion.counters.slicing, retained:!early.counters.exactCamera && !differentBytes(motion.pixels, early.pixels),
      markerDrawn, appearanceExact:appearance.counters.exactCamera, appearanceMismatch:differentBytes(appearance.pixels,coldHidden.pixels),
      hiddenPixels:differentPixels(coldHidden.pixels,coldVisible.pixels,48)};
  } finally {
    view.dispose(); canvas.remove();
  }
}

// A continuous zoom out (a trackpad pinch: many small steps) reveals area that no retained layer
// holds. Each step must not redraw the exact layers for its camera. The renderer prepares twice the
// area at once and scales it, so an 8x zoom out needs about one build per halving of the scale.
// mode "cap": a memory cap with room for the exact frame but not for wider bands. "throw": the build fails.
function gpuZoomOutGesture(GPU, mode = "") {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;width:320px;height:200px";
  document.body.append(canvas);
  canvas.getContext("2d", {willReadFrequently:true});
  const view = AtriumCanvas.create(canvas), I = view.internals(), defs = new Map();
  const doc = Atrium.sheet("pcb", "Continuous zoom out");
  doc.outline = [[-160,-100],[160,-100],[160,100],[-160,100]];
  for (let x = -150; x <= 150; x += 25) for (let y = -100; y <= 100; y += 20)
    doc.items.push({kind:"label",id:`l${x},${y}`,layer:"Silk",x,y,size:4,width:.5,text:"SILK"});
  const opts = {editorPane:true, grid:false, origin:false, showUnrouted:false};
  const pixels = () => {
    const image = GPU.composite(I);
    if (!image) throw Error("zoom out needs an actual GPU frame");
    return image.getContext("2d").getImageData(0,0,image.width,image.height).data;
  };
  try {
    view.restoreCamera({cx:0,cy:0,scale:24,referenceScale:24});
    view.render(doc, defs, {...opts, noReuse:true});
    const before = GPU.resourceCounters(I), start = GPU.stats(I), builds = start.wideBuilds || 0, steps = 20;
    // Only the wider build moves the camera (withCamera) on these frames.
    const withCamera = I.withCamera;
    let attempts = 0, capMB = null;
    I.withCamera = function (...a) { attempts++; if (mode === "throw") throw Error("injected wide build failure"); return withCamera.apply(this, a); };
    if (mode === "cap") globalThis.__atriumGpuCapMB = capMB = +((start.gpuBytes + start.backingBytes + canvas.width * canvas.height * 2) / 1048576).toFixed(6);
    try { for (let i = 0; i < steps; i++) { view.zoom(.9); view.moving(); view.render(doc, defs, opts); } }
    finally { I.withCamera = withCamera; if (mode === "cap") delete globalThis.__atriumGpuCapMB; }
    const after = GPU.resourceCounters(I), alive = !!after && GPU.status(I).renderer === "gpu";
    if (mode) {
      const frames = after ? after.frames - before.frames : 0;
      return {mode, frames, fullFrames:after ? frames - (after.retainedFrames - before.retainedFrames) : null,
        builds:(GPU.stats(I)?.wideBuilds || 0) - builds, attempts, alive, capMB};
    }
    const moving = pixels();
    view.settle(); view.render(doc, defs, {...opts, noReuse:true});
    const exact = pixels(), w = canvas.width, h = canvas.height, background = exact.slice(0, 4);
    // Exact pixels with no gesture pixel within one pixel and 64 levels: lettering the scaled layers lost.
    // Resampling only softens and shifts edges by a pixel.
    let unmatched = 0, exactInk = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = (y * w + x) * 4;
      if (rgbDifference(exact, background, k, 0) > 64) exactInk++;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = rgbDifference(exact, moving, k, k + (dy * w + dx) * 4) <= 64;
      if (!near) unmatched++;
    }
    const frames = after.frames - before.frames;
    return {frames, fullFrames:frames - (after.retainedFrames - before.retainedFrames),
      builds:(GPU.stats(I).wideBuilds || 0) - builds, limit:Math.ceil(Math.log2(1 / Math.pow(.9, steps))) + 1,
      exactInk, unmatched:+(unmatched / ((w - 2) * (h - 2))).toFixed(4)};
  } finally {
    view.dispose(); canvas.remove();
  }
}

// Exercise the real zero-row coverage slice, with a frame boundary before the exact repaint.
async function gpuTerminalOverlay(GPU) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;width:320px;height:220px";
  document.body.append(canvas);
  canvas.getContext("2d",{willReadFrequently:true});
  const view = AtriumCanvas.create(canvas), I = view.internals();
  const board = Atrium.sheet("pcb","Exact settle overlay"), defs = new Map();
  const rect = (l,t,r,b) => [[l,t],[r,t],[r,b],[l,b]];
  board.outline = rect(-30,-20,30,20);
  board.items.push({kind:"label",id:"silk",layer:"Silk",x:-6,y:-2,text:"LABEL",size:1},
    {kind:"track",id:"track",layer:"Top",points:[[-7,-4],[6,-4]],width:.6},
    {kind:"via",id:"via",layer:"Multi",x:8,y:-4,diameter:1,drill:.4,fromLayer:"Top",toLayer:"Bottom"});
  board.pcbDrawing = {pours:[AtriumPCBPours.region([rect(-8,0,9,8),rect(-2,2,2,2.02)],"Top","GND")]};
  board.sourcePourSignature = AtriumPCBPours.signature(board,defs);
  const marker = g => {
    g.save(); g.setTransform(1,0,0,1,0,0); g.fillStyle = "#ff00ff"; g.fillRect(11,11,5,5); g.restore();
  };
  const opts = {editorPane:true,grid:false,origin:false,showUnrouted:false,netNames:false,overlay:[marker],selected:"via"};
  const pixels = (surface = canvas) => surface.getContext("2d").getImageData(0,0,surface.width,surface.height).data;
  let timeout;
  try {
    view.restoreCamera({cx:0,cy:0,scale:12,referenceScale:12});
    view.render(board,defs,{...opts,noReuse:true});
    view.zoom(1.25); view.moving(true); view.render(board,defs,opts);
    const retained = GPU.resourceCounters(I), before = pixels();
    if (!retained?.slicing || retained.exactCamera || retained.coverageUpload)
      throw Error("zoom did not schedule exact text slices from a retained frame");
    const {atCallback,coverage} = await new Promise((resolve,reject) => {
      timeout = setTimeout(() => reject(Error("the exact coverage slice did not finish")),3000);
      view.onRepaint(() => {
        const work = GPU.resourceCounters(I);
        if (work?.exactCamera && work.coverageUpload)
          resolve({atCallback:pixels(),coverage:work.coverageUpload});
      });
    });
    const after = pixels();
    const offset = (13 * canvas.width + 13) * 4;
    const markerDrawn = before.subarray(offset,offset + 4).join(",") === "255,0,255,255";
    await new Promise(requestAnimationFrame);
    view.render(board,defs,opts);
    const next = pixels(), nextComposite = pixels(GPU.composite(I));
    GPU.release(I); view.invalidate();
    view.render(board,defs,{...opts,noReuse:true});
    return {marker:markerDrawn, coverage, beforeCallback:differentBytes(before,atCallback), beforeAfter:differentBytes(before,after),
      nextFresh:differentBytes(next,pixels()), nextFreshComposite:differentBytes(nextComposite,pixels(GPU.composite(I)))};
  } finally {
    clearTimeout(timeout); view.dispose(); canvas.remove();
  }
}

// A stationary tool repaint still draws the board. Its ordered spatial query can be reused
// until the board or viewport changes. Compare each result with a freshly built GPU scene.
function gpuViewportScope(GPU) {
  const surface = document.createElement("div");
  surface.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:320px;height:200px";
  surface.append(canvas);
  document.body.append(surface);
  const view = AtriumCanvas.create(canvas), I = view.internals();
  const doc = Atrium.sheet("pcb", "Viewport test"), defs = new Map();
  const left = {id: "scope-left", kind: "label", x: 20, y: 10, size: 3, text: "Left", layer: "Silk"};
  const right = {...left, id: "scope-right", x: 77, text: "Right"};
  const track = {id: "scope-track", kind: "track", layer: "Top", width: .8, points: [[0, 16], [110, 16]]};
  doc.items.push(left, right, track);
  const opts = {editorPane: true, netNames: false, viaMarks: false, grid: false, origin: false};
  const camera = cx => view.restoreCamera({cx, cy: 12, scale: 10, referenceScale: 1});
  let queries = 0;
  const query = I.query;
  I.query = (...args) => { queries++; return query(...args); };
  function frame(extra) {
    queries = 0;
    view.render(doc, defs, {...opts, ...extra});
    const image = GPU.composite(I);
    if (!image || !GPU.stats(I).submitted) throw Error("GPU geometry was not drawn");
    return image.getContext("2d").getImageData(0, 0, image.width, image.height).data;
  }
  const results = {};
  function compare(name, expected, before, extra) {
    const actual = frame(extra), used = queries;
    view.invalidate();
    const fresh = frame(extra);
    results[name] = {queries: used, expected, referenceQueries: queries, differentBytes: differentBytes(actual, fresh), visualChange: differentBytes(before, actual)};
    return actual;
  }
  try {
    camera(24);
    const initial = frame({noReuse: true});
    compare("stationary tool repaint", 0, initial, {snapAt: [24, 12]});
    compare("route visibility change", 0, initial, {routePreview: {hidden: [left.id]}, transientGeometry: true});
    camera(75);
    const moved = compare("camera moved", 1, initial);
    left.x = 68;
    view.invalidate(doc, [left]);
    compare("label entered the viewport after edit", 1, moved);
    return results;
  } finally {
    surface.remove();
  }
}

async function probeLayerPlan(GPU, observe, checkReuse = true) {
  const canvas = document.createElement("canvas"), PCB = AtriumPCBAppearance, P = AtriumPCBPours;
  canvas.style.cssText = "position:absolute;left:-1000px;top:0;width:312px;height:192px";
  document.body.append(canvas);
  canvas.getContext("2d", {willReadFrequently:true});
  const view = AtriumCanvas.create(canvas), I = view.internals(), defs = new Map(), enabled = GPU.enabled();
  const board = Atrium.sheet("pcb", "Layer order"), rect = (a,b,c,d) => [[a,b],[c,b],[c,d],[a,d]];
  const graphic = (id, layer, a, b, c, d) => ({kind:"graphic", id, layer, fill:true, closed:true, points:rect(a,b,c,d)});
  const label = (id, layer, x, y) => ({kind:"label", id, layer, x, y, size:1.8, text:"T28"});
  const track = (id, layer, y) => ({kind:"track", id, layer, width:1, points:[[0,y],[120,y]]});
  const via = (id, x, fromLayer, toLayer) => ({kind:"via", id, x, y:19, layer:"Multi", fromLayer, toLayer, diameter:2, drill:.7});
  const stable = [track("top","Top",14), track("bottom","Bottom",16), label("text","Silk",19,4),
    via("high",17,"Top","Inner 1"), via("low",21,"Inner 2","Bottom")];
  board.outline = rect(0,0,120,26);
  board.items = stable.slice();
  board.pcbDrawing = {pours:[P.region([rect(5,20,115,25),rect(16,21,23,24)],"Inner 1","GND")]};
  const stamp = doc => { doc.sourcePourSignature = P.signature(doc,defs); };
  stamp(board);
  const a = "Mechanical A", b = "Mechanical B";
  const left = graphic("left",b,6,6,41,13), right = graphic("right",b,79,6,114,13);
  const tied = {...board, items:[right, graphic("across",a,3,5,117,14), left, label("back-text",a,19,9),
    label("front-text",b,98,9), ...stable]};
  stamp(tied);
  const palette = {layers:{[a]:"#1166ee",[b]:"#ee4411",Top:"#b1192c",Bottom:"#174c99","Inner 1":"#17a45a"}};
  const counters = () => {
    const s = GPU.stats(I);
    return [s.layerPassBuilds || 0,s.layerBandBuilds || 0,s.layerPourPassBuilds || 0];
  };
  const rows = {}, different = (x,y) => x.length !== y.length || x.some((v,i) => v !== y[i]);
  const oldOpacity = PCB.layerAlpha(a), opts = {editorPane:true,noReuse:true,origin:false,grid:false,showUnrouted:false};
  function draw(name, doc, x, o = {}) {
    view.restoreCamera({cx:x,cy:12,scale:8,referenceScale:8,flipped:!!o.flipped});
    return PCB.withPalette(palette, () => {
      view.render(doc,defs,{...opts,...o});
      const image = GPU.composite(I), s = GPU.stats(I);
      if (!image || GPU.status(I).renderer !== "gpu" || !s?.submitted) throw Error(name + ": GPU geometry is missing");
      const data = image.getContext("2d").getImageData(0,0,image.width,image.height).data;
      const [px,py] = view.worldToScreen([x,7]).map(v => Math.floor(v * image.width / canvas.clientWidth));
      const color = [...data.subarray((py * image.width + px) * 4,(py * image.width + px) * 4 + 3)];
      rows[name] = {color, submitted:s.submitted, counts:counters()};
      observe?.(name,data);
      return data;
    });
  }
  try {
    GPU.enable(true);
    draw("untied",board,20);
    const before = counters();
    for (const x of [21,22,23,24,25,26]) draw("pan-" + x,board,x);
    const pan = counters().map((n,i) => n - before[i]);
    if (checkReuse && pan.some(n => n)) throw Error("stable camera motion rebuilt layer plans: " + pan);
    draw("opposite-side-pour",board,100,{flipped:true});
    const near = draw("tied-left",tied,20), far = draw("tied-right",tied,100);
    if (!(rows["tied-left"].color[0] > 200 && rows["tied-right"].color[2] > 200 && different(near,far)))
      throw Error("viewport-dependent painter ties did not expose different layers: " + JSON.stringify(rows));
    draw("tied-flipped",tied,100,{flipped:true});
    draw("single-top",tied,20,{layerMode:"single",layer:"Top"});
    draw("single-bottom",tied,20,{layerMode:"single",layer:"Bottom"});
    draw("dim-bottom-flipped",tied,20,{layerMode:"dim",layer:"Bottom",flipped:true});
    const hidden = new Set([b,"Inner 1"]);
    const concealed = draw("hidden",tied,20,{hidden});
    hidden.clear();
    const revealed = draw("revealed",tied,20,{hidden});
    if (!different(concealed,revealed) || different(near,revealed)) throw Error("in-place visibility change reused the wrong layers");
    PCB.setLayerOpacity(a,.65);
    const blended = draw("translucent",tied,100);
    PCB.setLayerOpacity(a,oldOpacity);
    if (!different(blended,far)) throw Error("translucent pass was not exercised");
    const points = left.points;
    left.points = rect(7,12,41,13); stamp(tied); view.invalidate(tied,[left]);
    const edited = draw("edit",tied,20);
    left.points = points; stamp(tied); view.invalidate(tied,[left]);
    const undone = draw("restore",tied,20);
    if (!different(near,edited) || different(near,undone)) throw Error("edit or inverse edit used stale layer geometry");
    const swapped = draw("same-id-document",board,20);
    if (!different(near,swapped)) throw Error("same-ID document reused a foreign layer order");
    const oldGPU = canvas.previousElementSibling, contextLoss = GPU.loseContext(I,80);
    if (contextLoss) {
      const deadline = performance.now() + 3500;
      while ((canvas.previousElementSibling === oldGPU || !GPU.stats(I)?.restored) && performance.now() < deadline) {
        await new Promise(r => setTimeout(r,16));
        // A standalone viewport has no editor repaint callback.
        PCB.withPalette(palette,() => view.render(board,defs,opts));
      }
      const restarted = draw("context-restart",board,20);
      if (canvas.previousElementSibling === oldGPU || different(swapped,restarted)) throw Error("context restart changed the composed frame");
    }
    return {rows, pan, contextLoss};
  } finally {
    PCB.setLayerOpacity(a,oldOpacity);
    GPU.release(I);
    GPU.enable(enabled);
    canvas.remove();
  }
}

function probeFirstPourLayer(GPU, compare = true) {
  const canvas = document.createElement("canvas"), P = AtriumPCBPours, PCB = AtriumPCBAppearance;
  canvas.style.cssText = "position:absolute;left:-1000px;top:0;width:320px;height:192px";
  document.body.append(canvas);
  canvas.getContext("2d", {willReadFrequently:true});
  const view = AtriumCanvas.create(canvas), I = view.internals(), defs = new Map(), enabled = GPU.enabled();
  const live = globalThis.AtriumPolygonPour, animation = globalThis.AtriumPourAnim;
  const rect = (l,t,r,b) => [[l,t],[r,t],[r,b],[l,b]];
  const fresh = P.region([rect(4,4,33,20)],"Inner 1","GND"), previous = P.region([rect(2,2,7,20)],"Bottom","GND");
  const board = Atrium.sheet("pcb", "First visible copper layer");
  const top = {kind:"track",id:"foreground",layer:"Top",width:2,points:[[6,15],[31,15]]};
  const text = {kind:"label",id:"buried-text",layer:"Inner 2",x:9,y:8,size:3,text:"INNER",justify:"left"};
  const mech = ["Mechanical A","Mechanical B"].map((layer,i)=>({kind:"graphic",id:"mechanical"+i,layer,fill:true,points:rect(2+i,21,8+i,23)}));
  const opts = {editorPane:true,noReuse:true,origin:false,grid:false,showUnrouted:false,netNames:false};
  const palette = {layers:{Top:"#ee1111","Inner 1":"#22ee22","Inner 2":"#2233ee",Bottom:"#ffaa22",
    "Mechanical A":"#1166ee","Mechanical B":"#ee4411"}};
  board.outline = rect(0,0,37,24);
  view.restoreCamera({cx:18,cy:12,scale:8,referenceScale:8});
  let showing = false, list;
  globalThis.AtriumPolygonPour = {...live, displayState: (doc,...rest)=>doc===board?"source":live?.displayState?.(doc,...rest),
    displayPours: (doc,...rest)=>doc===board?list:live?.displayPours?.(doc,...rest)};
  globalThis.AtriumPourAnim = {...animation, active: doc=>doc===board?showing:!!animation?.active?.(doc)};
  const counts = () => {
    const s = GPU.stats(I);
    return [s.layerPassBuilds || 0,s.layerBandBuilds || 0,s.layerPourPassBuilds || 0];
  };
  const referenceOrder = I.paintOrder;
  let orderCalls = 0, itemReads = 0;
  I.paintOrder = (doc, defs, options, items, viewport, pours) => {
    orderCalls++;
    const traced = new Proxy(items,{get(target,key,receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) itemReads++;
      return Reflect.get(target,key,receiver);
    }});
    return referenceOrder(doc,defs,options,traced,viewport,pours);
  };
  function draw(moving = false) {
    return PCB.withPalette(palette,()=>{
      if (moving) view.moving();
      view.render(board,defs,{...opts,noReuse:!moving});
      const image = GPU.composite(I);
      if (!image || !GPU.stats(I)?.submitted) throw Error("No GPU geometry for the first-preview probe");
      return image.getContext("2d").getImageData(0,0,image.width,image.height).data;
    });
  }
  try {
    GPU.enable(true);
    const results = {};
    for (const tied of [false,true]) for (const stored of [false,true]) {
      board.items = tied ? [top,text,...mech] : [top,text];
      const original = list = stored ? [previous] : [];
      board.pcbDrawing = {pours:list};
      showing = false;
      view.invalidate();
      const before = draw(), revision = I.cache.rev;
      showing = true;
      list = [...list,fresh];
      const preview = draw();
      if (I.cache.rev !== revision) throw Error("Preview unexpectedly invalidated the board cache");
      const firstCounts = counts();
      list = list.slice();
      orderCalls = itemReads = 0;
      const sameLayers = draw();
      const rebuilds = counts().map((n,i)=>n-firstCounts[i]);
      const clonedOrder = {calls:orderCalls,items:itemReads};
      GPU.release(I);
      const coldPreview = draw();
      showing = false;
      list = original;
      const cancelled = draw();
      showing = true;
      list = [...list,fresh];
      const moving = draw(true);
      showing = false;
      board.pcbDrawing.pours = list;
      view.invalidate();
      const committed = draw();
      const row = {revision, changed:differentBytes(before,preview), warmVsCold:differentBytes(preview,coldPreview),
        warmVsStored:differentBytes(preview,committed), coldVsStored:differentBytes(coldPreview,committed),
        cancelled:differentBytes(before,cancelled), moving:differentBytes(moving,committed), sameLayers:differentBytes(preview,sameLayers), rebuilds, clonedOrder};
      const name = (tied?"tied":"untied")+"/"+(stored?"stored":"empty");
      results[name] = row;
      if (!row.changed || compare && (row.warmVsCold || row.warmVsStored || row.coldVsStored || row.cancelled ||
          row.moving || row.sameLayers || row.rebuilds.some(n=>n) || clonedOrder.calls || clonedOrder.items))
        throw Error(name + ": " + JSON.stringify(row));
    }
    // The newly visible pour already has a scene bucket. It must still move
    // that bucket ahead of its equally ranked neighbour in the canvas order.
    board.pcbDrawing.pours = list = [];
    view.invalidate();
    const before = draw();
    showing = true;
    list = [P.region([rect(90,90,100,100)],"Mechanical B","NONE")];
    orderCalls = itemReads = 0;
    const offscreen = draw(), offscreenOrder = {calls:orderCalls,items:itemReads};
    list = [P.region([rect(12,21,14,23)],"Mechanical B","NONE")];
    orderCalls = itemReads = 0;
    const visible = draw(), visibleOrder = {calls:orderCalls,items:itemReads};
    GPU.release(I);
    const cold = draw();
    const index = ([x,y]) => (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
    const at = index(view.worldToScreen([5,22]).map(value=>value * canvas.width / canvas.clientWidth));
    const tied = {before:[...before.subarray(at,at+3)], after:[...visible.subarray(at,at+3)],
      offscreen:differentBytes(before,offscreen), cold:differentBytes(visible,cold), offscreenOrder, visibleOrder};
    if (compare && (tied.before.join() !== "238,68,17" || tied.after.join() !== "17,102,238" ||
        tied.offscreen || tied.cold || offscreenOrder.calls || offscreenOrder.items || visibleOrder.calls !== 1 || !visibleOrder.items))
      throw Error("visible contribution to an existing tied layer: " + JSON.stringify(tied));
    results.tiedVisibility = tied;
    return results;
  } finally {
    globalThis.AtriumPolygonPour = live;
    globalThis.AtriumPourAnim = animation;
    GPU.release(I);
    GPU.enable(enabled);
    canvas.remove();
  }
}

function probeNetLabelScope(GPU) {
  const surface = document.createElement("div"), canvas = document.createElement("canvas");
  surface.style.cssText = "position:absolute;left:-1000px;top:0;pointer-events:none";
  canvas.style.cssText = "display:block;width:360px;height:216px";
  surface.append(canvas);
  document.body.append(surface);
  const view = AtriumCanvas.create(canvas), I = view.internals(), enabled = GPU.enabled();
  const doc = Atrium.sheet("pcb", "Net label viewport");
  const def = AtriumParts.catalogue.find(part => part.id === "std-r"), defs = new Map([[def.id, def]]);
  const leftTrack = {id:"scope-left-track", kind:"track", layer:"Top", width:2, net:"LEFT", points:[[0,15],[42,15]]};
  const rightTrack = {...leftTrack, id:"scope-right-track", net:"RIGHT", points:[[44,15],[80,15]]};
  const part = {id:"scope-obstacle", kind:"part", def:def.id, x:19, y:8, angle:0, showRef:false};
  doc.items.push(leftTrack, rightTrack, part);
  doc.outline = [[0,0],[80,0],[80,28],[0,28]];
  const P = AtriumPCBPours;
  doc.pcbDrawing = {pours:[P.region([doc.outline], "Top", "GND")]};
  const stamp = () => { doc.sourcePourSignature = P.signature(doc, defs); };
  const opts = {editorPane:true, noReuse:true, grid:false, origin:false, showUnrouted:false};
  const create = AtriumSpatial.create, result = {};
  let viewportQueries = 0;
  AtriumSpatial.create = (...args) => {
    const index = create(...args), query = index.query;
    index.query = box => {
      if (I.artworkViewport().every((edge, i) => edge === box[i])) viewportQueries++;
      return query(box);
    };
    return index;
  };
  function frame(cx, extra) {
    view.restoreCamera({cx, cy:12, scale:12, referenceScale:1});
    viewportQueries = 0;
    view.render(doc, defs, {...opts, ...extra});
    const labels = I.netLabels();
    return {queries:viewportQueries, tracks:labels.filter(l => l.kind === "track").map(l => l.text), pours:labels.filter(l => l.kind === "pour")};
  }
  try {
    for (const mode of ["gpu", "2d"]) {
      GPU.enable(mode === "gpu");
      view.invalidate();
      part.x = 19; stamp();
      const left = frame(24), right = frame(56);
      if (GPU.status(I).renderer !== mode || mode === "gpu" && !GPU.stats(I)?.submitted) throw Error(mode + " geometry was not drawn");
      const hidden = {routePreview:{hidden:[leftTrack.id, part.id]}};
      const routed = frame(24, hidden);
      // The router hides the painted track and part. The part still reserves its label obstacle.
      part.x = 24; stamp(); view.invalidate(doc, [part]);
      const blocked = frame(24, hidden);
      part.x = 19; stamp(); view.invalidate(doc, [part]);
      const restored = frame(24, hidden);
      const rows = result[mode] = {left, right, routed, blocked, restored};
      if (Object.values(rows).some(row => row.queries !== 1) || left.tracks.join() !== "LEFT" ||
          right.tracks.join() !== "RIGHT" || left.pours.length !== 1 || right.pours.length !== 1 ||
          routed.tracks.length || blocked.tracks.length || blocked.pours.length || restored.tracks.length ||
          JSON.stringify(routed.pours) !== JSON.stringify(left.pours) ||
          JSON.stringify(restored.pours) !== JSON.stringify(left.pours))
        throw Error(mode + ": " + JSON.stringify(rows));
    }
    if (JSON.stringify(result.gpu) !== JSON.stringify(result["2d"])) throw Error("Renderer label plans differ");
    return result;
  } finally {
    AtriumSpatial.create = create;
    GPU.release(I);
    GPU.enable(enabled);
    surface.remove();
  }
}
