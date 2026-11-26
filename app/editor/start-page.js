"use strict";
// Start page: new project (blank or from a template), open, recent projects, the example design
// and an offline Getting Started guide. Shown at launch when no project is open (Preferences › General)
// and from File › Start Page; File › New project opens it on the templates.
//
//   AtriumStartPage.open({focus: "templates"|"recent", launch, welcome})  AtriumStartPage.close()
//   AtriumStartPage.recent() -> Promise<[{name, path, when, timeKind, kind, badge, badgeKind, thumbnail, open()}]>
//
// Recent projects come from AtriumRecent when a module provides it (list()/entries() and open()),
// otherwise from AtriumAutosave's recent slots, plus the native host's recent files.
//
// The first run offers a starting keyboard and mouse profile alongside the templates.
// The Start Page’s Customise Waffle button opens the detailed walkthrough in this page.
// The fab preset it sets
// ("start.fabPreset") applies to new blank projects made here.
globalThis.AtriumStartPage = (() => {
  const doc = globalThis.document, host = () => globalThis.AtriumNavHost, P = () => globalThis.AtriumPrefs;
  const t = globalThis.AtriumI18n?.define?.({
    "start.release_label": "{name} · {version}",
    "start.setup_progress": "{help} · {done} of {total} done",
    "start.setup_done": "{help} · {done} done",
  });
  const FOREIGN_EXTS = [".prjpcb", ".schdoc", ".pcbdoc", ".schlib", ".pcblib", ".kicad_pro", ".kicad_sch", ".kicad_pcb", ".kicad_sym", ".kicad_mod"];
  const ORIGINS = [
    ["altium", "Altium", "Altium keys"],
    ["kicad", "KiCad", "KiCad keys"],
    ["allegro", "Allegro / OrCAD", "Function keys"],
    ["eagle", "Eagle / Fusion", "One-letter tools"],
    ["new", "New to PCB", "Waffle defaults"],
  ];
  const FEATURED = {
    blank: ["Blank project", "One sheet and an empty board"],
    "sheet-infinite": ["Infinite canvas", "A sheet that grows as you draw"],
    "2l-100x80-jlc": ["2-layer board", "100 × 80 mm, JLCPCB rules"],
    "4l-impedance": ["4-layer, controlled impedance", "50 Ω and 90 Ω profiles"],
    shield: ["Microcontroller shield", "68.6 × 53.3 mm with headers"],
    "rigid-flex": ["Rigid-flex", "Two rigid ends and a flex tail"],
  };
  const RETURNING = ["blank", "2l-100x80-jlc", "4l-impedance", "rigid-flex"];
  // Saved tutorial progress (the key tutorial.js writes), so the link can offer to resume.
  function tutorialProgress() {
    try { const v = JSON.parse(globalThis.localStorage?.getItem("atrium.tutorial.v1") || "null"); return v?.v === 1 ? v : null; } catch { return null; }
  }
  // The walkthrough's saved state (welcome.js); none yet means it has never been shown.
  const WELCOME = "atrium.welcome.v1";
  function welcomeState() {
    try { const s = JSON.parse(globalThis.localStorage?.getItem(WELCOME) || "null"); return s?.v === 1 ? s : null; } catch { return null; }
  }
  function rememberWelcome() {
    const state = welcomeState();
    if (state?.seen) return;
    try { globalThis.localStorage?.setItem(WELCOME, JSON.stringify({...state, v:1, seen:true})); } catch {}
  }
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(doc, tag, cls, text); }
  function button(text, fn, cls, variant = "secondary", size) {
    const b = AtriumUI.button(el("button", cls, text), variant, size);
    b.onclick = fn;
    return b;
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) { const n = doc.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; }
  function icon(name) {
    const path = name === "play" ? "M8 5l11 7-11 7z" : name === "import" ? "M12 4v11m-4-4 4 4 4-4M5 19h14" : null;
    const glyph = path ? svg("svg", {class:"icon", "aria-hidden":"true"}) : AtriumNavCommon.icon(name);
    glyph.setAttribute("viewBox", "0 0 24 24");
    if (path) glyph.append(svg("path", {d:path}));
    return glyph;
  }
  function welcomeWordmark() {
    // The authored wordmark from brand/svg/waffle-wordmark.svg. A same-document
    // drawing keeps its theme ink on file:// without an external mask fetch.
    const mark = svg("svg", {class:"sp-wordmark", viewBox:"-4 -114 648 232", role:"img", "aria-label":"Waffle"});
    const clip = svg("clipPath", {id:"sp-wordmark-clip"});
    clip.append(svg("rect", {x:-40, y:-11, width:300, height:122}));
    const defs = svg("defs", {}); defs.append(clip);
    const ink = svg("g", {fill:"none", stroke:"currentColor", "stroke-width":22, "stroke-linejoin":"round", "stroke-miterlimit":10});
    ink.append(svg("path", {d:"M4.9 -30L40 100L67 0L94 100L129.1 -30", "stroke-linejoin":"miter", "clip-path":"url(#sp-wordmark-clip)"}));
    for (const d of [
      "M273 50A52 52 0 1 1 169 50A52 52 0 1 1 273 50Z",
      "M273 -11V111",
      "M338 111V-65A34 34 0 0 1 372 -99H384",
      "M402 111V-65A34 34 0 0 1 436 -99H448",
      "M308 0H442",
      "M479 -110V111",
      "M525 50H629A52 52 0 1 0 617.98 82.01",
    ]) ink.append(svg("path", {d}));
    mark.append(defs, ink);
    return mark;
  }
  const base = p => String(p || "").split(/[\\/]/).pop();
  function formatRecentTime(stamp, now = Date.now(), locale) {
    if (!Number.isFinite(stamp) || stamp <= 0) return "";
    const date = new Date(stamp), today = new Date(now);
    if (isNaN(date)) return "";
    const day = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const days = (day(today) - day(date)) / 86400000;
    if (days === 0 || days === 1) {
      const word = new Intl.RelativeTimeFormat(locale,{numeric:"auto"}).format(-days,"day");
      const label = word[0].toLocaleUpperCase(locale) + word.slice(1);
      return days ? label : label + ", " + date.toLocaleTimeString(locale,{hour:"numeric",minute:"2-digit"});
    }
    if (days > 1 && days < 7) return date.toLocaleDateString(locale,{weekday:"long"});
    return date.toLocaleDateString(locale,{day:"numeric",month:"short",...(date.getFullYear() !== today.getFullYear() && {year:"numeric"})});
  }
  // ------------------------------------------------------------------ recent projects
  const recentKinds = new Set(["project","pcb","schematic","library","drawing","panel"]);
  const recentTypes = new Map([
    ["waffle",["project"]], ["wpcb",["pcb"]], ["wsch",["schematic"]], ["wlib",["library"]], ["wdraw",["drawing"]], ["wpanel",["panel"]],
    ["prjpcb",["project","Altium"]], ["pcbdoc",["pcb","Altium"]], ["schdoc",["schematic","Altium"]],
    ["kicad_pro",["project","KiCad"]], ["kicad_pcb",["pcb","KiCad"]], ["kicad_sch",["schematic","KiCad"]]
  ]);
  const recentTimeKinds = new Set(["accessed","autosaved","modified"]);
  const text = v => typeof v === "string" ? v.trim() : "";
  const recentStamp = v => {
    const stamp = typeof v === "number" ? v : typeof v === "string" && /^\d{4}-\d\d-\d\d(?:T|$)/.test(v) ? Date.parse(v) : NaN;
    return Number.isFinite(stamp) && stamp > 0 && stamp <= 8.64e15 ? stamp : null;
  };
  function savedRecentPng(value) {
    const uri = typeof value === "string" ? value : value?.kind === "png" && value.data;
    const prefix = "data:image/png;base64,";
    if (typeof uri !== "string" || !uri.startsWith(prefix) || uri.length > 24576) return null;
    const encoded = uri.slice(prefix.length);
    if (encoded.length < 44 || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    try {
      const header = globalThis.atob(encoded.slice(0,32));
      if (!header.startsWith("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")) return null;
      // Check the PNG header's dimensions before the browser can decode it for a row.
      const side = at => header.charCodeAt(at)*16777216 + header.charCodeAt(at+1)*65536 + header.charCodeAt(at+2)*256 + header.charCodeAt(at+3);
      const w = side(16), h = side(20);
      if (w < 1 || w > 256 || h < 1 || h > 256) return null;
      return uri;
    } catch { return null; }
  }
  function normRecent(e, source, open) {
    if (typeof e === "string") e = {path:e};
    if (!e || typeof e !== "object") return null;
    const path = (typeof e.path === "string" && e.path) || (typeof e.file === "string" && e.file) || "";
    const leaf = base(path), dot = leaf.lastIndexOf(".");
    const [type, format] = recentTypes.get(dot > 0 ? leaf.slice(dot+1).toLowerCase() : "") || [];
    const givenName = text(e.name);
    if (!path && !givenName && !text(e.slot)) return null;
    const name = (!givenName || givenName === leaf) && type ? leaf.slice(0,dot) : givenName || leaf || "Untitled";
    const kind = type && type !== "project" ? type : recentKinds.has(e.kind) ? e.kind : "project";
    const branch = text(e.branch).replace(/^refs\/heads\//, "");
    const revision = text(e.revision);
    const imported = text(e.importLabel) || text(e.importFormat) || format;
    const badge = (branch || revision || imported || "").slice(0,96) || null;
    const badgeKind = branch ? "branch" : revision ? "revision" : imported ? "format" : null;
    const declaredTime = recentTimeKinds.has(e.timeKind) ? e.timeKind : null;
    const updatedKind = source === "autosave" ? "autosaved" : null;
    let when = null, timeKind = null;
    for (const [value, meaning] of [[e.when,declaredTime],[e.openedAt,"accessed"],[e.opened,"accessed"],
      [e.updated,updatedKind],[e.ts,updatedKind],[e.modified,"modified"],[e.time,null]]) {
      when = recentStamp(value);
      if (when !== null) { timeKind = meaning; break; }
    }
    return {name,path,when,timeKind,kind,badge,badgeKind,thumbnail:savedRecentPng(e.thumbnail),open};
  }
  async function loadRecent() {
    const local = async () => {
      const R = globalThis.AtriumRecent, AS = globalThis.AtriumAutosave;
      if (R) {
        return {rows:await (R.list?.() ?? R.entries?.() ?? R.recent?.()), source:"registry", open:e => (R.open || R.openRecent).call(R,e)};
      } else if (AS?.recent) {
        await AS.refreshRecent?.();
        return {rows:AS.recent(),source:"autosave",open:e => AS.openRecent(e.slot ?? e)};
      }
    };
    const native = async () => {
      const H = globalThis.AtriumHost;
      const rows = await H?.refreshRecentFiles?.({metadataOnly:true}) ?? H?.recentFiles?.();
      return {rows,source:"native",open:async e => {
        const selected = await H.openRecent(e,{activate:true});
        return selected?.length ? host().openFiles(selected) : true;
      }};
    };
    const results = await Promise.allSettled([local(),native()]);
    const entries = [], byPath = new Map();
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const {rows,source,open} = result.value;
      if (!rows || typeof rows[Symbol.iterator] !== "function" || typeof rows === "string") continue;
      let scanned = 0;
      for (const raw of rows) {
        const row = normRecent(raw,source,() => open(raw));
        if (row) {
          const previous = row.path && byPath.get(row.path);
          if (!previous) {
            entries.push(row);
            if (row.path) byPath.set(row.path,row);
          } else if (source === "native") {
            previous.open = row.open;
            if (row.when !== null) { previous.when = row.when; previous.timeKind = row.timeKind; }
            if (previous.kind === "project") previous.kind = row.kind;
            if (!previous.badge) { previous.badge = row.badge; previous.badgeKind = row.badgeKind; }
            previous.thumbnail ||= row.thumbnail;
          }
        }
        if (++scanned === 40) break;
      }
    }
    return entries.sort((a,b) => (b.when ?? 0)-(a.when ?? 0)).slice(0,10);
  }
  let loadingRecent;
  function recent() { return loadingRecent ||= loadRecent().finally(() => { loadingRecent = null; }); }

  // ------------------------------------------------------------------ dialog
  let dialog = null, ui = null, generation = 0, automatic = false, awaiting = false;
  function status(text, error) { ui.status.textContent = text || ""; ui.status.classList.toggle("sp-error", !!error); }
  function preview(outline, paper) {
    const s = svg("svg", {viewBox: "0 0 120 80", "aria-hidden": "true", class: "sp-preview"});
    if (paper) {
      if (paper === "infinite") {
        for (const x of [20, 40, 60, 80, 100]) for (const y of [16, 32, 48, 64])
          s.append(svg("circle", {cx:x, cy:y, r:1, class:"sp-dot"}));
      } else {
        const size = globalThis.AtriumSchAppearance?.sheetOf({kind:"schematic", sheet:{size:paper}});
        const w = 72, h = size ? w*size.height/size.width : 51;
        s.append(svg("rect", {x:24,y:(80-h)/2,width:w,height:h,class:"sp-blank"}),
          svg("path", {d:"M67 "+(40+h/2-10)+"h29m-29 0v10",class:"sp-plus"}));
      }
      return s;
    }
    if (!outline) {
      s.append(svg("path", {d:"M60 30v20M50 40h20", class:"sp-plus"}));
      return s;
    }
    const xs = outline.map(p => p[0]), ys = outline.map(p => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 || 1, h = Math.max(...ys) - y0 || 1;
    const k = Math.min(104 / w, 64 / h), ox = (120 - w * k) / 2, oy = (80 - h * k) / 2;
    s.append(svg("polygon", {points: outline.map(p => ((p[0] - x0) * k + ox).toFixed(1) + "," + ((p[1] - y0) * k + oy).toFixed(1)).join(" "), class: "sp-board"}));
    return s;
  }
  // The six Welcome illustrations use the supplied artboard's 120 × 80 drawing.
  // The template registry still owns the project geometry and creation.
  function welcomeIllustration(id) {
    const s = svg("svg", {viewBox:"0 0 120 80", "aria-hidden":"true", class:"sp-preview"});
    const board = (x, y, width, height, rx) => svg("rect", {
      x, y, width, height, rx, fill:"rgba(48,164,108,.16)", stroke:"#30A46C", "stroke-width":1.5,
    });
    if (id === "blank") {
      s.append(svg("path", {d:"M60 30v20 M50 40h20", class:"sp-plus"}));
    } else if (id === "sheet-infinite") {
      for (const x of [20,40,60,80,100]) {
        for (const y of [20,40,60]) {
          if (x !== 60 || y !== 40) s.append(svg("circle", {cx:x, cy:y, r:1, class:"sp-dot"}));
        }
      }
      s.append(svg("rect", {x:52, y:33, width:16, height:14, rx:2, fill:"none", stroke:"var(--muted)", "stroke-width":1.2}));
    } else if (id === "rigid-flex") {
      s.append(board(14,22,30,36,3), board(76,22,30,36,3),
        svg("path", {d:"M44 34h32v12H44z", fill:"rgba(201,138,43,.28)", stroke:"#C98A2B", "stroke-width":1}),
        svg("path", {d:"M44 38h32 M44 42h32", fill:"none", stroke:"#D9A33B", "stroke-width":1}));
    } else if (id === "2l-100x80-jlc" || id === "4l-impedance" || id === "shield") {
      if (id === "4l-impedance") s.append(
        svg("rect", {x:30, y:20, width:72, height:48, rx:4, fill:"rgba(48,164,108,.10)", stroke:"rgba(48,164,108,.5)", "stroke-width":1}),
        svg("rect", {x:26, y:16, width:72, height:48, rx:4, fill:"rgba(48,164,108,.12)", stroke:"rgba(48,164,108,.6)", "stroke-width":1}));
      s.append(board(22,12,72,48,4),
        svg("path", {d:"M34 40h14l6-6h18", fill:"none", stroke:"#D9A33B", "stroke-width":1.6, "stroke-linecap":"round"}));
      if (id === "shield") s.append(svg("path", {
        d:"M30 18h24 M62 18h24 M30 54h24 M62 54h24", fill:"none", stroke:"#C9C9C9", "stroke-width":3, "stroke-dasharray":"2 2",
      }));
    } else return null;
    return s;
  }
  // Built-in cards carry the geometry of their board directly in the template registration.
  function sketchSvg(sk) {
    const s = preview(sk.outline), xs = sk.outline.map(p => p[0]), ys = sk.outline.map(p => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0 || 1, h = Math.max(...ys) - y0 || 1, k = Math.min(104 / w, 64 / h), ox = (120 - w * k) / 2, oy = (80 - h * k) / 2;
    const X = p => ((p[0] - x0) * k + ox).toFixed(1), Y = p => ((p[1] - y0) * k + oy).toFixed(1), P = pts => pts.map(p => X(p) + "," + Y(p)).join(" ");
    for (const g of sk.regions || []) if (g.flex) s.append(svg("polygon", {points: P(g.points), class: "sp-flex", style: "fill:#d9a521;fill-opacity:.55;stroke:none"}));
    for (const [a, b] of sk.bends || []) s.append(svg("line", {x1: X(a), y1: Y(a), x2: X(b), y2: Y(b), style: "stroke:#7a5a00;stroke-width:1;stroke-dasharray:3 2"}));
    // Extra copper layers peek out behind the board; impedance profiles show as a routed pair.
    for (let n = Math.min(sk.layers, 6) - 1; n >= 1 && sk.layers > 2; n--) s.prepend(svg("polygon", {points: sk.outline.map(p => (+X(p) + n * 1.6).toFixed(1) + "," + (+Y(p) + n * 1.6).toFixed(1)).join(" "), class: "sp-board", style: "opacity:" + (.5 - n * .08).toFixed(2)}));
    if (sk.profiles) for (const d of [-1.3, 1.3]) s.append(svg("path", {d: "M" + (ox + 4) + " " + (40 + d) + "h" + (w * k * .35).toFixed(1) + "l6 -6h" + (w * k * .3).toFixed(1), style: "fill:none;stroke:#c8a050;stroke-width:1"}));
    for (const b of sk.parts || []) s.append(svg("rect", {x: X(b), y: Y(b), width: Math.max(1, (b[2] - b[0]) * k).toFixed(1), height: Math.max(1, (b[3] - b[1]) * k).toFixed(1), style: "fill:currentColor;fill-opacity:.45"}));
    s.setAttribute("data-sketch", "board");
    return s;
  }
  async function create(id, title) {
    const T = globalThis.AtriumTemplates, h = host();
    if (!T || !h) { status("The editor isn't ready yet.", true); return; }
    const name = ui.name.value.trim() || "Untitled";
    status("Creating " + name + "…");
    try {
      const project = await T.build(id, {name, prefs: P()?.changed?.() || {}, starter: P() ? P().get("library.starterInNewProjects") : true});
      const fab = id === "blank" || T.list().some(t => t.id === id && t.paper) ? await withFab(project) : null;
      const ok = h.replaceProject ? await h.replaceProject(project, {copy: true}) : await adopt(project, name);
      if (ok === false) { status("Kept the current project."); return; }
      showSchematic(project);
      close();
      h.info?.(name + " created from " + title + (fab ? " with " + fab + " rules" : "") + (project.library.length > 10 ? " · " + project.library.length + " parts in the library" : ""));
    } catch (e) { status(e.message, true); }
  }
  // Get set up › Fab house ("start.fabPreset"): a new blank project starts with that fab preset applied.
  const FAB_NEEDS = ["AtriumStackup", "AtriumViaStack", "AtriumRules", "AtriumFabProfiles", "AtriumImpedance", "AtriumFabPresets", "AtriumFabPresetsJLCPCB"];
  async function fabModules() {
    const L = globalThis.AtriumLazy, known = L?.modules?.() || [];
    if (L) await L.need(FAB_NEEDS.filter(n => globalThis[n] == null && known.includes(n)));
    return globalThis.AtriumFabPresets;
  }
  async function withFab(project) {
    const id = P()?.get("start.fabPreset"), pcb = project?.documents?.find(d => d.kind === "pcb");
    if (!id || !pcb) return null;
    const F = await fabModules(), p = F?.get?.(id);
    if (!p) return null;
    F.apply(project, pcb, id, {defs: new Map(project.library.map(d => [d.id, d]))});
    return p.name;
  }
  // A new project starts where the work starts: on its first schematic sheet, fitted to the sheet.
  function showSchematic(project) {
    const h = host(), sheet = project?.documents?.find(d => d.kind === "schematic");
    if (!sheet || !h?.selectDocument || h.currentId?.() === sheet.id) return;
    try { h.selectDocument(sheet.id); if (!sheet.items?.length) h.act?.("fit-document"); } catch {}
  }
  // Without replaceProject (older editors): open the project as a file.
  function adopt(project, name) {
    const f = new File([JSON.stringify(project)], name.replace(/[\\/:*?"<>|]/g, "_") + ".waffle", {type: "application/json"});
    return host().openFiles?.([f]) ?? false;
  }
  async function loadDemo() {
    const h = host();
    if (!h) { status("The editor isn't ready yet.", true); return; }
    try {
      const p = AtriumParts.example();
      const ok = h.replaceProject ? await h.replaceProject(p, {copy: true, dirty: false}) : await adopt(p, p.name);
      if (ok === false) { status("Kept the current project."); return; }
      close(); h.info?.("Opened the Sensor interface demo");
    } catch (e) { status(e.message, true); }
  }
  let continuing;
  function continueToEditor() {
    if (continuing) return continuing;
    const opened = generation, editor = host(), original = editor?.doc?.();
    const types = ["keydown","keyup"], keys = [];
    const stop = () => {for (const type of types) globalThis.removeEventListener(type, record, true);};
    const record = e => {
      if (!dialog.open || generation !== opened) {stop(); return;}
      if (!e.isTrusted || e.isComposing || e.key === "Tab" || AtriumKeymap.eventKey(e) < 0 ||
          (e.target !== doc.body && !dialog.contains(e.target))) return;
      if (e.type === "keyup" && e.key !== " ") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      keys.push(new KeyboardEvent(e.type,e));
    };
    // The editor owns keys as soon as the user chooses Continue, even while its
    // first controls are being prepared behind the modal.
    for (const type of types) globalThis.addEventListener(type, record, true);
    continuing = Promise.resolve().then(() => editor?.prepareWorkbench?.()).then(() => {
      stop();
      if (!dialog.open || generation !== opened || editor?.doc?.() !== original) return false;
      close();
      editor?.revealInspector?.(true);
      editor?.redraw?.();
      editor?.canvas?.()?.focus({preventScroll:true});
      for (const key of keys) {
        if (editor?.doc?.() !== original) break;
        (doc.activeElement || editor?.canvas?.())?.dispatchEvent(key);
      }
      return true;
    }, error => {
      if (dialog.open && generation === opened) status(error.message, true);
      return false;
    }).finally(() => {stop(); continuing = null;});
    return continuing;
  }
  const run = a => { continueToEditor().then(continued => { if (continued) host()?.act?.(a); }); };
  // New, Open and Import keep the page up while their dialog or file chooser is open. The
  // page closes once something starts opening (atrium-opening) or a project arrives, so a
  // cancelled chooser or prompt leaves it as it was.
  const pend = fn => { awaiting = true; fn(host()); };
  let guidePanel;
  globalThis.AtriumLazy?.register("AtriumGettingStartedGuide", {scripts:["getting-started-guide.js"]});
  async function openGuide() {
    const opened = generation;
    try {
      const rows = await AtriumLazy.need("AtriumGettingStartedGuide");
      if (!dialog.open || opened !== generation || guidePanel?.open) return;
      const body = el("article");
      let list;
      for (const [kind, spans] of rows) {
        const item = kind === "-" || /^\d+\.$/.test(kind);
        const line = el(item ? "li" : kind);
        line.append(...spans.map(span => typeof span === "string" ? span :
          AtriumShortcut.render(span.shortcut, {variant:"inline"})));
        if (item) {
          const tag = kind === "-" ? "UL" : "OL";
          if (list?.tagName !== tag) {
            list = el(tag.toLowerCase());
            if (tag === "OL") list.start = parseInt(kind, 10);
            body.append(list);
          }
          list.append(line);
        } else {
          list = null;
          body.append(line);
        }
      }
      guidePanel = AtriumShell.dialog({title:"Getting started", body:[body], className:"sp-guide"});
    } catch (error) {
      if (dialog.open && opened === generation) status(error.message, true);
    }
  }
  function startAction(id, text, glyph, fn) {
    const b = button(null, fn, "sp-action" + (id === "new" ? " sp-primary" : ""), "quiet");
    b.dataset.startAction = id;
    const tile = el("span", "sp-action-icon");
    tile.append(icon(glyph));
    b.append(tile, el("span", "sp-action-label", text));
    return b;
  }
  function chooseOrigin(input) {
    const version = ++originRequest;
    globalThis.AtriumLazy.need("AtriumWelcome").then(W => {
      if (version !== originRequest) return;
      W.choose("from", input.value);
      renderCustomise(W.progress());
    }).catch(e => { if (dialog.open && version === originRequest) status(e.message, true); });
  }
  function buildOrigins() {
    const section = el("section", "sp-coming"), heading = el("h2", null, "Coming from");
    const choices = el("div", "sp-origins");
    heading.id = "sp-origins";
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-labelledby", heading.id);
    for (const [id, name, detail] of ORIGINS) {
      const label = el("label", "sp-origin ui-choice ui-choice-tinted ui-choice-focus"), input = el("input", "visually-hidden");
      input.type = "radio"; input.name = "sp-origin"; input.value = id;
      // Click also applies a deliberate choice of the displayed default.
      input.onclick = input.onchange = () => chooseOrigin(input);
      label.append(input, el("strong", null, name), el("span", null, detail));
      choices.append(label);
    }
    section.append(heading, choices, el("p", "sp-hint", "Sets keys and mouse. Change them any time in Preferences."));
    return section;
  }
  function renderHeading() {
    ui.title.textContent = dialog.classList.contains("sp-welcome-on") ? "Get set up" : firstRun ? "Welcome to Waffle" : "Recent projects";
    ui.coming.hidden = !firstRun;
    ui.filterWrap.hidden = ui.recentSection.hidden = firstRun;
  }
  function build() {
    const d = el("dialog", "work-dialog sp-dialog");
    d.autofocus = true;
    const body = el("div", "sp-body"), left = el("aside", "sp-col sp-left"), right = el("div", "sp-col sp-right");
    const head = el("header", "sp-head"), mark = el("img", "sp-mark");
    mark.src = "brand/waffle-mark-butter.svg"; mark.alt = ""; mark.width = mark.height = 48;
    const release = globalThis.AtriumAbout;
    head.append(mark, welcomeWordmark(), el("p", "sp-release", t("start.release_label", {
      name:release?.CODENAME ?? "Butter", version:release?.VERSION ?? "0.8.0",
    })));
    const actions = el("nav", "sp-actions"); actions.setAttribute("aria-label", "Start");
    const fresh = startAction("new", "New Project…", "plus", () => pend(h => h?.act?.("new")));
    const openProject = startAction("open", "Open…", "open", () => pend(h => h?.openFilePicker?.()));
    const imports = startAction("import", "Import from Altium or KiCad…", "import", () => pend(h => h?.openFilePicker?.(FOREIGN_EXTS)));
    const recover = startAction("recover", "Recover Unsaved Work…", "undo", () => run("recover"));
    recover.hidden = !globalThis.AtriumAutosave?.openBrowser;
    const demo = startAction("demo", "Try the Demo", "play", loadDemo);
    actions.append(fresh, openProject, imports, recover, demo);
    const customise = startAction("customise", "Customise Waffle…", "settings", () => setWelcome(true, true));
    customise.classList.add("sp-customise");
    const customiseDetail = el("span", "sp-customise-detail");
    customiseDetail.setAttribute("aria-hidden", "true");
    customise.lastElementChild.append(customiseDetail);
    left.append(head, actions, customise);

    const title = el("h1", "sp-page-title", "Welcome to Waffle"); title.id = "sp-title";
    const rightHead = el("header", "sp-right-head"), filter = el("input", "ui-field");
    filter.type = "search"; filter.placeholder = "Filter"; filter.setAttribute("aria-label", "Filter recent projects");
    filter.oninput = () => paintRecent();
    const filterWrap = AtriumUI.searchField(filter); filterWrap.classList.add("sp-filter");
    rightHead.append(title, filterWrap);
    const coming = buildOrigins(), recentSection = el("section", "sp-recent-section"), recentList = el("ul", "sp-recent");
    recentList.setAttribute("aria-label", "Recent projects");
    recentSection.append(recentList);

    const templates = el("section", "sp-template-section"), templateHead = el("header", "sp-template-head");
    const all = button("All templates…", () => {
      expanded = !expanded;
      renderTemplates();
      if (expanded) ui.grid.querySelector(".sp-card")?.focus();
    }, "sp-link sp-all", "quiet");
    const label = el("label", "sp-name ui-field-row"), name = el("input", "ui-field");
    name.value = "Untitled"; name.spellcheck = false;
    label.append(el("span", null, "Project name"), name);
    templateHead.append(el("h2", null, "Start from a template"), all);
    const grid = el("div", "sp-templates"); grid.setAttribute("role", "list");
    grid.addEventListener("keydown", e => {
      const cards = [...grid.querySelectorAll(".sp-card")], i = cards.indexOf(doc.activeElement);
      if (i < 0) return;
      const cols = Math.max(1, cards.filter(b => b.offsetTop === cards[0].offsetTop).length);
      const step = {ArrowRight:1, ArrowLeft:-1, ArrowDown:cols, ArrowUp:-cols}[e.key];
      if (step) { e.preventDefault(); cards[Math.min(cards.length - 1, Math.max(0, i + step))].focus(); }
    });
    templates.append(templateHead, label, grid);
    const learn = el("nav", "sp-docs"); learn.setAttribute("aria-label", "Learn");
    const tutorial = button("Your first board · 10 min", () => run("tutorial"), "sp-link", "quiet");
    learn.append(el("span", "sp-learn-label", "Learn"), tutorial,
      button("Getting started", openGuide, "sp-link", "quiet"),
      button("Keyboard shortcuts", () => run("shortcuts"), "sp-link", "quiet"),
      button("What’s new", () => run("whats-new"), "sp-link", "quiet"));
    const welcome = el("div", "sp-welcome");
    const st = el("p", "sp-status"); st.setAttribute("role", "status"); st.setAttribute("aria-live", "polite");
    right.append(rightHead, coming, recentSection, templates, learn, welcome, st);
    body.append(left, right);

    const skip = button(null, continueToEditor, "sp-skip", "quiet");
    skip.dataset.startAction = "close";
    skip.setAttribute("aria-label", "Continue to editor");
    skip.setAttribute("aria-keyshortcuts", "Escape");
    skip.append(icon("close"));
    globalThis.AtriumNavCommon?.shortcutTitle(skip, "Continue to editor", "Escape");
    rightHead.append(skip);
    d.append(body);
    AtriumShell.adoptDialog(d, {title, body, defaultAction:false});

    const keymap = globalThis.AtriumKeymap, shortcuts = new Map();
    for (const b of [fresh, openProject]) {
      const cap = AtriumShortcut.render("", {variant:"keycap"});
      cap.setAttribute("aria-hidden", "true");
      b.append(cap);
      shortcuts.set(b.dataset.startAction, {b, cap});
    }
    const updateShortcuts = () => {
      for (const [id, {cap}] of shortcuts) {
        const key = keymap?.hintKey?.(id, host()?.doc?.()?.kind) || "";
        // The Welcome page accepts single-chord file commands while a modal is open.
        AtriumShortcut.render(key && keymap.parse(key).length === 1 ? key : "", {variant:"keycap", node:cap});
      }
    };
    keymap?.onChange?.(updateShortcuts);
    d.addEventListener("keydown", e => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (e.target === d && e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        fresh.click();
        return;
      }
      if (!keymap) return;
      if (!(e.metaKey || e.ctrlKey || e.altKey) && e.target.closest("input,textarea,select,[contenteditable]")) return;
      const key = keymap.eventKey(e);
      if (key < 0) return;
      const kind = host()?.doc?.()?.kind || "schematic";
      const bindings = keymap.table().root.get(key * 16 + keymap.eventMask(e, key))?.bindings || [];
      const command = keymap.firstPass(bindings, {kind, tool:"select", documentId:"welcome"}, true);
      const action = shortcuts.get(command?.command?.action || command?.id);
      if (action) {e.preventDefault(); action.b.click();}
    });
    d.addEventListener("cancel", e => {e.preventDefault(); continueToEditor();});
    d.addEventListener("close", () => {
      awaiting = false;
      if (!d.open) {
        if (firstRun) rememberWelcome();
        setWelcome(false);
      }
      if (doc.activeElement === doc.body) doc.getElementById("canvas")?.focus?.();
    });
    const arrived = () => { if (automatic || awaiting) close(); };
    globalThis.addEventListener?.("atrium-host-project", arrived);
    globalThis.addEventListener?.("atrium-opening", () => { if (awaiting) close(); });
    globalThis.addEventListener?.("atrium-git-binding", () => { if (globalThis.AtriumHost?.historyPath) arrived(); });
    globalThis.AtriumNavCommon?.ready?.(h => h.on?.("replace", arrived));
    doc.body.append(d);
    dialog = d;
    ui = {name, nameRow:label, all, body, right, title, filter, filterWrap, coming, recentSection, grid, recentList,
      status:st, welcome, tutorial, customise, customiseDetail, updateShortcuts};
  }
  let firstRun = false, expanded = false, originRequest = 0, recentItems = [];
  const welcomeApi = {run,
    importSettings: () => host()?.act?.("import-settings"), closeWelcome: () => setWelcome(false, true), welcomeProgress: renderCustomise};
  function renderCustomise(progress) {
    if (!ui) return;
    const help = "Keys, mouse, units and theme";
    const p = progress ?? globalThis.AtriumWelcome?.progress?.(), done = p?.done ?? Object.keys(welcomeState()?.done || {}).length;
    ui.customiseDetail.textContent = done ? p?.total ? t("start.setup_progress", {help, done, total:p.total}) :
      t("start.setup_done", {help, done}) : help;
  }
  function setWelcome(on, focus) {
    if (!dialog) return;
    const W = globalThis.AtriumWelcome;
    const wasOn = dialog.classList.contains("sp-welcome-on");
    dialog.classList.toggle("sp-welcome-on", !!on);
    renderHeading();
    if (!on) {
      W?.unmount?.(ui.welcome);
      if (wasOn) {
        ui.right.scrollTop = 0;
        ui.body.scrollTop = 0;
      }
      renderCustomise();
      if (focus) ui.customise.focus();
      return;
    }
    if (W?.isMounted?.(ui.welcome)) { if (focus) W.focus(); return; }
    ui.welcome.replaceChildren();
    const L = globalThis.AtriumLazy, started = generation;
    const current = () => generation === started && dialog.open && dialog.classList.contains("sp-welcome-on");
    (W ? Promise.resolve(W) : L ? L.need("AtriumWelcome") : Promise.reject(Error("Get set up is not available.")))
      .then(M => { if (!current()) return; M.mount(ui.welcome, welcomeApi); if (focus) M.focus(); },
        e => { if (current()) { status(e.message, true); setWelcome(false); } });
  }
  function renderTutorial() {
    const v = tutorialProgress();
    ui.tutorial.textContent = v && !v.finished && v.index > 0 ? "Resume Your First Board" : "Your first board · 10 min";
  }
  function renderTemplates() {
    ui.grid.replaceChildren();
    const available = globalThis.AtriumTemplates?.list?.() || [];
    const featured = firstRun ? Object.keys(FEATURED) : RETURNING;
    const chosen = expanded ? available : featured.map(id => available.find(t => t.id === id)).filter(Boolean);
    dialog.classList.toggle("sp-all-templates", expanded);
    ui.nameRow.hidden = !expanded;
    ui.all.textContent = expanded ? "Featured templates" : "All templates…";
    for (const t of chosen) {
      const item = el("div");
      item.setAttribute("role", "listitem");
      const card = button(null, () => create(t.id, t.title), "sp-card", "quiet");
      card.dataset.template = t.id;
      const [title, summary] = !expanded && FEATURED[t.id] || [t.title, t.summary];
      const text = el("span", "sp-card-text"); text.append(el("strong", null, title), el("span", null, summary));
      if (t.detail) card.title = t.detail;
      const thumb = el("span", "sp-card-thumb");
      thumb.append(welcomeIllustration(t.id) ?? (t.thumbnail?.layers ? sketchSvg(t.thumbnail) : preview(t.outline,t.paper)));
      const sk = t.thumbnail;
      if (sk?.layers) thumb.append(el("span", "ui-overlay-label", sk.layers + "L" + // the layer count over the artwork
        (sk.regions?.some(g => g.flex) ? " + flex" : "") + (sk.profiles && !sk.regions?.length ? " · Z" : "")));
      card.append(thumb, text);
      item.append(card);
      ui.grid.append(item);
    }
  }
  function paintRecent() {
    const {recentList:list, filter} = ui;
    const query = filter.value.trim().toLocaleLowerCase();
    const items = query ? recentItems.filter(r => [r.name, r.path, r.badge].some(v => (v || "").toLocaleLowerCase().includes(query))) : recentItems;
    list.replaceChildren();
    if (!items.length) {
      list.append(el("li", "sp-empty", recentItems.length ? "No matching projects" : "No recent projects yet"));
      return;
    }
    for (const r of items) {
      const li = el("li"), b = button(null, async () => { try { const ok = await r.open(); if (ok !== false) close(); } catch (e) { status(e.message, true); } }, "sp-recent-item", "quiet");
      const thumb = el("span", "sp-recent-thumb");
      if (r.thumbnail) {
        const image = el("img"); image.alt = ""; image.src = r.thumbnail; thumb.append(image);
      } else thumb.append(icon({pcb:"board", schematic:"schematic", library:"book", drawing:"drawing", panel:"layers"}[r.kind] || "project"));
      const label = el("span", "sp-recent-label");
      label.append(el("strong", null, r.name));
      if (r.path) label.append(el("span", "sp-recent-path", r.path));
      const badge = el("span", "sp-recent-meta");
      if (r.badge) badge.append(el("span", "ui-badge", r.badge)); // branch, revision or import: a library badge
      const time = el("time", "sp-recent-time", formatRecentTime(r.when));
      if (r.when) time.dateTime = new Date(r.when).toISOString();
      b.append(thumb, label, badge, time);
      li.append(b); list.append(li);
    }
  }
  async function renderRecent(expected, focus) {
    const items = await recent();
    if (generation !== expected || !dialog.open) return;
    recentItems = items;
    paintRecent();
    if (focus && doc.activeElement === ui.filter) (ui.recentList.querySelector("button") || ui.filter).focus();
  }
  function open(o = {}) {
    if (!doc?.body) return null;
    if (!dialog) build();
    generation++;
    automatic = o.launch === true;
    awaiting = false;
    try { globalThis.performance?.mark?.("atrium-start-page"); } catch {}
    const state = welcomeState(), welcome = !!o.welcome;
    firstRun = !state?.seen && !o.focus;
    expanded = o.focus === "templates";
    dialog.classList.toggle("sp-first-run", firstRun);
    if (!dialog.open) {ui.filter.value = ""; ui.name.value = "Untitled";}
    const keys = globalThis.AtriumKeymap?.preset?.() || "altium";
    const choice = state?.from || ({altium:"altium", kicad:"kicad", allegro:"allegro", modern:"eagle"})[keys];
    for (const input of ui.coming.querySelectorAll("input")) input.checked = input.value === choice;
    renderTemplates(); renderTutorial(); renderCustomise(); ui.updateShortcuts();
    if (!firstRun) renderRecent(generation, o.focus === "recent").catch(() => {});
    status("");
    dialog.classList.toggle("sp-launch", !!(o.launch && host()?.isStarter?.()));
    if (!dialog.open) dialog.showModal?.();
    setWelcome(welcome, !!o.welcome);
    try { (globalThis.requestAnimationFrame || setTimeout)(() => setTimeout(() => { try { globalThis.performance?.mark?.("atrium-start-page-painted"); } catch {} }, 0)); } catch {}
    if (o.welcome) return dialog;
    const target = o.focus === "templates" ? ui.grid.querySelector(".sp-card") : o.focus === "recent" ? ui.filter : dialog;
    target?.focus({preventScroll:true});
    return dialog;
  }
  function close() {
    if (!dialog?.open) return;
    generation++;
    automatic = awaiting = false;
    if (firstRun) rememberWelcome();
    dialog.close(); dialog.classList.remove("sp-launch");
  }
  async function launch() {
    const started = generation, editor = host(), session = editor?.fileSession?.();
    const current = () => generation === started && host() === editor && editor?.fileSession?.() === session;
    try { if ((await globalThis.AtriumAutosave?.boot?.())?.openingFile) return; } catch {}
    const mode = P()?.get("general.startPage") || "auto";
    if (!current() || globalThis.__atriumOpeningProject || mode === "never" || (mode === "auto" && editor?.isStarter?.() === false)) return;
    // A recovery prompt gets the first decision. Recheck the active project after it closes.
    const shown = doc?.querySelector("dialog[open]");
    if (shown) { if (shown !== dialog) shown.addEventListener("close", () => { if (current()) launch(); }, {once: true}); return; }
    return open({launch: true});
  }
  return Object.freeze({open, launch, close, recent, formatRecentTime, isOpen: () => !!dialog?.open, withFab});
})();
