"use strict";

// Logo Creator: Place > Graphic / Logo from Image. Converts PNG, JPEG or SVG
// artwork into filled board regions, like Altium's PCB Logo Creator, with a
// live traced preview, minimum-feature checks against fabrication limits,
// multi-colour layer assignment and exposed-copper (copper + mask) output.
//
// The pure parts (process, build) run without a DOM; open(ctx) is the dialog.
// Output items are {kind:"graphic", points, closed:true, fill:true, width:0,
// layer, groupId}: one bridged ring per polygon so holes survive everywhere
// (canvas, Gerber G36 regions, KiCad gr_poly) and the artwork moves as one.
globalThis.AtriumLogo = (() => {
  const V = globalThis.AtriumVectorize;
  const A = () => globalThis.Atrium;
  const TARGETS = [
    {key: "Silk", label: "Top Overlay", layers: ["Silk"], limit: .15},
    {key: "Bottom silk", label: "Bottom Overlay", layers: ["Bottom silk"], limit: .15, bottom: true},
    {key: "Top", label: "Top Layer (copper)", layers: ["Top"], limit: .1},
    {key: "Bottom", label: "Bottom Layer (copper)", layers: ["Bottom"], limit: .1, bottom: true},
    {key: "Top mask", label: "Top Solder (mask opening)", layers: ["Top mask"], limit: .1},
    {key: "Bottom mask", label: "Bottom Solder (mask opening)", layers: ["Bottom mask"], limit: .1, bottom: true},
    {key: "Top+mask", label: "Top copper + mask opening (exposed copper)", layers: ["Top", "Top mask"], limit: .1},
    {key: "Bottom+mask", label: "Bottom copper + mask opening (exposed copper)", layers: ["Bottom", "Bottom mask"], limit: .1, bottom: true},
    {key: "Mechanical", label: "Mechanical 1", layers: ["Mechanical"], limit: 0}
  ];
  const target = key => TARGETS.find(t => t.key === key) || TARGETS[0];
  const VERTEX_WARNING = 20000;

  // ---------------------------------------------------------------------------
  // Tracing with fabrication checks.
  // o: {mode, threshold, invert, colors, smoothing, tolerance, minFeature (mm),
  //     width / height (mm, target ink extent; one sets both unless
  //     `stretch`), enforce (drop features below minimum)}
  // Returns {trace, scale:[sx, sy] (mm per px), bounds (px), size (mm), thin,
  // gaps, stats, warnings}.
  function process(img, o = {}) {
    const w = img.width, h = img.height, tol = o.tolerance ?? .6;
    let trace, mask = null;
    if (o.mode === "color") {
      trace = V.trace(img, {mode: "color", colors: o.colors || 3, smoothing: o.smoothing || 0, tolerance: tol, turdSize: 2, keepMask: true});
      mask = new Uint8Array(w * h);
      const bg = trace.layers.findIndex(l => l.background);
      for (let i = 0; i < mask.length; i++) mask[i] = trace.labels[i] !== 255 && trace.labels[i] !== bg ? 1 : 0;
    } else {
      const {field, level} = V.inkField(img, o);
      if (o.smoothing >= 1) V.blur(field, w, h, o.smoothing);
      mask = V.maskOf(field, level);
      trace = {width: w, height: h, polygons: null};
      trace.field = field; trace.level = level;
    }
    // Scale from the ink extent of a quick bounds pass over the mask.
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) if (mask[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const empty = x1 < 0, bounds = empty ? [0, 0, w, h] : [x0, y0, x1 + 1, y1 + 1];
    const inkW = bounds[2] - bounds[0], inkH = bounds[3] - bounds[1];
    let sx = o.width > 0 ? o.width / inkW : o.height > 0 ? o.height / inkH : .05, sy = sx;
    if (o.stretch && o.width > 0 && o.height > 0) sy = o.height / inkH;
    const scale = [sx, sy], minPx = (o.minFeature || 0) / Math.min(sx, sy);
    // Features thinner than the minimum: ink that does not survive an opening.
    const feat = !empty && minPx > 1 ? V.features(mask, w, h, minPx / 2) : {thinCount: 0, gapCount: 0};
    const turd = Math.max(2, (minPx * minPx) / 2);
    if (o.mode !== "color") {
      let field = trace.field;
      if (o.enforce && feat.opened) {
        // Rebuild the field from the opened mask, keeping anti-aliased edges
        // where the ink survived.
        field = new Uint8Array(field);
        for (let i = 0; i < field.length; i++) if (mask[i] && !feat.opened[i]) field[i] = 0;
      }
      trace = {...V.traceField(field, w, h, trace.level, {tolerance: tol, turdSize: turd, copy: false}), field: undefined};
    } else if (o.enforce || turd > 2) {
      for (const l of trace.layers) l.polygons = l.polygons.filter(p => Math.abs(p.area) >= turd);
      trace.polygons = trace.layers.flatMap(l => l.polygons);
    }
    const stats = V.stats(trace.polygons);
    const inkPixels = mask.reduce((s, v) => s + v, 0);
    const warnings = [];
    if (empty) warnings.push("No artwork was found. Adjust the threshold or invert the image.");
    if (feat.thinCount && o.minFeature) warnings.push(Math.round(100 * feat.thinCount / Math.max(1, inkPixels)) + "% of the artwork is thinner than " + o.minFeature + " mm" + (o.enforce ? " and was removed." : ". Enable \"Remove thin features\" or enlarge the logo."));
    if (feat.gapCount && o.minFeature) warnings.push("Some gaps are narrower than " + o.minFeature + " mm and may fill in.");
    if (stats.vertices > VERTEX_WARNING) warnings.push(stats.vertices.toLocaleString() + " vertices: increase Simplify or Smoothing to keep the board responsive.");
    return {trace, scale, bounds, thin: feat.thin || null, gaps: feat.gaps || null, thinCount: feat.thinCount, gapCount: feat.gapCount, stats,
      size: [inkW * sx, inkH * sy], warnings, empty};
  }

  // ---------------------------------------------------------------------------
  // Board items centred on the origin (or o.at). `o.layer` is a target key; in
  // colour mode o.layers maps a palette index to a target key or "" to skip.
  const round = v => Math.round(v * 1e4) / 1e4 + 0;
  function build(result, o = {}) {
    const {trace, scale, bounds} = result;
    const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2, at = o.at || [0, 0];
    const groupId = o.groupId || "logo-" + (A()?.id ? A().id() : Math.random().toString(36).slice(2));
    const id = () => A()?.id ? A().id() : "g" + Math.random().toString(36).slice(2);
    const items = [];
    const groups = trace.layers ? trace.layers.map((l, i) => ({polygons: l.polygons, key: o.layers?.[i] ?? (l.background ? "" : o.layer)})) : [{polygons: trace.polygons, key: o.layer}];
    let vertices = 0;
    for (const g of groups) {
      if (!g.key) continue;
      const t = target(g.key), mirror = o.mirror ?? !!t.bottom;
      for (const poly of g.polygons) {
        let ring = V.bridge(poly).map(([x, y]) => [round(at[0] + (mirror ? -1 : 1) * (x - cx) * scale[0]), round(at[1] + (y - cy) * scale[1])]);
        if (mirror) ring.reverse();
        ring = ring.filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
        if (ring.length < 3) continue;
        vertices += ring.length;
        for (const layer of t.layers) items.push({id: id(), kind: "graphic", points: ring.map(p => p.slice()), closed: true, fill: true, width: 0, layer, groupId});
      }
    }
    return {items, groupId, vertices};
  }

  // ---------------------------------------------------------------------------
  // Image loading: raster through createImageBitmap or <img>; SVG is
  // rasterised at up to `max` px on its long side.
  async function loadImage(file, max = 1600) {
    const name = String(file.name || "image"), type = file.type || "";
    const svg = /svg/i.test(type) || /\.svg$/i.test(name);
    let blob;
    if (file instanceof Blob) blob = file;
    else if (file.arrayBuffer) blob = new Blob([await file.arrayBuffer()], {type: svg ? "image/svg+xml" : type});
    else if (file.text) blob = new Blob([await file.text()], {type: "image/svg+xml"});
    else throw Error("Unsupported file.");
    let source, w, h;
    if (svg) {
      let text = await blob.text();
      const doc = new DOMParser().parseFromString(text, "image/svg+xml"), root = doc.documentElement;
      if (!root || root.nodeName.toLowerCase() !== "svg") throw Error("The SVG file could not be read.");
      const vb = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
      let sw = parseFloat(root.getAttribute("width")), sh = parseFloat(root.getAttribute("height"));
      if (!(sw > 0 && sh > 0)) { sw = vb[2] > 0 ? vb[2] : 512; sh = vb[3] > 0 ? vb[3] : 512; }
      const k = max / Math.max(sw, sh);
      w = Math.max(1, Math.round(sw * k)); h = Math.max(1, Math.round(sh * k));
      root.setAttribute("width", String(w)); root.setAttribute("height", String(h));
      if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", "0 0 " + sw + " " + sh);
      text = new XMLSerializer().serializeToString(root);
      source = await imageFrom(new Blob([text], {type: "image/svg+xml"}));
    } else {
      source = typeof createImageBitmap === "function" ? await createImageBitmap(blob) : await imageFrom(blob);
      const sw = source.width, sh = source.height, k = Math.min(1, max / Math.max(sw, sh));
      w = Math.max(1, Math.round(sw * k)); h = Math.max(1, Math.round(sh * k));
    }
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d", {willReadFrequently: true});
    g.imageSmoothingQuality = "high";
    g.drawImage(source, 0, 0, w, h);
    return {image: g.getImageData(0, 0, w, h), canvas: c, name};
  }
  function imageFrom(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(Error("The image could not be decoded.")); };
      img.src = url;
    });
  }

  // ---------------------------------------------------------------------------
  // Dialog
  function open(ctx) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") { ctx.info?.("Open a board layout first."); return; }
    const U = A().units, unit = U.normal(ctx.units || ctx.project?.units);
    const PCB = globalThis.AtriumPCBAppearance;
    const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
    const button = (text, fn, cls) => { const b = el("button", text, cls); b.type = "button"; b.onclick = fn; return b; };
    const d = el("dialog", null, "work-dialog logo-dialog"); d.setAttribute("aria-label", "Logo Creator");
    d.onclose = () => d.remove(); document.body.append(d);
    const state = {mode: "luminance", threshold: 128, invert: false, colors: 3, smoothing: 1, tolerance: .6, minFeature: .15, enforce: false,
      width: 25, height: 0, sizeBy: "width", lock: true, layer: "Silk", mirror: false, mirrorAuto: true, layers: [], showSource: true, showThin: true};
    let loaded = null, result = null, timer = 0;

    // Layout.
    const head = el("div", null, "logo-head");
    head.append(el("h2", "Logo Creator"), el("p", "Trace a PNG, JPEG or SVG into filled board regions. Drop an image on the preview or choose a file."));
    const body = el("div", null, "logo-body");
    const stage = el("div", null, "logo-stage"), canvas = el("canvas", null, "logo-preview");
    canvas.setAttribute("aria-label", "Traced preview"); canvas.setAttribute("role", "img");
    const empty = el("div", null, "logo-empty");
    empty.append(el("strong", "No image loaded"), el("span", "PNG, JPEG or SVG"));
    stage.append(canvas, empty);
    const controls = el("div", null, "logo-controls");
    const status = el("p", null, "logo-stats"), warnings = el("ul", null, "logo-warnings");
    status.setAttribute("role", "status");
    body.append(stage, controls);
    const actions = el("div", null, "work-actions");
    const place = button("Place", () => commit(), "is-primary"); place.dataset.uiDefault = "false";
    place.disabled = true;
    actions.append(button("Cancel", () => d.close()), place);
    d.append(head, body, status, warnings, actions);

    function row(label, control, hint) {
      const l = el("label", null, "logo-row"); l.append(el("span", label), control);
      if (hint) l.append(el("small", hint));
      controls.append(l); return control;
    }
    function section(title) { controls.append(el("h3", title)); }
    function slider(label, min, max, step, key, fmt) {
      const wrap = el("span", null, "logo-slider"), r = el("input"), out = el("output");
      r.type = "range"; r.min = min; r.max = max; r.step = step; r.value = state[key]; r.setAttribute("aria-label", label);
      out.textContent = fmt(state[key]);
      r.oninput = () => { state[key] = +r.value; out.textContent = fmt(state[key]); schedule(); };
      wrap.append(r, out); return row(label, wrap);
    }
    function lengthInput(label, key, after) {
      const i = el("input"); i.type = "text"; i.inputMode = "decimal"; i.autocomplete = "off"; i.dataset.unit = unit;
      const show = () => { i.value = state[key] > 0 ? String(U.value(state[key], unit)) : ""; };
      show(); i.setAttribute("aria-label", label + " (" + unit + ")");
      i.onchange = () => { const v = U.parse(i.value, unit); if (!(v > 0) || v > 1000) { show(); return; } state[key] = v; after?.(); schedule(); };
      i.refresh = show;
      return row(label + " (" + unit + ")", i);
    }

    // Source.
    section("Source");
    const file = el("input"); file.type = "file"; file.accept = ".png,.jpg,.jpeg,.svg,.webp,.bmp,.gif,image/*"; file.hidden = true;
    file.onchange = () => { if (file.files[0]) load(file.files[0]); file.value = ""; };
    const choose = button("Choose image…", async () => {
      if (ctx.pickFile) { try { const f = await ctx.pickFile([".png", ".jpg", ".jpeg", ".svg", ".webp", ".bmp", ".gif"]); if (f) load(f); } catch (e) { say(e.message); } }
      else file.click();
    });
    choose.autofocus = true;
    const fileName = el("span", "", "logo-file");
    const pick = el("span", null, "logo-pick"); pick.append(choose, fileName, file);
    row("Image", pick);
    const modeSel = el("select"); modeSel.setAttribute("aria-label", "Trace mode");
    for (const [v, t] of [["luminance", "Brightness"], ["alpha", "Transparency"], ["color", "Colours"]]) modeSel.add(new Option(t, v));
    modeSel.onchange = () => { state.mode = modeSel.value; sync(); schedule(); };
    row("Trace", modeSel);
    const thresholdRow = slider("Threshold", 1, 255, 1, "threshold", v => String(v));
    const colorsRow = slider("Colours", 2, 8, 1, "colors", v => String(v));
    const inv = el("input"); inv.type = "checkbox"; inv.setAttribute("aria-label", "Invert");
    inv.onchange = () => { state.invert = inv.checked; schedule(); };
    const invRow = row("Invert", inv);
    slider("Smoothing", 0, 6, 1, "smoothing", v => v ? v + " px" : "off");
    slider("Simplify", .1, 3, .1, "tolerance", v => v.toFixed(1) + " px");

    // Size and layer.
    section("Size and layer");
    const widthIn = lengthInput("Width", "width", () => { state.sizeBy = "width"; });
    const heightIn = lengthInput("Height", "height", () => { state.sizeBy = "height"; });
    const lock = el("input"); lock.type = "checkbox"; lock.checked = true; lock.setAttribute("aria-label", "Lock aspect ratio");
    lock.onchange = () => { state.lock = lock.checked; schedule(); };
    row("Lock aspect", lock);
    const layerSel = el("select"); layerSel.setAttribute("aria-label", "Layer");
    for (const t of TARGETS) layerSel.add(new Option(t.label, t.key));
    layerSel.onchange = () => { state.layer = layerSel.value; const t = target(state.layer); if (state.mirrorAuto) { state.mirror = !!t.bottom; mir.checked = state.mirror; }
      state.minFeature = t.limit || state.minFeature; minIn.refresh(); schedule(); };
    const layerRow = row("Layer", layerSel);
    const palette = el("div", null, "logo-palette");
    controls.append(palette);
    const mir = el("input"); mir.type = "checkbox"; mir.setAttribute("aria-label", "Mirror");
    mir.onchange = () => { state.mirror = mir.checked; state.mirrorAuto = false; draw(); };
    row("Mirror", mir, "Bottom-side artwork is mirrored so it reads correctly from below.");
    const minIn = lengthInput("Minimum feature", "minFeature");
    const enforce = el("input"); enforce.type = "checkbox"; enforce.setAttribute("aria-label", "Remove thin features");
    enforce.onchange = () => { state.enforce = enforce.checked; schedule(); };
    row("Remove thin features", enforce);
    const viewRow = el("span", null, "logo-pick");
    const src = el("input"); src.type = "checkbox"; src.checked = true; src.setAttribute("aria-label", "Show source");
    src.onchange = () => { state.showSource = src.checked; draw(); };
    const thin = el("input"); thin.type = "checkbox"; thin.checked = true; thin.setAttribute("aria-label", "Highlight thin features");
    thin.onchange = () => { state.showThin = thin.checked; draw(); };
    const l1 = el("label"), l2 = el("label"); l1.append(src, " Source"); l2.append(thin, " Thin features");
    viewRow.append(l1, l2);
    row("Show", viewRow);

    function sync() {
      const color = state.mode === "color";
      thresholdRow.closest("label").hidden = color; invRow.closest("label").hidden = color;
      colorsRow.closest("label").hidden = !color; layerRow.closest("label").hidden = color; palette.hidden = !color;
    }
    sync();
    function say(text) { status.textContent = text; }

    // Drop target.
    // Drops inside the dialog never reach the editor's project import.
    d.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); stage.classList.toggle("logo-drop", stage.contains(e.target)); });
    d.addEventListener("dragleave", e => { if (!stage.contains(e.relatedTarget)) stage.classList.remove("logo-drop"); });
    d.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); stage.classList.remove("logo-drop"); const f = e.dataTransfer?.files?.[0]; if (f) load(f); });
    if (typeof ResizeObserver === "function") new ResizeObserver(() => draw()).observe(stage);

    async function load(f) {
      say("Loading " + (f.name || "image") + "…");
      try {
        loaded = await loadImage(f);
        fileName.textContent = loaded.name + " · " + loaded.image.width + " × " + loaded.image.height + " px";
        empty.hidden = true;
        // Transparent artwork traces best by opacity.
        let clear = 0; const data = loaded.image.data;
        for (let i = 3; i < data.length; i += 4 * 16) if (data[i] < 128) clear++;
        if (clear > data.length / 64 * .1 && state.mode === "luminance") {
          let darkInk = 0, opaque = 0;
          for (let i = 0; i < data.length; i += 4 * 16) if (data[i + 3] >= 128) { opaque++; if (data[i] + data[i + 1] + data[i + 2] < 384) darkInk++; }
          if (darkInk < opaque * .5) { state.mode = "alpha"; modeSel.value = "alpha"; sync(); }
        }
        recompute();
      } catch (e) { say(e.message); }
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(recompute, 70); }
    function recompute() {
      if (!loaded) return;
      const t0 = performance.now();
      try {
        const size = state.lock ? (state.sizeBy === "height" ? {width: 0, height: state.height} : {width: state.width, height: 0}) : {width: state.width, height: state.height, stretch: true};
        result = process(loaded.image, {...state, ...size});
      } catch (e) { say(e.message); return; }
      state.width = result.size[0]; state.height = result.size[1];
      widthIn.refresh(); heightIn.refresh();
      if (result.trace.layers) renderPalette();
      const s = result.stats, ms = performance.now() - t0;
      say(s.polygons + " polygons · " + s.vertices.toLocaleString() + " vertices · " + U.format(result.size[0], unit, 3) + " × " + U.format(result.size[1], unit, 3) +
        " · pixel " + U.format(Math.min(...result.scale), unit, unit === "mil" ? 2 : 4) + " · traced in " + Math.round(ms) + " ms");
      warnings.replaceChildren(...result.warnings.map(w => el("li", w)));
      warnings.hidden = !result.warnings.length;
      place.disabled = result.empty || !s.polygons;
      draw();
    }
    function renderPalette() {
      const layers = result.trace.layers;
      if (state.layers.length !== layers.length) state.layers = layers.map(l => l.background ? "" : "Silk");
      palette.replaceChildren(el("h4", "Colour layers"));
      layers.forEach((l, i) => {
        const r = el("label", null, "logo-row logo-swatch-row"), sw = el("span", null, "logo-swatch");
        sw.style.setProperty("--swatch", l.hex); sw.title = l.hex;
        const s = el("select"); s.setAttribute("aria-label", "Layer for " + l.hex);
        s.add(new Option(l.background ? "Skip (background)" : "Skip", ""));
        for (const t of TARGETS) s.add(new Option(t.label, t.key));
        s.value = state.layers[i];
        s.onchange = () => { state.layers[i] = s.value; draw(); };
        const name = el("span"); name.append(sw, " " + l.hex + " · " + l.stats.polygons);
        r.append(name, s); palette.append(r);
      });
    }

    // Preview: source dimmed, traced regions in layer colours, thin features red.
    let overlay = null;
    function draw() {
      const dpr = globalThis.devicePixelRatio || 1;
      const W = Math.max(200, stage.clientWidth || 520), H = Math.max(200, stage.clientHeight || 380);
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + "px"; canvas.style.height = H + "px";
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = PCB?.system?.board || "#000"; g.fillRect(0, 0, W, H);
      if (!loaded) return;
      const img = loaded.image, k = Math.min((W - 24) / img.width, (H - 24) / img.height), ox = (W - img.width * k) / 2, oy = (H - img.height * k) / 2;
      const mirror = result && (state.mode === "color" ? false : state.mirror);
      g.save(); g.translate(ox, oy); g.scale(k, k);
      if (mirror) { g.translate(img.width, 0); g.scale(-1, 1); }
      if (state.showSource) { g.globalAlpha = .28; g.imageSmoothingEnabled = true; g.drawImage(loaded.canvas, 0, 0); g.globalAlpha = 1; }
      if (result) {
        const groups = result.trace.layers ? result.trace.layers.map((l, i) => [l.polygons, state.layers[i]]) : [[result.trace.polygons, state.layer]];
        for (const [polys, key] of groups) {
          if (!key) continue;
          const layer = target(key).layers[0];
          g.fillStyle = PCB?.color?.(layer) || "#ffff00";
          g.globalAlpha = .9;
          g.beginPath();
          for (const p of polys) for (const ring of [p.outer, ...p.holes]) { ring.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.closePath(); }
          g.fill("nonzero");
        }
        g.globalAlpha = 1;
        if (state.showThin && (result.thin || result.gaps)) {
          if (!overlay || overlay.result !== result) {
            const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
            const o = c.getContext("2d"), id = o.createImageData(img.width, img.height);
            for (let i = 0; i < img.width * img.height; i++) {
              if (result.thin?.[i]) { id.data[4 * i] = 255; id.data[4 * i + 1] = 40; id.data[4 * i + 2] = 60; id.data[4 * i + 3] = 230; }
              else if (result.gaps?.[i]) { id.data[4 * i] = 40; id.data[4 * i + 1] = 200; id.data[4 * i + 2] = 255; id.data[4 * i + 3] = 200; }
            }
            o.putImageData(id, 0, 0); overlay = {result, canvas: c};
          }
          g.imageSmoothingEnabled = false; g.drawImage(overlay.canvas, 0, 0);
        }
      }
      g.restore();
    }

    function commit() {
      if (!result) return;
      const keys = result.trace.layers ? state.layers : null;
      const t = target(state.layer);
      const out = build(result, {layer: state.layer, layers: keys, mirror: result.trace.layers ? undefined : state.mirror});
      if (!out.items.length) { say("Nothing to place: assign at least one colour to a layer."); return; }
      d.close();
      if (ctx.place) { ctx.place(out.items); ctx.info?.("Click to place the logo (" + out.items.length + " regions, " + out.vertices.toLocaleString() + " vertices)."); return; }
      // Fallback: drop the group at the board centre.
      const b = A().bounds(doc.outline) || [0, 0, 0, 0], cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      ctx.edit(() => { for (const i of out.items) { i.points = i.points.map(p => [round(p[0] + cx), round(p[1] + cy)]); doc.items.push(i); } });
      ctx.info?.("Logo placed on " + t.label + " (" + out.items.length + " regions).");
    }

    globalThis.AtriumShell?.adoptDialog?.(d, {title:head.querySelector("h2"), body:[body,status,warnings], actions});
    d.showModal();
    requestAnimationFrame(draw);
    return {dialog: d, load};
  }

  return {open, process, build, loadImage, TARGETS};
})();
