"use strict";
// Bill of Materials: an Altium-style grouped BOM grid with CSV, Excel, HTML and
// printed / PDF output (print-report.js). The functions above `open` are pure and DOM-free.
globalThis.AtriumBOM = (() => {
  // ---------------------------------------------------------------- ordering
  const tokens = s => String(s ?? "").match(/\d+|\D+/g) || [];
  function naturalCompare(a, b) { return compareTokens(tokens(a), tokens(b), a, b); }
  // naturalCompare for one sort over many values: each value is split into tokens once.
  function naturalComparer() {
    const memo = new Map(), tok = v => { const k = String(v ?? ""); let t = memo.get(k); if (!t) memo.set(k, t = tokens(k)); return t; };
    return (a, b) => compareTokens(tok(a), tok(b), a, b);
  }
  function compareTokens(x, y, a, b) {
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const p = x[i], q = y[i], pd = /^\d/.test(p), qd = /^\d/.test(q);
      if (pd && qd) {
        const m = p.replace(/^0+(?=\d)/, ""), n = q.replace(/^0+(?=\d)/, "");
        if (m.length !== n.length) return m.length - n.length;
        if (m !== n) return m < n ? -1 : 1;
        if (p.length !== q.length) return p.length - q.length;
      } else if (pd !== qd) return pd ? -1 : 1;
      else {
        const m = p.toLowerCase(), n = q.toLowerCase();
        if (m !== n) return m < n ? -1 : 1;
      }
    }
    if (x.length !== y.length) return x.length - y.length;
    const s = String(a ?? ""), t = String(b ?? "");
    return s < t ? -1 : s > t ? 1 : 0;
  }
  // "C1, C3-C5": runs of at least `minRun` consecutive numbers share a range.
  function compress(refs, minRun = 3) {
    const list = [...new Set([...refs].map(r => String(r ?? "").trim()).filter(Boolean))].sort(naturalCompare);
    const split = r => /^(.*?)(0|[1-9]\d*)$/.exec(r);
    const out = [];
    for (let i = 0; i < list.length;) {
      const m = split(list[i]);
      let j = i;
      while (m && j + 1 < list.length) {
        const n = split(list[j + 1]);
        if (!n || n[1] !== m[1] || Number(n[2]) !== Number(m[2]) + j + 1 - i) break;
        j++;
      }
      if (j - i + 1 >= Math.max(2, minRun)) { out.push(list[i] + "-" + list[j]); i = j + 1; }
      else { out.push(list[i]); i++; }
    }
    return out.join(", ");
  }

  // ------------------------------------------------------------- collection
  const {clean, upper, paramKey, parameters, fieldOf, FIELD_KEYS, fallbackParameters} = globalThis.Atrium.partParameters;
  const truthy = v => /^(1|y|yes|true|t|x|on)$/i.test(clean(v));
  const falsy = v => /^(0|n|no|false|f|off|none)$/i.test(clean(v));
  // Parameters shown through dedicated columns or used only for exclusion.
  const reserved = new Set(["COMMENT", "DESCRIPTION", "DESIGNATOR", "FOOTPRINT", "LIBREF", "LIB REF", "LIBREFERENCE"]);
  const dnpKeys = ["DNP", "DNI", "DNF", "DO NOT POPULATE", "DONOTPOPULATE", "DO NOT FIT", "NOT FITTED", "NOTFITTED", "NO POP", "NOPOP", "NO STUFF"];
  const fitKeys = ["FITTED", "POPULATE", "POPULATED", "STUFF", "STUFFED", "FIT"];
  const dnpText = /^(dnp|dni|dnf|no ?pop|not ?fitted|no ?fit|no ?stuff|do not (populate|fit|place|stuff|mount))$/i;
  const dnpMark = /(^|[\s_/(\[,;-])(DNP|DNI|DNF)($|[\s_/)\],;-])/;
  function doNotPopulate(item, comment, params) {
    if (item?.dnp === false) return false; // an explicit "fitted" set in the BOM editor
    if (item?.dnp === true || item?.doNotPopulate === true || item?.populate === false || item?.fitted === false) return true;
    for (const k of dnpKeys) if (k in params && (truthy(params[k]) || dnpText.test(params[k]) || params[k] === "")) return true;
    for (const k of fitKeys) if (k in params && (falsy(params[k]) || dnpText.test(params[k]))) return true;
    for (const k of ["VARIANT", "ASSEMBLY", "BOM STATUS", "STATUS"]) if (k in params && dnpText.test(params[k])) return true;
    return dnpText.test(comment) || dnpMark.test(comment);
  }
  // The base design's do-not-populate state of one part (variants.js uses it as "not fitted").
  const isDnp = (item, def) => doNotPopulate(item, clean(item?.value), parameters(item, def));
  // Altium component kinds: 1 mechanical, 2 graphical, 4 net tie (no BOM), 5 standard (no BOM).
  function notInBOM(item, def, params) {
    if (item?.excludeFromBOM === true || def?.excludeFromBOM === true || item?.inBOM === false || def?.inBOM === false) return true;
    const kind = clean(item?.componentKind ?? def?.componentKind ?? params.COMPONENTKIND ?? params["COMPONENT KIND"]).toLowerCase();
    if (/^(1|2|4|5|mechanical|graphical|net ?tie ?\(no ?bom\)|standard ?\(no ?bom\)|net_?tie_?no_?bom|standard_?no_?bom)$/.test(kind)) return true;
    return truthy(params["EXCLUDE FROM BOM"]) || falsy(params["IN BOM"]) || falsy(params.BOM);
  }
  const powerName = /^(gnd[a-z0-9]*|[adp]gnd|earth|chassis|ground|v(cc|dd|ee|ss|bat|bus|in|out|ref)[a-z0-9_]*|v[+-]|[+-]?\d+(\.\d+)?v\d*|[+-]?\d+v\d+)$/i;
  function virtualSymbol(item, def, hasFootprint) {
    if (item?.virtual === true || item?.power === true || def?.virtual === true || def?.power === true) return true;
    if (/^#/.test(clean(item?.ref))) return true; // KiCad-style #PWR, #FLG
    if (hasFootprint) return false;
    const pins = def?.symbol?.pins || [];
    if (!pins.length) return true; // graphic-only symbol
    if (pins.every(p => p.electrical === 7)) return true; // Altium power pins
    if (/\b(power|virtual|graphic|logo|title|frame|flag)\b/i.test(clean(def?.category))) return true;
    return pins.length <= 1 && [def?.name, item?.value].some(n => powerName.test(clean(n)));
  }
  const FIELD_LABEL = {mpn: "Manufacturer Part Number", manufacturer: "Manufacturer", supplier: "Supplier", supplierPn: "Supplier Part Number", description: "Description"};
  const querySources = new WeakMap();
  const ownDescription = item => {
    const p = item?.parameters;
    if (!p || typeof p !== "object") return "";
    for (const k of Object.keys(p)) if (paramKey(k) === "DESCRIPTION") return clean(p[k]);
    return "";
  };
  function describe(item, def, doc, read, alternateDescription) {
    const params = read(item, def);
    return {
      id: item.id, docId: doc.id, docName: doc.name, side: doc.kind, at: [item.x, item.y],
      ...(item.mcInstance ? {instanceId:item.mcInstance.id} : {}),
      ref: clean(item.ref), comment: clean(item.value), def,
      description: alternateDescription?.(item, params) ?? (ownDescription(item) || clean(def?.description) || params.DESCRIPTION || ""),
      libRef: clean(def?.libRef ?? (doc.kind === "schematic" ? def?.name : "")) || params.LIBREF || params["LIB REF"] || "",
      footprint: doc.kind === "pcb" ? clean(def?.footprint?.name || def?.name) : clean(def?.footprintName || def?.footprint?.name || params.FOOTPRINT),
      params, item
    };
  }
  const sameText = (a, b) => upper(a) === upper(b);
  function pick(project, options = {}) {
    const docs = project.documents || [];
    const sheets = docs.filter(d => d.kind === "schematic"), boards = docs.filter(d => d.kind === "pcb");
    const hasParts = d => d.items.some(i => i.kind === "part");
    const board = boards.find(b => b.id === options.board) || boards.find(hasParts) || boards[0] || null;
    let source = options.source === "pcb" || options.source === "schematic" ? options.source : null;
    if (!source) source = sheets.some(hasParts) || !board ? "schematic" : "pcb";
    if (source === "pcb" && !board) source = "schematic";
    return {sheets, board, source};
  }
  // Gather included and excluded components plus schematic/board differences.
  // Assembly variants (app/variants.js): options.variant names one (id or name; null or "" for the
  // base design); without it the project's active variant applies. Parts then carry the variant's
  // fitted state, alternate part, comment and parameters, while e.item stays the live part so
  // edits made from the BOM land on the design.
  function variantFor(project, options) {
    const V = globalThis.AtriumVariants;
    if (!V || project?.variantApplied !== undefined) return null;
    const v = V.current(project, options.variant);
    return v ? {variant: v, project: V.apply(project, v.id)} : null;
  }
  function collect(project, options = {}) {
    const span = globalThis.AtriumDiagnostics?.performance?.begin("manufacturing", "compute");
    return span ? span.run(collectParts, project, options) : collectParts(project, options);
  }
  function collectParts(project, options = {}) {
    const live = project, applied = variantFor(project, options);
    if (applied) project = applied.project;
    const variant = applied ? {id: applied.variant.id, name: applied.variant.name} : project.variantApplied || null;
    const defs = new Map((project.library || []).map(d => [d.id, d]));
    const {sheets, board, source} = pick(project, options);
    const parts = d => d ? d.items.filter(i => i.kind === "part") : [];
    const appliedParams = globalThis.AtriumVariants?.appliedParameters(project, defs);
    const alternateDescription = globalThis.AtriumVariants?.appliedDescription(project, defs);
    const read = appliedParams || parameters;
    const sch = [], notes = [];
    for (const sheet of sheets) for (const item of (globalThis.AtriumMultichannel?.sheetParts(project, sheet) || parts(sheet))) sch.push(describe(item, defs.get(item.def), sheet, read, alternateDescription));
    const brd = parts(board).map(item => describe(item, defs.get(item.def), board, read, alternateDescription));
    const index = list => {
      const byLink = new Map(), byRef = new Map();
      for (const e of list) {
        const link = e.item.link;
        if (link) byLink.set(link, byLink.has(link) ? null : e);
        const ref = upper(e.ref);
        if (ref && !ref.includes("?")) byRef.set(ref, byRef.has(ref) ? byRef.get(ref) : e);
      }
      return e => (e.item.link && byLink.get(e.item.link)) || byRef.get(upper(e.ref)) || null;
    };
    const boardMate = index(brd), sheetMate = index(sch);
    for (const e of sch) {
      const mate = boardMate(e);
      e.mate = mate;
      if (!e.footprint && mate) e.footprint = mate.footprint;
    }
    for (const e of brd) {
      const mate = sheetMate(e);
      e.mate = mate;
      if (mate) {
        e.description = e.description || mate.description;
        e.libRef = e.libRef || mate.libRef;
        e.params = appliedParams ? appliedParams(e.item, e.def, mate.params) : fallbackParameters(e.params, mate.params);
      }
    }
    // Once per entry (the mismatch pass asks again).
    const classes = new Map();
    function classify(e) {
      let r = classes.get(e);
      if (r === undefined) classes.set(e, r = classify0(e));
      return r;
    }
    function classify0(e) {
      const footprint = Boolean(e.footprint);
      if (notInBOM(e.item, e.def, e.params)) return "Not in BOM";
      if (virtualSymbol(e.item, e.def, footprint || Boolean(e.mate))) return "Power or virtual symbol";
      if (doNotPopulate(e.item, e.comment, e.params)) return "Do not populate";
      if (!footprint) return "No footprint";
      return null;
    }
    // Multi-part schematic components (U1A, U1B) share one designator and
    // count once, as in Altium.
    function unique(list) {
      const seen = new Map(), out = [];
      for (const e of list) {
        const ref = upper(e.ref);
        if (!ref || ref.includes("?")) { out.push(e); continue; }
        const first = seen.get(ref);
        if (!first) { seen.set(ref, e); out.push(e); e.instances = [e]; continue; }
        first.instances.push(e);
        if (!sameText(first.comment, e.comment) || !sameText(first.footprint, e.footprint)) {
          first.duplicate = true;
          notes.push(e.ref + " is used more than once with a different comment or footprint (" + first.docName + ", " + e.docName + ").");
        }
      }
      return out;
    }
    const sheetUnique = unique(sch), boardUnique = unique(brd);
    const chosen = source === "pcb" ? boardUnique : sheetUnique;
    const included = [], excluded = [], dnp = [];
    for (const e of chosen) {
      Object.assign(e, fieldOf(e.params));
      const reason = classify(e);
      if (reason) excluded.push({ref: e.ref, reason, comment: e.comment, id: e.id, docId: e.docId, docName: e.docName, at: e.at});
      else included.push(e);
      if (reason === "Do not populate") { e.dnp = true; dnp.push(e); }
    }
    const unannotated = included.filter(e => !e.ref || e.ref.includes("?")).length;
    if (unannotated) notes.push(unannotated + " component" + (unannotated === 1 ? " is" : "s are") + " not annotated.");
    // Differences between the schematic and the board, matched by designator.
    const mismatches = [];
    if (board && sheets.length) {
      const physical = e => !["Not in BOM", "Power or virtual symbol", "No footprint"].includes(classify(e));
      const left = new Map(), right = new Map();
      for (const e of sheetUnique) if (e.ref && !e.ref.includes("?") && physical(e)) left.set(upper(e.ref), e);
      for (const e of boardUnique) if (e.ref && !e.ref.includes("?")) right.set(upper(e.ref), e);
      const add = (kind, s, b) => mismatches.push({ref: (s || b).ref, kind,
        schematic: s ? (kind === "footprint" ? s.footprint : s.comment) : "", board: b ? (kind === "footprint" ? b.footprint : b.comment) : "",
        schematicId: s?.id || null, boardId: b?.id || null});
      for (const [ref, s] of left) {
        const b = right.get(ref);
        if (!b) { add("schematic-only", s, null); continue; }
        if (!sameText(s.comment, b.comment)) add("comment", s, b);
        const sf = clean(s.def?.footprintName || s.def?.footprint?.name || s.params.FOOTPRINT);
        if (sf && !sameText(sf, b.footprint)) add("footprint", {...s, footprint: sf}, b);
      }
      for (const [ref, b] of right) if (!left.has(ref)) add("board-only", null, b);
      mismatches.sort((a, b) => naturalCompare(a.ref, b.ref) || a.kind.localeCompare(b.kind));
    }
    const paramNames = new Set();
    for (const e of included) for (const k of Object.keys(e.params)) if (!reserved.has(k)) paramNames.add(k);
    if (applied) {
      const items = new Map();
      for (const d of live.documents) for (const i of d.items) if (i.kind === "part") items.set(d.id + "\u0001" + i.id, i);
      for (const e of [...sch, ...brd]) e.item = items.get(e.docId + "\u0001" + e.id) || e.item;
    }
    const result = {source, variant, board: board ? {id: board.id, name: board.name} : null, sheets: sheets.map(s => ({id: s.id, name: s.name})),
      parts: included, excluded, dnp, mismatches, notes, params: [...paramNames].sort(naturalCompare)};
    querySources.set(result,project);
    return result;
  }

  // ---------------------------------------------------------------- columns
  const titleCase = s => s.toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  // group:false columns can't be grouped; editable ones are written back to the parts.
  const builtins = [
    {key: "line", label: "Line #", numeric: true, group: false},
    {key: "status", label: "Status", group: false},
    {key: "comment", label: "Comment", editable: true},
    {key: "description", label: "Description", editable: true},
    {key: "designator", label: "Designator", group: false},
    {key: "footprint", label: "Footprint"},
    {key: "libref", label: "LibRef"},
    {key: "quantity", label: "Quantity", numeric: true, group: false},
    {key: "manufacturer", label: "Manufacturer", editable: true},
    {key: "mpn", label: "Manufacturer Part Number", editable: true},
    {key: "supplier", label: "Supplier", editable: true},
    {key: "supplierPn", label: "Supplier Part Number", editable: true},
    {key: "stock", label: "Stock", numeric: true, group: false},
    {key: "price", label: "Unit Price", numeric: true, group: false},
    {key: "lifecycle", label: "Lifecycle", group: false},
    {key: "dnp", label: "DNP", editable: true},
    {key: "document", label: "Document"}
  ];
  const defaultColumns = ["line", "comment", "description", "designator", "footprint", "libref", "quantity"];
  const defaultGroups = ["comment", "footprint", "mpn"];
  // The grid's default columns, plus Supplier Part Number (LCSC #) when the project's parts have
  // such a parameter (the starter library's "LCSC #"), so a JLC order shows what is missing.
  function gridDefaults(project) {
    const has = (project?.library || []).some(d => d?.parameters && Object.keys(d.parameters).some(k => FIELD_KEYS.supplierPn.test(paramKey(k))));
    return has ? [...defaultColumns, "supplierPn"] : defaultColumns.slice();
  }
  function columns(collected) {
    const out = builtins.map(c => ({group: true, numeric: false, editable: false, ...c}));
    for (const name of collected?.params || []) out.push({key: "p:" + name, label: titleCase(name), group: true, numeric: false, editable: true, param: name});
    return out;
  }
  // Supplier data (stock, price, lifecycle) comes from the caller, keyed by upper-case MPN.
  const solutionFor = (e, settings) => e.mpn && settings?.solutions ? (settings.solutions.get ? settings.solutions.get(upper(e.mpn)) : settings.solutions[upper(e.mpn)]) : null;
  function field(e, key, settings) {
    if (key === "comment") return e.comment;
    if (key === "description") return e.description;
    if (key === "footprint") return e.footprint;
    if (key === "libref") return e.libRef;
    if (key === "designator") return e.ref;
    if (key === "manufacturer" || key === "mpn" || key === "supplierPn") return e[key] || "";
    if (key === "supplier") return e.supplier || solutionFor(e, settings)?.supplier || "";
    if (key === "dnp") return e.dnp ? "DNP" : "";
    if (key === "stock") { const s = solutionFor(e, settings); return s && Number.isFinite(s.stock) ? s.stock : ""; }
    if (key === "price") { const s = solutionFor(e, settings); return s && Number.isFinite(s.unit) ? s.unit : ""; }
    if (key === "lifecycle") return solutionFor(e, settings)?.lifecycle || "";
    if (key === "document") return [...new Set((e.instances || [e]).map(i => i.docName))].join(", ");
    if (key.startsWith("p:")) return e.params[key.slice(2)] ?? "";
    return "";
  }
  const STATUS_TEXT = {dnp: "DNP", placeholder: "Placeholder", "missing-mpn": "No MPN", unbalanced: "Unbalanced", duplicate: "Duplicate", mismatch: "Board differs",
    "out-of-stock": "Out of stock", eol: "EOL", nrnd: "NRND", obsolete: "Obsolete"};
  const sortList = sort => (Array.isArray(sort) ? sort : sort ? [sort] : []).filter(s => s && typeof s.key === "string").map(s => ({key: s.key, dir: s.dir < 0 ? -1 : 1}));
  // Group included parts and compute every column value and status per line.
  function build(collected, settings = {}) {
    const span = globalThis.AtriumDiagnostics?.performance?.begin("manufacturing", "build");
    return span ? span.run(groupRows, collected, settings) : groupRows(collected, settings);
  }
  function groupRows(collected, settings = {}) {
    const all = columns(collected), known = new Set(all.filter(c => c.group).map(c => c.key));
    const groupBy = (settings.groupBy ?? defaultGroups).filter(k => known.has(k));
    const parts = settings.showDnp ? [...collected.parts, ...(collected.dnp || [])] : collected.parts;
    const groups = new Map();
    for (const e of parts) {
      // DNP parts never share a line with fitted ones.
      const key = (e.dnp ? "D" : "F") + (groupBy.length ? JSON.stringify(groupBy.map(k => field(e, k, settings))) : "#" + e.id) +
        // Generic parts (generic-parts.js): their ratings (def.generic.fields) are part of the line.
        (groupBy.length && Array.isArray(e.def?.generic?.fields) ? JSON.stringify(e.def.generic.fields.map(k => e.params[paramKey(k)] ?? "")) : "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    const refCount = new Map();
    for (const e of parts) { const r = upper(e.ref); if (r && !r.includes("?")) refCount.set(r, (refCount.get(r) || 0) + 1); }
    const differs = new Set((collected.mismatches || []).map(m => upper(m.ref)));
    const boards = Math.max(1, settings.boards || 1);
    const rows = [], natural = naturalComparer();
    for (const list of groups.values()) {
      list.sort((a, b) => natural(a.ref, b.ref));
      const values = Object.create(null);
      for (const c of all) {
        if (c.key === "designator") values.designator = compress(list.map(p => p.ref), settings.minRun ?? 3);
        else if (c.key === "quantity") values.quantity = list.length;
        else if (c.key !== "line" && c.key !== "status") {
          const seen = [];
          for (const p of list) { const v = field(p, c.key, settings); if (v !== "" && v != null && !seen.includes(v)) seen.push(v); }
          values[c.key] = c.numeric ? (seen.length === 1 ? seen[0] : seen.length ? seen.join(", ") : "") : seen.join(", ");
        }
      }
      const dnp = list.every(p => p.dnp), status = [];
      if (dnp) status.push("dnp");
      // A placeholder (generic-parts role "placeholder") still has to be resolved to a real component: its own status, not No MPN.
      const placeholder = !dnp && list.some(p => p.def?.generic?.role === "placeholder");
      if (placeholder) status.push("placeholder");
      if (!dnp && !placeholder && !list.some(p => p.mpn || p.supplierPn)) status.push("missing-mpn");
      if (["comment", "footprint", "mpn", "manufacturer"].some(k => new Set(list.map(p => upper(field(p, k, settings)))).size > 1)) status.push("unbalanced");
      if (list.some(p => p.duplicate || refCount.get(upper(p.ref)) > 1)) status.push("duplicate");
      if (list.some(p => differs.has(upper(p.ref)))) status.push("mismatch");
      const sol = list.map(p => solutionFor(p, settings)).filter(Boolean);
      if (!dnp && sol.length && sol.some(x => Number.isFinite(x.stock) && x.stock < list.length * boards)) status.push("out-of-stock");
      for (const life of ["eol", "nrnd", "obsolete"]) if (sol.some(x => x.lifecycle === life)) status.push(life);
      values.status = status.map(s => STATUS_TEXT[s]).join(", ");
      rows.push({parts: list, refs: list.map(p => p.ref), first: list[0]?.ref || "", values, status, dnp});
    }
    const sorts = sortList(settings.sort ?? {key: "designator", dir: 1}).map(s => ({...s, column: all.find(c => c.key === s.key)})).filter(s => s.column);
    const byRef = (a, b) => natural(a.first, b.first);
    rows.sort((a, b) => {
      for (const {column, dir} of sorts) {
        let r = 0;
        if (column.key === "line" || column.key === "designator") r = byRef(a, b);
        else {
          const x = a.values[column.key], y = b.values[column.key];
          if (column.numeric && typeof x === "number" && typeof y === "number") r = x - y;
          else r = (x === "" || x == null) - (y === "" || y == null) || natural(x, y); // blanks last
        }
        if (r) return r * dir;
      }
      return byRef(a, b);
    });
    rows.forEach((row, i) => { row.line = i + 1; row.values.line = i + 1; });
    return rows;
  }
  // Search box and per-column filters. "=text" matches exactly, "!text" excludes.
  function matchText(value, f) {
    const v = String(value ?? "").toLowerCase(), t = String(f).trim().toLowerCase();
    if (!t) return true;
    if (t.startsWith("!")) return t.length === 1 ? v !== "" : !v.includes(t.slice(1));
    if (t.startsWith("=")) return v === t.slice(1);
    return v.includes(t);
  }
  const queryKey = (documentId,instanceId,id) => JSON.stringify([documentId,instanceId ?? "",id]);
  async function queryMatches(service, collected, source, options) {
    const project = querySources.get(collected);
    if (!project) throw Error("The bill of materials source is unavailable.");
    const scopes = new Map(), matches = new Set();
    for (const part of [...collected.parts,...collected.dnp]) for (const member of part.instances || [part]) {
      const {docId:documentId,instanceId} = member;
      scopes.set(queryKey(documentId,instanceId,""),{documentId,instanceId});
    }
    for (const scope of scopes.values()) {
      const result = await service.selection(source,{...options,project,...scope});
      if (!result.complete) throw Error(result.diagnostic?.message || "The design query could not finish.");
      for (const row of result.rows) matches.add(queryKey(row.documentId,row.instanceId,row.id));
    }
    return matches;
  }
  function filterRows(rows, settings = {}, keys, matches) {
    const q = matches ? "" : String(settings.query || "").trim().toLowerCase();
    const filters = Object.entries(settings.filters || {}).filter(([, f]) => String(f ?? "").trim());
    if (!q && !filters.length && !matches) return rows;
    return rows.filter(row => {
      for (const [k, f] of filters) if (!matchText(k === "designator" ? row.refs.join(" ") + " " + row.values.designator : row.values[k], f)) return false;
      if (matches && !row.parts.some(part => (part.instances || [part]).some(member =>
        matches.has(queryKey(member.docId,member.instanceId,member.id))))) return false;
      if (!q) return true;
      if (row.refs.some(r => r.toLowerCase().includes(q))) return true;
      return (keys || Object.keys(row.values)).some(k => String(row.values[k] ?? "").toLowerCase().includes(q));
    });
  }

  // Optimiser hints (AtriumBOMOptimiser.hints) per grid line: a line shows every hint about any of
  // its parts, so a merge marks each line it involves however the grid is grouped. Map row -> hints.
  function rowHints(rows, hints) {
    const out = new Map();
    if (!hints?.byPart?.size) return out;
    for (const row of rows) {
      let found = null;
      for (const p of row.parts) {
        const hs = hints.byPart.get(p.id);
        if (hs) for (const h of hs) { if (!found) found = [h]; else if (!found.includes(h)) found.push(h); }
      }
      if (found) out.set(row, found);
    }
    return out;
  }

  // ------------------------------------------------------------------ views
  // Named views live in the project (project.bomViews) so exports and
  // automation reproduce what the editor shows.
  const strs = (v, n = 200) => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === "string" && x.length <= 300))].slice(0, n) : null;
  function normaliseView(v) {
    if (!v || typeof v !== "object") throw Error("A BOM view must be an object.");
    const name = clean(v.name).slice(0, 80);
    if (!name) throw Error("Give the view a name.");
    const out = {name};
    const columns = strs(v.columns); if (columns?.length) out.columns = columns;
    const order = strs(v.order, 400); if (order?.length) out.order = order;
    const groupBy = strs(v.groupBy, 16); if (groupBy) out.groupBy = groupBy;
    const sort = sortList(v.sort).slice(0, 4); if (sort.length) out.sort = sort;
    if (v.widths && typeof v.widths === "object") {
      out.widths = {};
      for (const [k, w] of Object.entries(v.widths)) if (k.length <= 300 && Number.isFinite(w)) out.widths[k] = Math.max(32, Math.min(1200, Math.round(w)));
    }
    if (Number.isInteger(v.pinned) && v.pinned >= 0) out.pinned = Math.min(v.pinned, 8);
    if (v.filters && typeof v.filters === "object") {
      out.filters = {};
      for (const [k, f] of Object.entries(v.filters)) if (k.length <= 300 && typeof f === "string" && f.trim()) out.filters[k] = f.slice(0, 200);
    }
    if (typeof v.query === "string" && v.query.trim()) out.query = v.query.slice(0, 200);
    if (typeof v.showDnp === "boolean") out.showDnp = v.showDnp;
    if (v.source === "pcb" || v.source === "schematic") out.source = v.source;
    if (typeof v.variant === "string" && v.variant.length <= 300) out.variant = v.variant; // variant id; "" is the base design
    // Forward compatibility: a source and fields a newer Waffle wrote are kept as they are (an unknown
    // source reads as the default here).
    if (typeof v.source === "string" && !out.source && /^[a-z][\w-]{0,31}$/.test(v.source)) out.source = v.source;
    for (const k of Object.keys(v)) if (!VIEW_KEYS.includes(k) && k !== "__proto__") out[k] = JSON.parse(JSON.stringify(v[k] ?? null));
    return out;
  }
  const VIEW_KEYS = ["name", "columns", "order", "groupBy", "sort", "widths", "pinned", "filters", "query", "showDnp", "source", "variant"];
  const views = project => Array.isArray(project?.bomViews) ? project.bomViews.filter(v => v && typeof v === "object" && typeof v.name === "string") : [];
  const findView = (project, name) => views(project).find(v => sameText(v.name, name)) || null;
  function saveView(project, view) {
    const v = normaliseView(view);
    if (!Array.isArray(project.bomViews)) project.bomViews = [];
    const i = project.bomViews.findIndex(x => sameText(x?.name, v.name));
    // Saving over a stored view keeps the fields this build doesn't know (written by a newer Waffle).
    const old = i >= 0 && project.bomViews[i] && typeof project.bomViews[i] === "object" ? project.bomViews[i] : null;
    if (old) for (const k of Object.keys(old)) if (!VIEW_KEYS.includes(k) && !(k in v) && k !== "__proto__") v[k] = old[k];
    if (old && typeof old.source === "string" && !["pcb", "schematic"].includes(old.source) && view.source == null) v.source = old.source;
    if (i >= 0) project.bomViews[i] = v; else project.bomViews.push(v);
    return v;
  }
  function deleteView(project, name) {
    const before = views(project).length;
    if (Array.isArray(project.bomViews)) project.bomViews = project.bomViews.filter(v => !sameText(v?.name, name));
    if (Array.isArray(project.bomViews) && !project.bomViews.length) delete project.bomViews;
    return before !== views(project).length;
  }
  // Settings for a report: the named view (settings.view), then explicit settings.
  function viewSettings(project, settings = {}) {
    const name = settings.view;
    if (name == null || name === "") return settings;
    const v = typeof name === "object" ? normaliseView(name) : findView(project, name);
    if (!v) throw Error("There is no BOM view called " + name + ". Views: " + (views(project).map(x => x.name).join(", ") || "none") + ".");
    const out = {...v};
    for (const [k, x] of Object.entries(settings)) if (x !== undefined && k !== "view") out[k] = x;
    return out;
  }

  // ---------------------------------------------------------------- editing
  const editableKey = key => key.startsWith("p:") || builtins.some(c => c.key === key && c.editable);
  const own = (o, k) => o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  function paramSpelling(item, def, key) {
    const test = key.startsWith("p:") ? k => paramKey(k) === key.slice(2) : key === "description" ? k => paramKey(k) === "DESCRIPTION" : k => FIELD_KEYS[key].test(paramKey(k));
    for (const src of [item?.parameters, def?.parameters]) if (src && typeof src === "object") for (const k of Object.keys(src)) if (test(k)) return k;
    return null;
  }
  // Changes that set column `key` to `text` on every part (and its board copy).
  function planEdit(parts, key, text) {
    if (!editableKey(key)) throw Error("This column can't be edited.");
    const value = clean(text), out = [];
    const set = (target, path, after) => {
      const [k, sub] = path;
      const has = sub == null ? own(target.item, k) : own(target.item.parameters, sub);
      const before = has ? (sub == null ? target.item[k] : target.item.parameters[sub]) : undefined;
      if (before === after || (before === undefined && after === "" && sub != null)) return;
      out.push({doc: target.docId, id: target.item.id, ref: target.ref, path, before, after});
    };
    for (const e of parts) {
      const targets = [e, ...(e.mate ? [e.mate] : [])];
      if (key === "comment") { for (const t of targets) if (clean(t.item.value) !== value) set(t, ["value"], value); continue; }
      if (key === "dnp") {
        const on = value !== "" && !falsy(value) && !/^fitted$/i.test(value);
        for (const t of targets) set(t, ["dnp"], on);
        continue;
      }
      const label = key.startsWith("p:") ? titleCase(key.slice(2)) : FIELD_LABEL[key];
      const spelling = paramSpelling(e.item, e.def, key) || label;
      set(e, ["parameters", spelling], value);
      if (e.mate) { const m = paramSpelling(e.mate.item, null, key); if (m) set(e.mate, ["parameters", m], value); }
    }
    return out;
  }
  // Apply planned changes; refuses everything if any part changed meanwhile.
  function applyChanges(project, changes) {
    const items = new Map(), docs = new Set(changes.map(c => c.doc));
    for (const d of project.documents) if (docs.has(d.id)) for (const i of d.items) items.set(d.id + "\u0001" + i.id, i);
    const plan = changes.map(c => {
      const item = items.get(c.doc + "\u0001" + c.id);
      if (!item) throw Error(c.ref + " is no longer in the design.");
      const [k, sub] = c.path;
      const cur = sub == null ? (own(item, k) ? item[k] : undefined) : (own(item.parameters, sub) ? item.parameters[sub] : undefined);
      if (cur !== c.before) throw Error(c.ref + " changed. Reopen the bill of materials.");
      return [item, c];
    });
    for (const [item, c] of plan) {
      const [k, sub] = c.path;
      if (sub == null) item[k] = c.after;
      else { if (!item.parameters || typeof item.parameters !== "object") item.parameters = {}; item.parameters[sub] = c.after; }
    }
    return plan.length;
  }
  // Tab-separated text for the clipboard (Excel-compatible quoting).
  function tsv(matrix) {
    return matrix.map(row => row.map(v => {
      let s = String(v ?? "");
      // Pasting into a spreadsheet must never create a formula.
      if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(s)) s = "'" + s;
      return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join("\t")).join("\n");
  }

  // ------------------------------------------------------------------ report
  const pad2 = n => String(n).padStart(2, "0");
  const isoDate = d => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  function report(project, settings = {}, collected, matches) {
    settings = viewSettings(project, settings);
    collected = collected || collect(project, settings);
    const all = columns(collected), byKey = new Map(all.map(c => [c.key, c]));
    const visible = (settings.columns ?? defaultColumns).map(k => byKey.get(k)).filter(Boolean);
    const rows = filterRows(build(collected, settings), settings, visible.map(c => c.key), matches);
    const now = settings.now ? new Date(settings.now) : new Date();
    const source = collected.source === "pcb" ? "Board · " + (collected.board?.name || "") :
      "Schematic · " + collected.sheets.length + " sheet" + (collected.sheets.length === 1 ? "" : "s");
    return {
      title: "Bill of Materials", project: clean(project.name) || "Untitled", source, view: typeof settings.view === "string" ? settings.view : settings.name,
      ...(collected.variant ? {variant: collected.variant.name} : {}),
      date: settings.date || isoDate(now), created: settings.created || now.toISOString().replace(/\.\d+Z$/, "Z"),
      totalParts: collected.parts.length, lineCount: rows.length, excluded: collected.excluded.length,
      titleBlock: settings.titleBlock !== false,
      columns: visible.map(c => ({key: c.key, label: c.label, numeric: c.numeric})),
      rows: rows.map(r => visible.map(c => r.values[c.key] ?? ""))
    };
  }
  function meta(r) {
    return [["Project", r.project], ["Source", r.source], ...(r.variant ? [["Variant", r.variant]] : []), ["Date", r.date], ["Total parts", r.totalParts], ["Excluded", r.excluded]];
  }

  // --------------------------------------------------------------------- CSV
  function csvCell(value, guard = true) {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    let s = String(value ?? "");
    // Keep spreadsheet applications from evaluating text as a formula.
    if (guard && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(r, options = {}) {
    const lines = [];
    const line = cells => lines.push(cells.map(c => csvCell(c, options.guard !== false)).join(","));
    if (r.titleBlock) { line([r.title]); for (const m of meta(r)) line(m); line([]); }
    line(r.columns.map(c => c.label));
    for (const row of r.rows) line(row);
    return (options.bom === false ? "" : "﻿") + lines.join("\r\n") + "\r\n";
  }

  // -------------------------------------------------------------------- XLSX
  function xml(s) {
    return String(s ?? "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, "$1")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function colName(n) { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
  const SHEET = "Bill of Materials";
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  function xlsxFiles(r) {
    // Styles: 0 normal, 1 header (bold, rule below), 2 title, 3 bold label.
    const rows = [], width = r.columns.map(c => Math.max(6, c.label.length));
    let y = 0, measure = false;
    function cell(x, value, style) {
      const ref = colName(x) + y, s = style ? ' s="' + style + '"' : "";
      if (typeof value === "number" && Number.isFinite(value)) return '<c r="' + ref + '"' + s + "><v>" + value + "</v></c>";
      const text = String(value ?? "").slice(0, 32767);
      if (!text && !style) return "";
      if (measure && x < width.length) width[x] = Math.max(width[x], Math.min(60, text.length));
      return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xml(text) + "</t></is></c>";
    }
    const row = (cells, style, labelStyle) => { y++; rows.push('<row r="' + y + '">' + cells.map((v, x) => cell(x, v, x === 0 && labelStyle ? labelStyle : style)).join("") + "</row>"); };
    if (r.titleBlock) {
      row([r.title], 2);
      for (const m of meta(r)) { row(m, 0, 3); if (width.length) width[0] = Math.max(width[0], m[0].length); }
      y++;
    }
    measure = true;
    row(r.columns.map(c => c.label), 1);
    const headerRow = y;
    for (const values of r.rows) row(values, 0);
    const last = colName(Math.max(0, r.columns.length - 1)), lastRow = Math.max(y, headerRow);
    const range = "$A$" + headerRow + ":$" + last + "$" + lastRow;
    const quoted = "'" + SHEET.replace(/'/g, "''") + "'";
    const sheet = head + '<worksheet xmlns="' + NS + '" xmlns:r="' + REL + '">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<dimension ref="A1:' + last + lastRow + '"/>' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + headerRow + '" topLeftCell="A' + (headerRow + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      (r.columns.length ? "<cols>" + width.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (w + 2) + '" customWidth="1"/>').join("") + "</cols>" : "") +
      "<sheetData>" + rows.join("") + "</sheetData>" +
      (r.columns.length ? '<autoFilter ref="A' + headerRow + ":" + last + lastRow + '"/>' : "") +
      '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
      '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      "</worksheet>";
    const workbook = head + '<workbook xmlns="' + NS + '" xmlns:r="' + REL + '">' +
      '<bookViews><workbookView/></bookViews><sheets><sheet name="' + xml(SHEET) + '" sheetId="1" r:id="rId1"/></sheets>' +
      (r.columns.length ? "<definedNames>" +
        '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' + xml(quoted + "!" + range) + "</definedName>" +
        '<definedName name="_xlnm.Print_Titles" localSheetId="0">' + xml(quoted + "!$" + headerRow + ":$" + headerRow) + "</definedName>" +
        "</definedNames>" : "") + "</workbook>";
    const font = (extra, size) => "<font>" + extra + '<sz val="' + size + '"/><name val="Calibri"/><family val="2"/></font>';
    const styles = head + '<styleSheet xmlns="' + NS + '">' +
      '<fonts count="3">' + font("", 11) + font("<b/>", 11) + font("<b/>", 14) + "</fonts>" +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    const core = head + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      "<dc:title>" + xml(r.project + " · " + r.title) + "</dc:title><dc:creator>Waffle</dc:creator>" +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + xml(r.created) + "</dcterms:created></cp:coreProperties>";
    const types = head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    const rels = head + '<Relationships xmlns="' + PKG + '">' +
      '<Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
    const bookRels = head + '<Relationships xmlns="' + PKG + '">' +
      '<Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="' + REL + '/styles" Target="styles.xml"/></Relationships>';
    return [
      {name: "[Content_Types].xml", data: types}, {name: "_rels/.rels", data: rels},
      {name: "docProps/core.xml", data: core}, {name: "xl/workbook.xml", data: workbook},
      {name: "xl/_rels/workbook.xml.rels", data: bookRels}, {name: "xl/styles.xml", data: styles},
      {name: "xl/worksheets/sheet1.xml", data: sheet}
    ];
  }
  function xlsx(r) {
    if (!globalThis.AtriumZip?.create) throw Error("Excel export is unavailable in this build.");
    const date = new Date(r.created);
    return AtriumZip.create(xlsxFiles(r), Number.isFinite(date.getTime()) ? {date} : {});
  }

  // -------------------------------------------------------------------- HTML
  function html(r) {
    const e = s => xml(s);
    const cls = c => c.numeric ? ' class="num"' : "";
    return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>" + e(r.project + " · " + r.title) + "</title>\n" +
      "<style>:root{color-scheme:light}body{font:12px/1.4 -apple-system,system-ui,\"Segoe UI\",sans-serif;color:#1d2321;margin:24px}" +
      "h1{font-size:18px;margin:0 0 6px}dl{display:grid;grid-template-columns:max-content auto;gap:2px 14px;margin:0 0 16px;color:#4b5552}" +
      "dt{font-weight:600}dd{margin:0}table{border-collapse:collapse;width:100%}th,td{border:1px solid #c8cfcc;padding:3px 6px;text-align:left;vertical-align:top}" +
      "th{background:#eceff0;font-weight:600}tbody tr:nth-child(even){background:#f7f8f8}.num{text-align:right;font-variant-numeric:tabular-nums}" +
      "@page{size:landscape;margin:12mm}@media print{body{margin:0}thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body>\n" +
      "<h1>" + e(r.title) + "</h1>\n" +
      (r.titleBlock ? "<dl>" + meta(r).map(([k, v]) => "<dt>" + e(k) + "</dt><dd>" + e(v) + "</dd>").join("") + "</dl>\n" : "") +
      "<table><thead><tr>" + r.columns.map(c => "<th" + cls(c) + ">" + e(c.label) + "</th>").join("") + "</tr></thead>\n<tbody>\n" +
      r.rows.map(row => "<tr>" + row.map((v, i) => "<td" + cls(r.columns[i]) + ">" + e(v) + "</td>").join("") + "</tr>").join("\n") +
      "\n</tbody></table>\n</body></html>\n";
  }

  // The report for printing (print-report.js): title, project · variant · date, the title block, one table.
  function printable(r, base = r.project) {
    return {title: r.title, name: fileName(base, "pdf"),
      subtitle: [r.project, r.variant ? "Variant " + r.variant : "", r.view ? "View " + r.view : "", r.date].filter(Boolean).join(" · "),
      meta: r.titleBlock ? meta(r).filter(([k]) => k !== "Project" && k !== "Date" && k !== "Variant") : [],
      sections: [{columns: r.columns.map(c => ({label: c.label, numeric: !!c.numeric})), rows: r.rows, empty: "No lines."}]};
  }
  function fileName(project, ext) {
    return (clean(project).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "Project") + "-BOM." + ext;
  }

  // ---------------------------------------------------------------------- UI
  // An ActiveBOM-style editor: a virtualised grid (only visible rows exist in
  // the DOM, one delegated listener per event type), draggable and resizable
  // columns, multi-key sort, grouping with expandable lines, per-column
  // filters, inline editing as single undo steps, a solutions pane and named
  // views stored in the project.
  const STORE = "atrium-bom-v1";
  function loadPrefs() {
    try { const v = JSON.parse(globalThis.localStorage?.getItem(STORE) || "null"); return v && typeof v === "object" ? v : {}; }
    catch { return {}; }
  }
  function savePrefs(v) { try { globalThis.localStorage?.setItem(STORE, JSON.stringify(v)); } catch {} }
  const DEFAULT_WIDTH = {line: 54, status: 110, comment: 150, description: 220, designator: 170, footprint: 150, libref: 120, quantity: 72,
    manufacturer: 130, mpn: 180, supplier: 110, supplierPn: 140, stock: 80, price: 80, lifecycle: 90, dnp: 56, document: 150};
  const SEVERE = new Set(["duplicate", "out-of-stock", "obsolete", "eol"]);
  const DNP_HELP = "DNP means do not populate: the part stays in the design but is not fitted on the assembled board, so it is left out of the lines. " +
    "Mark parts in the DNP column, with a DNP parameter, or as Not Fitted in a variant.";
  const PANEL_MIN = 200, PANEL_MAX = 520;
  // Lines up to this many render at once, so scrolling never touches the DOM; longer lists render a
  // window of rows with a screenful of slack each side, replaced only when the view leaves it.
  const RENDER_ALL = 150;
  // Inline optimiser hints in the Lines grid.
  const T = globalThis.AtriumI18n?.define?.({
    "bom.hint.optimise": "Optimise…",
    "bom.hint.optimise_label": "Optimise… · {suggestions}",
    "bom.hint.chip": "{suggestions} · −{lines}",
    "bom.hint.chip_label": "Show only lines with suggestions",
    "bom.hint.mark_label": "{suggestions}. {key} opens them.",
    "bom.hint.region": "Suggestions for line {line}",
    "bom.hint.apply": "Apply",
    "bom.hint.dismiss": "Dismiss",
    "bom.hint.show": "Show in Optimise",
    "bom.hint.close": "Close suggestions",
    "bom.hint.changes": "Changes",
    "bom.hint.why": "Why",
    "bom.hint.guarantee": "Never lowers a rating: the part kept meets or beats every known voltage, power, tolerance, temperature coefficient and dielectric of the lines it replaces.",
    "bom.hint.guarantee_notation": "The same part written one way: nothing about the part changes.",
    "bom.hint.advice": "Advice only: Waffle never changes a value or a footprint for you.",
    "bom.hint.applied": "Applied “{title}” to {parts}. Undo reverts it in one step.",
    "bom.hint.dismissed": "Hint dismissed for this project. Columns › Hints shows it again.",
    "bom.hint.heading": "Hints",
    "bom.hint.setting": "Show optimiser hints in the lines",
    "bom.hint.restore_all": "Show dismissed hints again ({count})",
    "bom.hint.hidden": "Hidden in Lines",
    "bom.hint.restore": "Show again",
    "bom.hint.detail": "{suggestions} · {key} opens them",
    "bom.hint.keys": "{key} or {escape} closes",
    "bom.hint.kind_merge": "Merge",
    "bom.hint.kind_package": "Package",
    "bom.hint.kind_cover": "Near-duplicates",
    "bom.hint.kind_series": "E-series",
    "bom.hint.kind_bias": "DC bias",
    "bom.hint.kind_power": "Power"
  }) || ((k, p) => k + (p ? " " + Object.values(p).join(" ") : ""));
  const HINT_KIND = {merge: () => T("bom.hint.kind_merge"), package: () => T("bom.hint.kind_package"), cover: () => T("bom.hint.kind_cover"),
    series: () => T("bom.hint.kind_series"), bias: () => T("bom.hint.kind_bias"), power: () => T("bom.hint.kind_power")};
  const hintSeverity = hs => hs.some(h => h.severity === "error") ? "error" : hs.some(h => h.severity === "warning") ? "warning" : "info";

  function open(ctx) {
    const project = ctx.project;
    const live = () => ctx.currentProject?.() || project;
    const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
    const button = (text, fn, cls) => {
      const b = el("button", text, cls); b.type = "button";
      b.classList.add("ui-button");
      if (cls === "bom-hint-apply") b.dataset.variant = "primary";
      b.onclick = fn;
      return b;
    };
    // A designator chip (the library chip): locates its part; it is a token, not a button face.
    const chip = (text, fn) => { const b = el("button", text, "ui-chip bom-chip"); b.type = "button"; b.onclick = fn; return b; };
    const small = (text, fn) => { const b = button(text, fn); b.dataset.size = "sm"; return b; };
    const count = (n, one, many = one + "s") => globalThis.AtriumI18n?.plural?.(n, one, many) ?? n + " " + (n === 1 ? one : many);
    const prefs = loadPrefs();
    const boards = project.documents.filter(d => d.kind === "pcb");
    const O = globalThis.AtriumBOMOptimiser;
    const personal = {
      columns: Array.isArray(prefs.columns) ? prefs.columns : gridDefaults(project),
      order: Array.isArray(prefs.order) ? prefs.order : null,
      groupBy: Array.isArray(prefs.groupBy) ? prefs.groupBy : defaultGroups.slice(),
      sort: sortList(prefs.sort).length ? sortList(prefs.sort) : [{key: "designator", dir: 1}],
      widths: prefs.widths && typeof prefs.widths === "object" ? prefs.widths : {},
      pinned: Number.isInteger(prefs.pinned) ? prefs.pinned : 2, filters: {}, query: "", showDnp: !!prefs.showDnp
    };
    const state = {
      tab: prefs.tab === "optimise" && O ? "optimise" : "lines", viewName: findView(project, prefs.viewName) ? prefs.viewName : "",
      source: prefs.source === "pcb" || prefs.source === "schematic" ? prefs.source : null,
      board: ctx.doc?.kind === "pcb" ? ctx.doc.id : globalThis.Atrium?.preferredDocument?.(project, "pcb", ctx.doc?.id)?.id,
      ...personal, format: ["csv", "xlsx", "html"].includes(prefs.format) ? prefs.format : "csv",
      titleBlock: prefs.titleBlock !== false, expanded: new Set(), active: {r: 0, c: 0}, anchor: null, solutions: new Map(), offers: new Map(),
      hints: prefs.hints !== false, hintsOnly: false, strip: null,
      panelOpen: prefs.panelOpen !== false, panelWidth: Number.isFinite(prefs.panelWidth) ? Math.max(PANEL_MIN, Math.min(PANEL_MAX, prefs.panelWidth)) : 272
    };
    if (state.viewName) Object.assign(state, viewState(findView(project, state.viewName)));
    let collected, all, rows = [], shown = [], flat = [], cols = [], rowH = 24, editor = null, optView = null, designFilter;
    // Hints: the analysis behind them (shared with the Optimise tab), its key, the hints per grid line,
    // the flat index of the line whose hint strip is open and that strip's measured height.
    let hintAnalysis = null, hintKey = "", hintData = null, lineHints = new Map(), stripAt = -1, stripH = 72, hintTimer = 0, hintIdle = 0, optStale = false;
    const projectKey = () => (typeof globalThis.AtriumHost?.projectPath === "string" && globalThis.AtriumHost.projectPath) || clean(live().name) || "untitled";
    const dismissed = O?.dismissals ? O.dismissals(projectKey()) : null;
    const keymap = globalThis.AtriumKeymap;
    const stripBinding = "Mod+.", stripKeySpoken = keymap?.display(stripBinding, true) || "Control+Period";
    const leadW = () => state.hints && O?.hints ? 42 : 28;
    function viewState(v) {
      return {columns: v.columns || defaultColumns.slice(), order: v.order || null, groupBy: v.groupBy || defaultGroups.slice(),
        sort: v.sort?.length ? v.sort : [{key: "designator", dir: 1}], widths: {...(v.widths || {})}, pinned: v.pinned ?? 2,
        filters: {...(v.filters || {})}, query: v.query || "", showDnp: !!v.showDnp, ...(v.source ? {source: v.source} : {}), ...(typeof v.variant === "string" ? {variant: v.variant} : {})};
    }
    const remember = () => {
      const keep = {source: state.source, format: state.format, titleBlock: state.titleBlock, tab: state.tab, viewName: state.viewName, hints: state.hints,
        panelOpen: state.panelOpen, panelWidth: state.panelWidth};
      if (!state.viewName) Object.assign(keep, {columns: state.columns, order: state.order, groupBy: state.groupBy, sort: state.sort,
        widths: state.widths, pinned: state.pinned, showDnp: state.showDnp});
      else Object.assign(keep, {columns: prefs.columns, order: prefs.order, groupBy: prefs.groupBy, sort: prefs.sort, widths: prefs.widths, pinned: prefs.pinned, showDnp: prefs.showDnp});
      Object.assign(prefs, keep); savePrefs(prefs);
    };

    // ------------------------------------------------------------ skeleton
    const d = el("dialog", null, "work-dialog ui-dialog bom-dialog"); d.dataset.grid = "";
    d.setAttribute("aria-labelledby", "bom-heading");
    const heading = el("h2", "Bill of Materials", "ui-sheet-title"); heading.id = "bom-heading";
    const summary = el("p", null, "bom-summary"); summary.setAttribute("role", "status");
    const hintChip = el("button", "", "ui-chip bom-hint-chip"); hintChip.type = "button";
    hintChip.onclick = () => { state.hintsOnly = !state.hintsOnly; if (state.tab !== "lines") showTab("lines"); refilter(); paintSummary(); paintHintUI(); };
    hintChip.hidden = true; hintChip.setAttribute("aria-pressed", "false");
    const titleRow = el("div", null, "bom-title-row"); titleRow.append(heading, hintChip);
    const titleBox = el("div"); titleBox.append(titleRow, summary);
    const tabs = el("div", null, "bom-tabs ui-tabs"); tabs.dataset.boxed = ""; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Bill of Materials views");
    const tabLines = button("Lines", () => showTab("lines")), tabOpt = button("Optimise", () => showTab("optimise"));
    for (const t of [tabLines, tabOpt]) { t.setAttribute("role", "tab"); t.className = "bom-tab ui-tab"; }
    tabLines.id = "bom-tab-lines"; tabOpt.id = "bom-tab-optimise";
    tabLines.setAttribute("aria-controls", "bom-lines");
    tabs.append(tabLines); if (O) tabs.append(tabOpt);
    const top = el("header", null, "bom-head"); top.append(titleBox, tabs);

    const sourceSelect = el("select", null, "ui-field"); sourceSelect.setAttribute("aria-label", "BOM source");
    const viewSelect = el("select", null, "ui-field"); viewSelect.setAttribute("aria-label", "BOM view");
    const variantSelect = el("select", null, "ui-field"); variantSelect.setAttribute("aria-label", "Assembly variant");
    const search = el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Search"; search.setAttribute("aria-label", "Search BOM lines"); search.value = state.query;
    // DNP (do not populate): parts kept in the design but left off the assembled board, from a DNP
    // parameter, the DNP column or a variant that marks them Not Fitted (Altium's model). They never
    // count in a line; this toggle lists them, struck through, in lines of their own.
    const dnpCheck = el("input", null, "ui-checkbox"); dnpCheck.type = "checkbox"; dnpCheck.id = "bom-show-dnp";
    dnpCheck.setAttribute("aria-describedby", "bom-dnp-help");
    dnpCheck.onchange = () => { state.showDnp = dnpCheck.checked; regroup(); };
    const dnpCount = el("span", null, "bom-count");
    const dnpToggle = el("label", null, "bom-check bom-dnp-toggle");
    dnpToggle.append(dnpCheck, el("span", "Show DNP parts"), dnpCount);
    dnpToggle.title = DNP_HELP;
    const dnpHelp = el("span", DNP_HELP, "bom-sr"); dnpHelp.id = "bom-dnp-help";
    const field_ = (label, control) => { const l = el("label", null, "bom-field"); l.append(el("span", label), control); return l; };
    const tools = el("div", null, "bom-toolbar");
    const variantField = field_("Variant", variantSelect);
    // The optimiser's entry point; the Optimise tab stays reachable from the tab list too.
    const optButton = button("", () => showTab("optimise"), "bom-opt-button");
    const optLabel = el("span", T("bom.hint.optimise")), optCount = el("span", null, "bom-opt-count");
    optButton.append(optLabel, optCount); optButton.hidden = !O;
    tools.append(field_("Source", sourceSelect), variantField, field_("View", viewSelect), AtriumUI.searchField(search), dnpToggle, dnpHelp, optButton);

    const table = el("table", null, "bom-grid"), colgroup = el("colgroup"), thead = el("thead"), tbody = el("tbody");
    table.append(colgroup, thead, tbody); table.setAttribute("role", "grid"); table.setAttribute("aria-label", "Bill of materials lines");
    const gridWrap = el("div", null, "bom-grid-wrap"); gridWrap.tabIndex = 0; gridWrap.append(table);
    // Columns: a collapsible side panel (like ActiveBOM's Properties › Columns). Its open state and
    // width are remembered; the edge drags to resize and the chevron (or the slim rail) hides it.
    const panel = el("aside", null, "ui-drawer bom-columns"); panel.id = "bom-columns"; panel.setAttribute("aria-label", "Columns");
    const panelBody = el("div", null, "bom-panel-body"); panelBody.id = "bom-columns-body";
    const panelTitle = el("strong", "Columns", "bom-panel-title");
    const panelFold = button("", () => setPanel(!state.panelOpen), "bom-panel-fold");
    panelFold.setAttribute("aria-controls", panelBody.id);
    const panelHead = el("div", null, "bom-panel-head"); panelHead.append(panelTitle, panelFold);
    const panelEdge = el("div", null, "bom-panel-edge"); panelEdge.setAttribute("role", "separator"); panelEdge.setAttribute("aria-orientation", "vertical");
    panelEdge.setAttribute("aria-label", "Columns panel width"); panelEdge.tabIndex = 0;
    panelEdge.setAttribute("aria-valuemin", String(PANEL_MIN)); panelEdge.setAttribute("aria-valuemax", String(PANEL_MAX));
    panel.append(panelEdge, panelHead, panelBody);
    function setPanel(open, width = state.panelWidth) {
      state.panelOpen = open; state.panelWidth = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(width)));
      panel.classList.toggle("collapsed", !open);
      panelBody.hidden = !open; panelEdge.hidden = !open;
      panel.style.width = open ? state.panelWidth + "px" : "";
      panelFold.setAttribute("aria-expanded", String(open));
      panelFold.setAttribute("aria-label", open ? "Hide columns panel" : "Show columns panel");
      panelFold.title = open ? "Hide columns" : "Show columns";
      panelEdge.setAttribute("aria-valuenow", String(state.panelWidth));
      remember(); syncScrollMode();
    }
    panelEdge.onpointerdown = e => {
      if (e.button) return;
      e.preventDefault();
      const x0 = e.clientX, w0 = state.panelWidth;
      panelEdge.setPointerCapture?.(e.pointerId); panelEdge.classList.add("is-dragging");
      const move = ev => { state.panelWidth = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(w0 - (ev.clientX - x0)))); panel.style.width = state.panelWidth + "px"; };
      const up = () => { panelEdge.removeEventListener("pointermove", move); panelEdge.removeEventListener("pointerup", up); panelEdge.removeEventListener("pointercancel", up);
        panelEdge.classList.remove("is-dragging"); setPanel(true); };
      panelEdge.addEventListener("pointermove", move); panelEdge.addEventListener("pointerup", up); panelEdge.addEventListener("pointercancel", up);
    };
    panelEdge.onkeydown = e => {
      const d = {ArrowLeft: 16, ArrowRight: -16}[e.key];
      if (d) { e.preventDefault(); setPanel(true, state.panelWidth + d); }
    };
    // The collapsed rail is the handle: a press anywhere on it opens the panel.
    panel.addEventListener("click", e => { if (!state.panelOpen && !e.target.closest(".bom-panel-fold")) setPanel(true); });
    const body = el("div", null, "bom-body"); body.id = "bom-lines";
    body.setAttribute("role", "tabpanel"); body.setAttribute("aria-labelledby", tabLines.id); body.append(gridWrap, panel);
    const detail = el("div", null, "bom-detail");
    const notes = el("div", null, "bom-notes");

    const format = el("select", null, "ui-field"); format.setAttribute("aria-label", "Export format");
    format.add(new Option("CSV (.csv)", "csv"));
    format.add(new Option("Excel workbook (.xlsx)", "xlsx"));
    format.add(new Option("Web page (.html)", "html"));
    const binary = typeof ctx.exportBytes === "function" || !globalThis.AtriumHost;
    if (!globalThis.AtriumZip?.create || !binary) {
      format.options[1].disabled = true;
      format.options[1].textContent += globalThis.AtriumZip?.create ? " · not available in this app" : " · unavailable";
      if (state.format === "xlsx") state.format = "csv";
    }
    format.value = state.format;
    const titleCheck = el("input", null, "ui-checkbox"); titleCheck.type = "checkbox"; titleCheck.checked = state.titleBlock;
    const titleLabel = el("label", null, "bom-check"); titleLabel.append(titleCheck, el("span", "Title block"));
    const status = el("span", null, "bom-status"); status.setAttribute("role", "status");
    // Print… and Export PDF… open the shared report dialog (print-report.js): paper, orientation and
    // a preview, then the system print panel. Mod+P while the BOM is open does the same.
    const print = button("Print…", () => printReport("print")), pdfButton = button("Export PDF…", () => printReport("pdf"));
    const exporter = button("Export", exportNow);
    exporter.dataset.variant = "primary"; exporter.dataset.uiDefault = "false";
    const foot = el("div", null, "work-actions ui-dialog-actions bom-actions");
    foot.append(status, titleLabel, format, print, pdfButton, button("Close", () => d.close()), exporter);
    d.dataset.printTarget = "";
    d.addEventListener("atrium-print", e => { e.stopPropagation(); printReport(e.detail?.mode === "pdf" ? "pdf" : "print"); });
    d.append(top, tools, body, detail, notes, foot);

    function settings() {
      return {source: state.source, board: state.board, columns: state.columns, groupBy: state.groupBy, sort: state.sort, titleBlock: state.titleBlock,
        filters: state.filters, query: state.query, showDnp: state.showDnp, solutions: state.solutions, view: undefined, name: state.viewName || undefined,
        variant: state.variant};
    }
    async function currentReport() {
      if (state.tab === "optimise" && optView) return optView.report({titleBlock:state.titleBlock});
      const source = collected, options = settings(), request = designMatches();
      const matches = await request?.promise;
      if (source !== collected || request && !request.current()) throw Error("The bill of materials changed. Try again.");
      return report(project,options,source,matches);
    }
    async function exportNow() {
      status.textContent = "";
      try {
        const r = await currentReport(), base = state.tab === "optimise" ? project.name + "-optimised" : project.name;
        let saved;
        if (state.format === "xlsx") {
          const bytes = xlsx(r), name = fileName(base, "xlsx");
          saved = typeof ctx.exportBytes === "function" ? await ctx.exportBytes(name, bytes) : await ctx.exportFile(name, bytes);
          if (saved) ctx.info?.("Exported " + name);
        } else {
          const name = fileName(base, state.format);
          saved = await ctx.exportFile(name, state.format === "csv" ? csv(r) : html(r));
          if (saved) ctx.info?.("Exported " + name);
        }
        if (saved) status.textContent = "Exported " + count(r.lineCount, "line") + ".";
      } catch (e) { status.textContent = e.message || String(e); }
    }
    async function printReport(mode) {
      status.textContent = "";
      try {
        const R = globalThis.AtriumPrintReport || await globalThis.AtriumLazy?.need("AtriumPrintReport");
        if (!R) throw Error("Printing is unavailable in this build.");
        if (!d.open) return;
        const base = state.tab === "optimise" ? project.name + "-optimised" : project.name;
        R.open(ctx, {mode, title: "Bill of Materials", report: async () => printable(await currentReport(), base)});
      } catch (e) { status.textContent = e.message || String(e); }
    }

    // --------------------------------------------------------------- data
    function sources() {
      sourceSelect.replaceChildren();
      const sheets = project.documents.filter(x => x.kind === "schematic");
      if (sheets.length) sourceSelect.add(new Option("Schematic · " + count(sheets.length, "sheet"), "schematic"));
      for (const b of boards) sourceSelect.add(new Option("Board · " + b.name, "pcb:" + b.id));
    }
    // Variants: the active one by default; "" is the base design.
    function paintVariants() {
      const V = globalThis.AtriumVariants, list = V ? V.list(live()) : [];
      variantField.hidden = !list.length;
      variantSelect.replaceChildren(new Option("Base design", ""), ...list.map(v => new Option(v.name, v.id)));
      if (state.variant === undefined || state.variant && !list.some(v => v.id === state.variant)) state.variant = V?.find(live(), live().activeVariant)?.id || "";
      variantSelect.value = state.variant;
    }
    function paintViews() {
      viewSelect.replaceChildren(new Option("My layout", ""));
      for (const v of views(live())) viewSelect.add(new Option(v.name, v.name));
      viewSelect.value = state.viewName;
    }
    function recollect() {
      collected = collect(live(), {source: state.source, board: state.board, variant: state.variant});
      state.source = collected.source; state.board = collected.board?.id;
      sourceSelect.value = collected.source === "pcb" ? "pcb:" + state.board : "schematic";
      all = columns(collected);
      const keys = all.map(c => c.key);
      state.order = [...(state.order || []).filter(k => keys.includes(k)), ...keys.filter(k => !(state.order || []).includes(k))];
      state.columns = state.columns.filter(k => keys.includes(k));
      if (!state.columns.length) state.columns = defaultColumns.slice();
      regroup();
      if (optView) { if (state.tab === "optimise") { optView.update(collected, analysisNow()); optStale = false; } else optStale = true; }
      scheduleHints();
    }
    function regroup() {
      state.columns = state.order.filter(k => state.columns.includes(k));
      const keep = flat[state.active.r]?.row.parts[0]?.id;
      rows = build(collected, settings());
      lineHints = state.hints && hintData ? rowHints(rows, hintData) : new Map();
      cols = state.columns.map(k => all.find(c => c.key === k)).filter(Boolean);
      refilter(keep);
      paintHead(); paintPanel(); paintNotes(); paintSummary(); paintHintUI(); remember();
      dnpCheck.checked = state.showDnp;
      const dnp = collected.dnp?.length || 0;
      dnpCount.textContent = dnp ? String(dnp) : ""; dnpCount.hidden = !dnp;
    }
    function designMatches() {
      const labs = globalThis.AtriumLabs, source = state.query;
      if (!labs?.designQueryIntent(source)) {
        designFilter?.controller.abort();
        designFilter = null;
        return null;
      }
      if (designFilter?.current()) return designFilter;
      designFilter?.controller.abort();
      const controller = new AbortController(), {signal} = controller, base = live(), snapshot = collected, revision = ctx.revision?.();
      const current = () => !signal.aborted && d.open && live() === base && collected === snapshot &&
        ctx.revision?.() === revision && state.query === source && labs.butterEnabled("query");
      const promise = labs.designQueryService(source).then(service => {
        if (!current()) return null;
        return service && queryMatches(service,snapshot,source,{signal,revision,isCurrent:current,enabled:() => labs.butterEnabled("query")});
      });
      return designFilter = {controller,current,promise};
    }
    function refilter(keepId) {
      const request = designMatches();
      if (!request) {
        gridWrap.removeAttribute("aria-busy");
        displayRows(filterRows(rows,state,cols.map(c => c.key)),keepId);
        return;
      }
      gridWrap.setAttribute("aria-busy","true");
      request.promise.then(matches => {
        if (!request.current()) return;
        gridWrap.removeAttribute("aria-busy");
        displayRows(filterRows(rows,state,cols.map(c => c.key),matches),keepId);
        paintSummary();
      }, error => {
        if (!request.current()) return;
        gridWrap.removeAttribute("aria-busy");
        displayRows([],keepId);
        status.textContent = error.message;
        paintSummary();
      });
    }
    function displayRows(filtered,keepId) {
      shown = filtered;
      if (state.hintsOnly && state.hints) shown = shown.filter(r => lineHints.has(r));
      flatten();
      if (keepId) { const i = flat.findIndex(f => f.type === "line" && f.row.parts.some(p => p.id === keepId)); if (i >= 0) state.active.r = i; }
      clamp(); paintRows(); paintDetail();
    }
    const lineKey = row => row.parts[0]?.id || row.first;
    function flatten() {
      flat = [];
      for (const row of shown) {
        flat.push({type: "line", row});
        if (row.parts.length > 1 && state.expanded.has(lineKey(row))) for (const part of row.parts) flat.push({type: "part", row, part});
      }
      locateStrip();
    }
    // The open hint strip sits under its line; the virtualised grid accounts for its height.
    function locateStrip() {
      stripAt = state.strip ? flat.findIndex(f => f.type === "line" && lineKey(f.row) === state.strip) : -1;
      if (stripAt >= 0 && !lineHints.has(flat[stripAt].row)) stripAt = -1;
      if (stripAt < 0) state.strip = null;
    }
    const yOf = r => r * rowH + (stripAt >= 0 && r > stripAt ? stripH : 0);
    function rowAt(y) {
      if (stripAt < 0 || y < (stripAt + 1) * rowH) return Math.floor(y / rowH);
      if (y < (stripAt + 1) * rowH + stripH) return stripAt;
      return Math.floor((y - stripH) / rowH);
    }
    function clamp() {
      state.active.r = Math.max(0, Math.min(flat.length - 1, state.active.r));
      state.active.c = Math.max(0, Math.min(cols.length - 1, state.active.c));
      if (state.anchor) { state.anchor.r = Math.min(state.anchor.r, flat.length - 1); state.anchor.c = Math.min(state.anchor.c, cols.length - 1); }
    }
    // The excluded count links to the list of excluded parts (and why), the DNP count to the toggle.
    const excludedLink = button("", () => showExcluded(), "bom-link"), dnpLink = button("", () => {
      if (!state.showDnp) { state.showDnp = true; regroup(); }
      dnpCheck.focus();
    }, "bom-link");
    excludedLink.setAttribute("aria-controls", "bom-excluded"); dnpLink.setAttribute("aria-controls", "bom-show-dnp");
    dnpLink.title = DNP_HELP;
    function paintSummary() {
      const parts = collected.parts.length, dnp = collected.dnp?.length || 0;
      const text = [project.name, (collected.source === "pcb" ? "Board · " + collected.board?.name : "All schematic sheets"),
        ...(collected.variant ? ["Variant " + collected.variant.name] : []),
        count(rows.length, "line") + (shown.length !== rows.length ? " (" + shown.length + " shown)" : ""), count(parts, "part")].join(" · ");
      excludedLink.textContent = count(collected.excluded.length, "excluded part");
      excludedLink.setAttribute("aria-label", excludedLink.textContent + ": show which and why");
      dnpLink.textContent = dnp + " DNP";
      dnpLink.setAttribute("aria-label", dnp + " do not populate: " + (state.showDnp ? "listed in the lines" : "show them in the lines"));
      summary.replaceChildren(text + " · ", excludedLink, ...(dnp ? [" (", dnpLink, ")"] : []));
    }
    function showExcluded() {
      const box = notes.querySelector('details[data-k="excluded"]'); if (!box) return;
      notes.hidden = false; box.open = true;
      box.scrollIntoView?.({block: "nearest"});
      box.querySelector("summary")?.focus({preventScroll: true});
    }
    const cellText = (f, c) => {
      const v = f.type === "part" ? (c.key === "quantity" ? 1 : c.key === "line" ? "" : c.key === "status" ? (f.part.dnp ? "DNP" : "") : field(f.part, c.key, settings())) : f.row.values[c.key];
      return v == null ? "" : typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
    };

    // --------------------------------------------------------------- head
    const widthOf = c => state.widths[c.key] || DEFAULT_WIDTH[c.key] || 140;
    function pinLeft(i) { let x = leadW(); for (let k = 0; k < i; k++) x += widthOf(cols[k]); return x; }
    function paintHead() {
      colgroup.replaceChildren();
      const lead = el("col"); lead.style.width = leadW() + "px"; colgroup.append(lead);
      let total = leadW();
      for (const c of cols) { const col = el("col"); col.style.width = widthOf(c) + "px"; total += widthOf(c); colgroup.append(col); }
      table.style.width = total + "px";
      const tr = el("tr"), fr = el("tr", null, "bom-filter-row");
      const corner = el("th", null, "bom-lead pin"); corner.style.left = "0px"; corner.setAttribute("aria-label", "Status");
      const fcorner = el("th", null, "bom-lead pin"); fcorner.style.left = "0px";
      tr.append(corner); fr.append(fcorner);
      cols.forEach((c, i) => {
        const th = el("th"); th.scope = "col"; th.dataset.key = c.key; th.draggable = true;
        if (c.numeric) th.classList.add("num");
        if (i < state.pinned) { th.classList.add("pin"); th.style.left = pinLeft(i) + "px"; }
        const si = state.sort.findIndex(s => s.key === c.key);
        th.setAttribute("aria-sort", si === 0 ? (state.sort[0].dir < 0 ? "descending" : "ascending") : "none");
        const b = el("button", c.label, "bom-sort"); b.type = "button"; b.dataset.key = c.key; b.tabIndex = -1;
        b.title = (c.key === "dnp" ? "DNP: do not populate (not fitted on the assembled board) · Enter or double-click toggles · " : "") +
          "Sort by " + c.label + " · Shift-click adds a secondary sort · drag to move";
        if (si >= 0) { b.dataset.dir = state.sort[si].dir < 0 ? "▼" : "▲"; if (state.sort.length > 1) b.dataset.rank = String(si + 1); }
        if (state.groupBy.includes(c.key)) { b.classList.add("grouped"); b.title += " · grouped"; }
        const grip = el("span", null, "bom-resize"); grip.dataset.key = c.key; grip.setAttribute("aria-hidden", "true");
        th.append(b, grip); tr.append(th);
        const fth = el("th"); if (i < state.pinned) { fth.classList.add("pin"); fth.style.left = pinLeft(i) + "px"; }
        const input = el("input", null, "bom-filter ui-field"); input.dataset.key = c.key; input.value = state.filters[c.key] || "";
        input.placeholder = "Filter"; input.setAttribute("aria-label", "Filter " + c.label); input.spellcheck = false;
        fth.append(input); fr.append(fth);
      });
      thead.replaceChildren(tr, fr);
      syncScrollMode();
    }
    // Pinned columns stick only while the grid is wider than its view: sticky cells cost a layer
    // each on every scroll, so a grid that fits keeps them static.
    function syncScrollMode() {
      const wide = (parseFloat(table.style.width) || 0) > gridWrap.clientWidth + 1;
      gridWrap.classList.toggle("bom-hscroll", wide);
    }
    thead.onclick = e => {
      const b = e.target.closest(".bom-sort"); if (!b) return;
      const key = b.dataset.key, i = state.sort.findIndex(s => s.key === key);
      if (e.shiftKey) {
        if (i < 0) state.sort = [...state.sort, {key, dir: 1}].slice(0, 4);
        else if (state.sort[i].dir > 0) state.sort[i] = {key, dir: -1};
        else state.sort.splice(i, 1);
        if (!state.sort.length) state.sort = [{key: "designator", dir: 1}];
      } else state.sort = [{key, dir: i === 0 && state.sort[0].dir > 0 ? -1 : 1}];
      regroup();
    };
    let filterTimer = 0;
    thead.oninput = e => {
      const input = e.target.closest(".bom-filter"); if (!input) return;
      if (input.value.trim()) state.filters[input.dataset.key] = input.value; else delete state.filters[input.dataset.key];
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => { refilter(); paintSummary(); }, 90);
    };
    thead.onkeydown = e => { if (e.target.closest(".bom-filter") && (e.key === "ArrowDown" || e.key === "Enter")) { e.preventDefault(); gridWrap.focus(); } };
    // Resizing: drag the grip on a header's right edge.
    thead.onpointerdown = e => {
      const grip = e.target.closest(".bom-resize"); if (!grip) return;
      e.preventDefault(); e.stopPropagation();
      const key = grip.dataset.key, c = cols.find(x => x.key === key), x0 = e.clientX, w0 = widthOf(c);
      const col = colgroup.children[cols.indexOf(c) + 1];
      grip.setPointerCapture?.(e.pointerId);
      const move = ev => { state.widths[key] = Math.max(36, Math.min(900, Math.round(w0 + ev.clientX - x0))); col.style.width = state.widths[key] + "px";
        table.style.width = cols.reduce((n, x) => n + widthOf(x), leadW()) + "px"; };
      const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); paintHead(); paintRows(); remember(); };
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
    };
    // Reordering: drag a header onto another one (also works in the Columns panel).
    let dragKey = null;
    const dropTarget = e => e.target.closest?.("th[data-key], .bom-column[data-key]");
    function onDragStart(e) {
      if (e.target.closest?.(".bom-resize")) { e.preventDefault(); return; }
      const t = dropTarget(e); if (!t) return;
      dragKey = t.dataset.key; e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragKey); } catch {}
    }
    function onDragOver(e) {
      const t = dropTarget(e); if (!dragKey || !t) return;
      e.preventDefault();
      const r = t.getBoundingClientRect(), vertical = t.classList.contains("bom-column");
      const before = vertical ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
      for (const x of d.querySelectorAll(".drop-before,.drop-after")) x.classList.remove("drop-before", "drop-after");
      t.classList.add(before ? "drop-before" : "drop-after");
    }
    function onDrop(e) {
      const t = dropTarget(e); if (!dragKey || !t) return;
      e.preventDefault();
      const after = t.classList.contains("drop-after"), to = t.dataset.key;
      if (to !== dragKey) {
        state.order = state.order.filter(k => k !== dragKey);
        state.order.splice(state.order.indexOf(to) + (after ? 1 : 0), 0, dragKey);
        regroup();
      }
      dragKey = null;
    }
    const onDragEnd = () => { dragKey = null; for (const x of d.querySelectorAll(".drop-before,.drop-after")) x.classList.remove("drop-before", "drop-after"); };
    for (const host of [thead, panel]) { host.ondragstart = onDragStart; host.ondragover = onDragOver; host.ondrop = onDrop; host.ondragend = onDragEnd; }

    // --------------------------------------------------------------- rows
    function range() {
      const a = state.anchor || state.active, b = state.active;
      return {r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c)};
    }
    // hold > 0: a caller paints the rows (and the detail) right after; paints until then are skipped.
    let hold = 0, measured = false, measureFrame = 0, rendered = {first: 0, last: 0};
    function paintRows() {
      if (hold) return;
      const span = cols.length + 1;
      if (!flat.length) {
        rendered = {first: 0, last: 0};
        const tr = el("tr", null, "bom-empty"), td = el("td", rows.length ? "No lines match the search or filters." : "No components to list.");
        td.colSpan = span; tr.append(td); tbody.replaceChildren(tr); return;
      }
      const view = gridWrap.clientHeight || 600, top = gridWrap.scrollTop, slack = Math.ceil(view / rowH);
      const first = flat.length <= RENDER_ALL ? 0 : Math.max(0, rowAt(top) - slack);
      const last = flat.length <= RENDER_ALL ? flat.length : Math.min(flat.length, rowAt(top + view) + 1 + slack);
      rendered = {first, last};
      const frag = document.createDocumentFragment(), sel = range(), lefts = cols.map((c, i) => i < state.pinned ? pinLeft(i) : null);
      const spacer = h => { const tr = el("tr", null, "bom-spacer"); const td = el("td"); td.colSpan = span; td.style.height = h + "px"; tr.append(td); return tr; };
      if (first) frag.append(spacer(yOf(first)));
      const partners = stripPartners();
      for (let r = first; r < last; r++) {
        const f = flat[r], tr = el("tr", null, f.type === "part" ? "bom-part" : "bom-line");
        tr.dataset.r = String(r);
        if (r % 2) tr.classList.add("odd");
        tr.setAttribute("aria-rowindex", String(r + 1));
        if (f.type === "line" && f.row.dnp || f.type === "part" && f.part.dnp) tr.classList.add("is-dnp");
        const lead = el("td", null, "bom-lead pin"); lead.style.left = "0px";
        if (f.type === "line") {
          if (f.row.parts.length > 1) { const caret = el("span", state.expanded.has(lineKey(f.row)) ? "▾" : "▸", "bom-caret"); lead.append(caret); }
          const issues = f.row.status.filter(s => s !== "dnp");
          if (issues.length) {
            const dot = el("span", null, "bom-mark " + (issues.some(s => SEVERE.has(s)) ? "sev-error" : "sev-warning"));
            dot.title = issues.map(s => STATUS_TEXT[s]).join(", "); lead.append(dot);
          }
          const hs = lineHints.get(f.row);
          if (hs) {
            // A quiet marker; click (or the shortcut on the row) opens the strip. No hover pop-up.
            const mark = el("span", null, "bom-hint-mark sev-" + hintSeverity(hs) + (r === stripAt ? " open" : ""));
            mark.setAttribute("aria-hidden", "true");
            lead.append(mark);
            lead.setAttribute("aria-label", T("bom.hint.mark_label", {suggestions: count(hs.length, "suggestion"), key: stripKeySpoken}));
            tr.classList.add("has-hint");
          }
          const partner = partners.get(f.row);
          if (partner) tr.classList.add(partner === "keep" ? "hint-keep" : "hint-partner");
          if (r === stripAt) tr.classList.add("hint-open");
        }
        tr.append(lead);
        cols.forEach((c, i) => {
          const td = el("td", cellText(f, c));
          td.dataset.c = String(i);
          if (c.numeric) td.className = "num"; else if (c.key === "designator") td.className = "refs";
          if (lefts[i] != null) { td.classList.add("pin"); td.style.left = lefts[i] + "px"; }
          if (r >= sel.r0 && r <= sel.r1 && i >= sel.c0 && i <= sel.c1) td.classList.add("sel");
          if (r === state.active.r && i === state.active.c) { td.classList.add("active"); td.id = "bom-active-cell"; }
          tr.append(td);
        });
        frag.append(tr);
        if (r === stripAt) frag.append(hintStrip(f.row, span));
      }
      const total = flat.length * rowH + (stripAt >= 0 ? stripH : 0);
      if (last < flat.length) frag.append(spacer(total - yOf(last)));
      // Scrolling repaints the rows; a focused button in the hint strip keeps the focus.
      const had = globalThis.document?.activeElement?.closest?.(".bom-hint-strip") ? document.activeElement : null;
      const focusKey = had ? (had.closest("[data-hint]")?.dataset.hint || "") + "\u0001" + (had.dataset.act || "") : null;
      tbody.replaceChildren(frag);
      if (focusKey != null) {
        const again = [...tbody.querySelectorAll(".bom-hint-strip button")].find(b => (b.closest("[data-hint]")?.dataset.hint || "") + "\u0001" + (b.dataset.act || "") === focusKey);
        (again || gridWrap).focus({preventScroll: true});
      }
      gridWrap.setAttribute("aria-activedescendant", "bom-active-cell");
      // Row and strip heights: measured at once on the first paint and with a strip open; after
      // that in the next frame (no forced layout per edit or keystroke), repainting if they changed.
      if (!measured || stripAt >= 0) measure();
      else if (!measureFrame && typeof requestAnimationFrame === "function") measureFrame = requestAnimationFrame(() => { measureFrame = 0; if (!editor && d.open) measure(); });
    }
    function measure() {
      const probe = tbody.querySelector("tr.bom-line,tr.bom-part");
      const h = probe?.getBoundingClientRect().height;
      if (h) measured = true;
      if (h && Math.abs(h - rowH) > 0.5) { rowH = h; paintRows(); return; }
      const strip = tbody.querySelector("tr.bom-hint-strip");
      const sh = strip?.getBoundingClientRect().height;
      if (sh && Math.abs(sh - stripH) > 0.5) { stripH = sh; paintRows(); }
    }
    // Scrolling repaints only when the view reaches the edge of the rendered rows (never for short BOMs).
    let scrollFrame = 0;
    function covered() {
      if (flat.length <= RENDER_ALL) return rendered.last === flat.length && rendered.first === 0;
      const top = gridWrap.scrollTop, view = gridWrap.clientHeight || 600;
      const a = rowAt(top), b = Math.min(flat.length, rowAt(top + view) + 1);
      return a >= rendered.first && b <= rendered.last;
    }
    gridWrap.onscroll = () => {
      if (scrollFrame || covered()) return;
      scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; if (!editor && !covered()) paintRows(); });
    };
    if (typeof ResizeObserver === "function") new ResizeObserver(() => { syncScrollMode(); if (d.open && !covered()) paintRows(); }).observe(gridWrap);
    function cellAt(target) {
      const td = target.closest?.("td"), tr = td?.parentElement;
      if (!tr?.dataset.r) return null;
      return {r: Number(tr.dataset.r), c: td.dataset.c != null ? Number(td.dataset.c) : -1};
    }
    function moveTo(r, c, extend) {
      if (!extend) state.anchor = null; else if (!state.anchor) state.anchor = {...state.active};
      state.active = {r, c}; clamp();
      // Keep the active row in view.
      const y = yOf(state.active.r), h = gridWrap.clientHeight - 2 * rowH;
      if (y < gridWrap.scrollTop) gridWrap.scrollTop = y;
      else if (y > gridWrap.scrollTop + h) gridWrap.scrollTop = y - h;
      const x = cols.slice(0, state.active.c).reduce((n, k) => n + widthOf(k), leadW()), w = widthOf(cols[state.active.c] || {});
      const pinW = state.active.c >= state.pinned ? pinLeft(Math.min(state.pinned, cols.length)) : 0;
      if (x < gridWrap.scrollLeft + pinW) gridWrap.scrollLeft = Math.max(0, x - pinW);
      else if (x + w > gridWrap.scrollLeft + gridWrap.clientWidth) gridWrap.scrollLeft = x + w - gridWrap.clientWidth;
      paintRows(); paintDetail();
    }
    function toggle(r) {
      const f = flat[r]; if (!f || f.row.parts.length < 2) return;
      const k = lineKey(f.row);
      if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
      flatten(); state.active.r = flat.findIndex(x => x.type === "line" && x.row === f.row); clamp(); paintRows();
    }
    tbody.onmousedown = e => {
      const at = cellAt(e.target); if (!at) return;
      if (editor) commitEdit();
      if (e.target.closest(".bom-caret")) { e.preventDefault(); toggle(at.r); return; }
      if (e.target.closest(".bom-hint-mark")) { e.preventDefault(); gridWrap.focus({preventScroll: true}); moveTo(at.r, state.active.c); toggleStrip(at.r); return; }
      if (at.c < 0) at.c = state.active.c;
      e.preventDefault(); gridWrap.focus({preventScroll: true});
      moveTo(at.r, at.c, e.shiftKey);
    };
    tbody.ondblclick = e => {
      const at = cellAt(e.target); if (!at || at.c < 0) return;
      const c = cols[at.c];
      if (editableKey(c.key)) startEdit(); else { const f = flat[at.r]; reveal(f.type === "part" ? f.part : f.row.parts[0]); }
    };
    gridWrap.onkeydown = e => {
      if (editor || e.target !== gridWrap) return;
      const {r, c} = state.active, page = Math.max(1, Math.floor(gridWrap.clientHeight / rowH) - 1), mod = e.metaKey || e.ctrlKey;
      const go = {ArrowDown: [r + 1, c], ArrowUp: [r - 1, c], ArrowLeft: [r, c - 1], ArrowRight: [r, c + 1], PageDown: [r + page, c], PageUp: [r - page, c],
        Home: mod ? [0, 0] : [r, 0], End: mod ? [flat.length - 1, cols.length - 1] : [r, cols.length - 1]}[e.key];
      if (go) { e.preventDefault(); moveTo(go[0], go[1], e.shiftKey); return; }
      if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); copyRange(); return; }
      if (mod && e.key === ".") { e.preventDefault(); toggleStrip(r, true); return; }
      if (mod && (e.key === "a" || e.key === "A")) { e.preventDefault(); state.anchor = {r: 0, c: 0}; state.active = {r: flat.length - 1, c: cols.length - 1}; paintRows(); return; }
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        const col = cols[c];
        if (col && editableKey(col.key)) startEdit(); else if (flat[r]?.row.parts.length > 1) toggle(r); else if (flat[r]) reveal(flat[r].type === "part" ? flat[r].part : flat[r].row.parts[0]);
        return;
      }
      if (e.key === " " && !mod) { e.preventDefault(); toggle(r); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && editableKey(cols[c]?.key || "")) { e.preventDefault(); commitValue(""); return; }
      if (e.key.length === 1 && !mod && !e.altKey && editableKey(cols[c]?.key || "")) { e.preventDefault(); startEdit(e.key); }
    };
    function copyRange() {
      const s = range(), matrix = [];
      for (let r = s.r0; r <= s.r1; r++) { const row = []; for (let c = s.c0; c <= s.c1; c++) row.push(cellText(flat[r], cols[c])); matrix.push(row); }
      const text = tsv(matrix);
      const fallback = () => {
        const ta = el("textarea", text, "bom-clip ui-field"); d.append(ta); ta.select();
        try { document.execCommand("copy"); } catch {}
        ta.remove(); gridWrap.focus();
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback); else fallback();
      status.textContent = "Copied " + count((s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1), "cell") + ".";
    }

    // ---------------------------------------------------------- hints
    // Optimiser suggestions inline: a marker on each line a suggestion concerns, a strip under the
    // line (click the marker, or the shortcut on the focused row) with what changes, why, the
    // guarantee, and Apply / Dismiss / Show in Optimise. The analysis runs when the editor is idle,
    // never while a cell is being edited, once per undo revision (or content key).
    const EMPTY = new Map();
    let stripFresh = false;
    let partnerMemo = {row: null, hints: null, map: EMPTY};
    function stripPartners() {
      if (stripAt < 0) return EMPTY;
      const row = flat[stripAt].row;
      if (partnerMemo.row === row && partnerMemo.hints === lineHints) return partnerMemo.map;
      const keep = new Set(), others = new Set(), map = new Map();
      for (const h of lineHints.get(row) || []) {
        if (h.groups.length < 2) continue;
        h.groups.forEach((g, i) => { for (const id of g) (h.kind === "merge" && i === 0 ? keep : others).add(id); });
      }
      if (keep.size || others.size) for (const x of rows) {
        if (x === row) continue;
        for (const p of x.parts) { if (keep.has(p.id)) { map.set(x, "keep"); break; } if (others.has(p.id)) map.set(x, "partner"); }
      }
      partnerMemo = {row, hints: lineHints, map};
      return map;
    }
    function changeText(h) {
      if (!h.from?.length || !h.target) return "";
      const from = h.from.filter(f => !f.target), shown = from.slice(0, 4).map(f => (f.comment || f.description) + " (" + f.refs + ")");
      if (from.length > 4) shown.push("+" + (from.length - 4));
      const to = h.kind === "package" ? h.target.package : h.kind === "cover" ? h.target.description : (h.target.comment || h.target.description) + (h.target.mpn ? " · " + h.target.mpn : "");
      return shown.join(", ") + " → " + to;
    }
    function hintStrip(row, span) {
      const tr = el("tr", null, "bom-hint-strip"), td = el("td");
      td.colSpan = span;
      // Animates once when it opens, not on the repaints that scrolling makes.
      const box = el("div", null, "bom-hint-box" + (stripFresh ? " entering" : ""));
      stripFresh = false;
      box.setAttribute("role", "group"); box.setAttribute("aria-label", T("bom.hint.region", {line: row.line}));
      // As wide as the visible grid (or the table, when it is narrower), pinned to the left edge.
      box.style.width = Math.max(260, Math.min(gridWrap.clientWidth, parseFloat(table.style.width) || Infinity) - 2) + "px";
      for (const h of lineHints.get(row) || []) {
        const item = el("div", null, "bom-hint-item sev-" + h.severity); item.dataset.hint = h.id;
        const text = el("div", null, "bom-hint-text"), head = el("div", null, "bom-hint-head");
        head.append(el("span", HINT_KIND[h.kind]?.() || h.kind, "bom-hint-kind"), el("strong", h.title));
        if (h.applicable && h.savings?.lines) head.append(el("span", "−" + count(h.savings.lines, "line"), "bom-hint-save"));
        text.append(head);
        const change = changeText(h);
        if (change) { const p = el("p", null, "bom-hint-change"); p.append(el("span", T("bom.hint.changes"), "bom-hint-label"), document.createTextNode(change)); text.append(p); }
        const why = el("p", null, "bom-hint-why"); why.append(el("span", T("bom.hint.why"), "bom-hint-label"), document.createTextNode(h.text)); text.append(why);
        for (const c of h.caveats.slice(0, 3)) text.append(el("p", c, "bom-hint-caveat"));
        text.append(el("p", h.applicable ? (h.subtype === "notation" ? T("bom.hint.guarantee_notation") : T("bom.hint.guarantee")) : T("bom.hint.advice"), "bom-hint-guarantee"));
        const acts = el("div", null, "bom-hint-actions");
        const act = (label, name, cls) => { const b = button(label, null, cls); b.dataset.act = name; acts.append(b); };
        if (h.applicable) act(T("bom.hint.apply"), "apply", "bom-hint-apply");
        act(T("bom.hint.dismiss"), "dismiss"); act(T("bom.hint.show"), "show");
        item.append(text, acts); box.append(item);
      }
      const foot = el("div", null, "bom-hint-foot");
      const x = button("×", null, "bom-hint-close"); x.dataset.act = "close"; x.setAttribute("aria-label", T("bom.hint.close"));
      const hint = el("span", null, "bom-hint");
      hint.append(...AtriumNavCommon.shortcutParts(T("bom.hint.keys"), {key:stripBinding, escape:"Escape"}));
      foot.append(hint, x);
      box.append(foot);
      td.append(box); tr.append(td);
      return tr;
    }
    function toggleStrip(r, focusFirst) {
      const f = flat[r]; if (!f) return;
      const key = lineKey(f.row);
      if (!lineHints.has(f.row)) return;
      if (state.strip === key) { closeStrip(true); return; }
      state.strip = key; locateStrip(); stripFresh = true;
      state.active.r = stripAt; state.anchor = null;
      // Bring the whole strip into view.
      const head = thead.getBoundingClientRect?.().height || 0, bottom = yOf(stripAt) + rowH + stripH + head;
      if (bottom > gridWrap.scrollTop + gridWrap.clientHeight) gridWrap.scrollTop = bottom - gridWrap.clientHeight;
      paintRows(); paintDetail();
      if (focusFirst) tbody.querySelector(".bom-hint-strip button")?.focus({preventScroll: true});
    }
    function closeStrip(refocus) {
      state.strip = null; stripAt = -1;
      paintRows(); paintDetail();
      if (refocus) gridWrap.focus({preventScroll: true});
    }
    const idle = fn => typeof requestIdleCallback === "function" ? requestIdleCallback(fn, {timeout: 1200}) : setTimeout(() => fn(null), 0);
    function cancelHints() {
      clearTimeout(hintTimer);
      if (hintIdle) { if (typeof cancelIdleCallback === "function") cancelIdleCallback(hintIdle); else clearTimeout(hintIdle); }
      hintTimer = hintIdle = 0;
    }
    const analysisKey = () => [collected.source, collected.board?.id || "", collected.variant?.id || "",
      typeof ctx.revision === "function" ? "r" + ctx.revision() : O.contentKey(collected)].join("|");
    const analysisOptions = () => ({collected, source: collected.source, board: collected.board?.id});
    let hintMs = 0;
    function scheduleHints() {
      cancelHints();
      if (!O?.hints || !state.hints) return;
      const key = analysisKey(), hit = O.cachedAnalysis(live(), key);
      if (hit) { if (hit !== hintAnalysis) useAnalysis(hit, key); return; }
      hintTimer = setTimeout(() => { hintTimer = 0; hintIdle = idle(runHints); }, 120);
    }
    function runHints(deadline) {
      hintIdle = 0;
      if (!d.isConnected) return;
      // Never while a cell is being edited, and only in a long enough idle period (or once overdue).
      if (editor || (deadline && !deadline.didTimeout && deadline.timeRemaining() < 8)) {
        hintTimer = setTimeout(() => { hintTimer = 0; hintIdle = idle(runHints); }, editor ? 400 : 40);
        return;
      }
      const key = analysisKey(), t0 = performance.now();
      let a;
      try { a = O.analyseCached(live(), key, analysisOptions()); } catch { return; }
      hintMs = performance.now() - t0;
      useAnalysis(a, key);
    }
    // The analysis for the current BOM now (the Optimise tab, Apply); cached per key.
    function analysisNow() {
      const key = analysisKey(), a = O.analyseCached(live(), key, analysisOptions());
      if (state.hints && a !== hintAnalysis) useAnalysis(a, key);
      return a;
    }
    function useAnalysis(a, key) {
      hintAnalysis = a; hintKey = key;
      rehint();
    }
    function rehint() {
      const t0 = performance.now();
      hintData = hintAnalysis && state.hints ? O.hints(hintAnalysis, {dismissed}) : null;
      lineHints = hintData ? rowHints(rows, hintData) : new Map();
      if (state.hintsOnly && !lineHints.size) state.hintsOnly = false;
      if (state.hintsOnly) refilter(); else { locateStrip(); paintRows(); paintDetail(); }
      paintHintUI(); paintSummary();
      d.dataset.hintMs = (hintMs + performance.now() - t0).toFixed(1);
    }
    function paintHintUI() {
      const on = !!(O?.hints && state.hints && hintData), n = on ? hintData.count : 0;
      optCount.textContent = n ? String(n) : "";
      optCount.hidden = !n;
      optButton.setAttribute("aria-label", n ? T("bom.hint.optimise_label", {suggestions: count(n, "suggestion")}) : T("bom.hint.optimise"));
      optButton.hidden = !O || state.tab !== "lines";
      hintChip.hidden = !on || (!n && !state.hintsOnly);
      hintChip.textContent = on && hintData.lines ? T("bom.hint.chip", {suggestions: count(n, "suggestion"), lines: count(hintData.lines, "line")}) : count(n, "suggestion");
      hintChip.setAttribute("aria-pressed", String(state.hintsOnly));
      hintChip.setAttribute("aria-description", T("bom.hint.chip_label"));
    }
    function setHints(on) {
      state.hints = on;
      if (!on) { state.strip = null; state.hintsOnly = false; cancelHints(); }
      hintData = null; lineHints = new Map();
      regroup();
      if (on) { if (hintAnalysis && hintKey === analysisKey()) rehint(); else scheduleHints(); }
      panel.querySelector(".bom-hint-settings input")?.focus();
    }
    function applyHint(id) {
      // Apply works on the analysis of the BOM as it is now.
      if (hintKey !== analysisKey()) analysisNow();
      const h = hintData?.list.find(x => x.id === id);
      let r;
      try {
        if (!h) throw Error("This suggestion no longer applies.");
        r = O.applyHint(live(), hintAnalysis, id, typeof ctx.edit === "function" ? ctx.edit : null);
      } catch (e) { status.textContent = e.message || String(e); return; }
      status.textContent = T("bom.hint.applied", {title: h.title, parts: count(h.parts.length || r.parts, "part")});
      ctx.info?.("BOM optimisation applied");
      state.strip = null;
      recollect();
      analysisNow();
      gridWrap.focus({preventScroll: true});
    }
    function dismissHint(id) {
      if (!dismissed) return;
      dismissed.add(id);
      status.textContent = T("bom.hint.dismissed");
      const inStrip = !!globalThis.document?.activeElement?.closest?.(".bom-hint-strip");
      rehint(); paintPanel(); optView?.repaint();
      if (inStrip) (tbody.querySelector(".bom-hint-strip button") || gridWrap).focus({preventScroll: true});
    }
    function restoreHint(id) {
      if (id == null) dismissed?.clear(); else dismissed?.remove(id);
      rehint(); paintPanel();
    }
    function showInOptimise(id) {
      const h = hintData?.list.find(x => x.id === id);
      showTab("optimise");
      if (h) requestAnimationFrame(() => optView?.reveal(h.proposal || h.check));
    }
    tbody.onclick = e => {
      const b = e.target.closest?.(".bom-hint-strip button[data-act]"); if (!b) return;
      const act = b.dataset.act, id = b.closest("[data-hint]")?.dataset.hint;
      if (act === "close") closeStrip(true);
      else if (id && act === "apply") applyHint(id);
      else if (id && act === "dismiss") dismissHint(id);
      else if (id && act === "show") showInOptimise(id);
    };
    tbody.addEventListener("keydown", e => {
      if (!e.target.closest?.(".bom-hint-strip")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" || (mod && e.key === ".")) { e.preventDefault(); e.stopPropagation(); closeStrip(true); }
    });

    // ------------------------------------------------------------ editing
    const targetParts = f => f.type === "part" ? [f.part] : f.row.parts;
    function startEdit(initial) {
      const f = flat[state.active.r], c = cols[state.active.c];
      if (!f || !c || !editableKey(c.key)) return;
      if (c.key === "dnp") { commitValue(cellText(f, c) ? "" : "DNP"); return; }
      const td = tbody.querySelector("td.active"); if (!td) return;
      const input = el("input", null, "bom-editor ui-field"); input.dataset.gridEditing = ""; input.type = "text"; input.spellcheck = false;
      input.value = initial ?? cellText(f, c);
      input.setAttribute("aria-label", "Edit " + c.label);
      const wr = gridWrap.getBoundingClientRect(), cr = td.getBoundingClientRect();
      Object.assign(input.style, {left: cr.left - wr.left + gridWrap.scrollLeft + "px", top: cr.top - wr.top + gridWrap.scrollTop + "px", width: cr.width + "px", height: cr.height + "px"});
      editor = {input, f, c};
      gridWrap.append(input); input.focus();
      if (initial == null) input.select();
      input.onkeydown = e => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
        else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          // The commit regroups; the move paints the grid once, for both.
          hold++; try { commitEdit(); } finally { hold--; }
          moveTo(state.active.r + (e.key === "Enter" ? (e.shiftKey ? -1 : 1) : 0), state.active.c + (e.key === "Tab" ? (e.shiftKey ? -1 : 1) : 0));
          gridWrap.focus({preventScroll: true});
        }
      };
      input.onblur = () => { if (editor?.input === input) commitEdit(); };
    }
    function cancelEdit() { const x = editor; editor = null; x?.input.remove(); gridWrap.focus({preventScroll: true}); }
    function commitEdit() {
      const x = editor; if (!x) return;
      editor = null; x.input.remove();
      if (x.input.value !== cellText(x.f, x.c)) commitValue(x.input.value, x.f, x.c);
      if (!hold) gridWrap.focus({preventScroll: true});
    }
    function commitValue(value, f = flat[state.active.r], c = cols[state.active.c]) {
      if (!f || !c) return;
      // With a variant chosen, DNP is that variant's fitted state, not the base design's flag.
      const V = globalThis.AtriumVariants;
      if (c.key === "dnp" && V && collected.variant) {
        const on = clean(value) !== "" && !falsy(value) && !/^fitted$/i.test(clean(value));
        const keys = targetParts(f).flatMap(p => [p.item, p.mate?.item].filter(Boolean).map(V.keyOf));
        try {
          const run = () => V.setParts(live(), collected.variant.id, keys, {fitted: !on});
          if (typeof ctx.edit === "function") ctx.edit(run); else run();
        } catch (e) { status.textContent = e.message || String(e); return; }
        status.textContent = (on ? "Not fitted" : "Fitted") + " in " + collected.variant.name + ": " + count(targetParts(f).length, "part") + ".";
        recollect();
        return;
      }
      edit(planEdit(targetParts(f), c.key, value), c.label);
    }
    // Every edit is one undo step through the editor.
    function edit(changes, what) {
      if (!changes.length) return;
      try {
        const run = () => applyChanges(live(), changes);
        if (typeof ctx.edit === "function") ctx.edit(run); else run();
      } catch (e) { status.textContent = e.message || String(e); return; }
      const parts = new Set(changes.map(x => x.ref)).size;
      status.textContent = "Set " + what + " on " + count(parts, "part") + ".";
      recollect();
    }

    // ---------------------------------------------------------- side panel
    function paintPanel() {
      const panel = panelBody;
      panel.replaceChildren();
      const h = el("div", null, "bom-columns-head"); h.append(el("span", "Column"), el("span", "Show"), el("span", "Group"));
      panel.append(h);
      const list = el("div", null, "bom-column-list"); list.setAttribute("role", "list");
      state.order.forEach((key, i) => {
        const c = all.find(x => x.key === key); if (!c) return;
        const row = el("div", null, "bom-column"); row.setAttribute("role", "listitem"); row.dataset.key = key; row.draggable = true;
        const show = el("input", null, "ui-checkbox"); show.type = "checkbox"; show.dataset.role = "show"; show.checked = state.columns.includes(key);
        show.setAttribute("aria-label", "Show " + c.label);
        show.onchange = () => { state.columns = show.checked ? [...state.columns, key] : state.columns.filter(k => k !== key); regroup(); refocus(i, "show"); };
        const group = el("input", null, "ui-checkbox"); group.type = "checkbox"; group.dataset.role = "group"; group.checked = state.groupBy.includes(key); group.disabled = !c.group;
        group.setAttribute("aria-label", "Group by " + c.label);
        group.onchange = () => { state.groupBy = group.checked ? [...state.groupBy, key] : state.groupBy.filter(k => k !== key); regroup(); refocus(i, "group"); };
        const move = (delta, label) => {
          const b = button(delta < 0 ? "↑" : "↓", () => {
            const j = i + delta; if (j < 0 || j >= state.order.length) return;
            [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
            regroup(); refocus(j, delta < 0 ? "up" : "down");
          }, "bom-move");
          b.dataset.role = delta < 0 ? "up" : "down"; b.setAttribute("aria-label", label); b.title = label;
          b.disabled = delta < 0 ? i === 0 : i === state.order.length - 1;
          return b;
        };
        const name = el("span", c.label, "bom-column-name"); name.title = (c.param ? "Parameter " + c.param + " · " : "") + "Drag to reorder";
        row.append(name, show, group, move(-1, "Move " + c.label + " up"), move(1, "Move " + c.label + " down"));
        list.append(row);
      });
      panel.append(list);
      const pin = el("select", null, "ui-field"); pin.setAttribute("aria-label", "Pinned columns");
      for (let n = 0; n <= 4; n++) pin.add(new Option(n ? "First " + n : "None", String(n)));
      pin.value = String(state.pinned);
      pin.onchange = () => { state.pinned = Number(pin.value); regroup(); };
      const opts = el("div", null, "bom-panel-row"); opts.append(field_("Pin", pin));
      panel.append(opts);
      // Optimiser hints in the lines: on by default; dismissed ones are kept per project.
      if (O?.hints) {
        const hv = el("div", null, "bom-views bom-hint-settings");
        const on = el("input", null, "ui-checkbox"); on.type = "checkbox"; on.checked = state.hints;
        on.onchange = () => setHints(on.checked);
        const label = el("label", null, "bom-check"); label.append(on, el("span", T("bom.hint.setting")));
        hv.append(el("strong", T("bom.hint.heading")), label);
        if (dismissed?.size) hv.append(button(T("bom.hint.restore_all", {count: dismissed.size}), () => { restoreHint(null); optView?.repaint(); }, "bom-reset"));
        panel.append(hv);
      }
      const reset = button("Reset columns", () => {
        Object.assign(state, {columns: defaultColumns.slice(), groupBy: defaultGroups.slice(), order: null, sort: [{key: "designator", dir: 1}], widths: {}, pinned: 2, filters: {}});
        recollect();
      }, "bom-reset");
      panel.append(reset);
      // Named views live in the project, so exports and automation can use them.
      // Its own labelled group: the view name is not one of the column settings above it.
      const views_ = el("div", null, "bom-views"), viewsTitle = el("strong", "Saved views");
      viewsTitle.id = "bom-saved-views-title"; views_.setAttribute("role", "group"); views_.setAttribute("aria-labelledby", viewsTitle.id);
      views_.append(viewsTitle,el("p", "Saved in the project with column order, widths, grouping, sort and filters. Exports use the current view.", "bom-hint"));
      const name = el("input", null, "ui-field"); name.type = "text"; name.placeholder = "View name"; name.value = state.viewName; name.setAttribute("aria-label", "View name");
      const save = button("Save view", () => {
        const v = {name: name.value, columns: state.columns, order: state.order, widths: state.widths, pinned: state.pinned, groupBy: state.groupBy,
          sort: state.sort, filters: state.filters, query: state.query, showDnp: state.showDnp, source: state.source,
          ...(variantField.hidden ? {} : {variant: state.variant || ""})};
        try {
          let saved;
          const run = () => { saved = saveView(live(), v); };
          if (typeof ctx.edit === "function") ctx.edit(run); else run();
          state.viewName = saved.name; paintViews(); remember(); paintPanel();
          status.textContent = "Saved view " + saved.name + " in the project.";
        } catch (e) { status.textContent = e.message; }
      });
      const del = button("Delete", () => {
        const n = state.viewName; if (!n) return;
        const run = () => deleteView(live(), n);
        if (typeof ctx.edit === "function") ctx.edit(run); else run();
        state.viewName = ""; Object.assign(state, viewState(prefsView())); paintViews(); recollect();
        status.textContent = "Deleted view " + n + ".";
      });
      del.disabled = !state.viewName;
      const vr = el("div", null, "bom-panel-row"); vr.append(name, save, del);
      views_.append(vr); panel.append(views_);
    }
    const prefsView = () => ({columns: prefs.columns, order: prefs.order, groupBy: prefs.groupBy, sort: sortList(prefs.sort), widths: prefs.widths, pinned: prefs.pinned, showDnp: prefs.showDnp});
    function refocus(i, role) {
      const row = panel.querySelectorAll(".bom-column")[i];
      const target = row?.querySelector('[data-role="' + role + '"]');
      (target && !target.disabled ? target : row?.querySelector('[data-role="show"]'))?.focus();
    }

    // ---------------------------------------------------------- solutions
    function canReveal(part) { return typeof ctx.select === "function" || (typeof ctx.locate === "function" && part.docId === ctx.doc?.id); }
    function reveal(part) {
      if (!part || !canReveal(part)) { status.textContent = part ? "Open " + part.docName + " to locate " + part.ref + "." : ""; return; }
      d.close();
      if (typeof ctx.select === "function") ctx.select(part.id); else ctx.locate(part.id, part.at);
      ctx.info?.("Located " + part.ref);
    }
    function supplierProviders() {
      if (!O) return [];
      const s = O.loadSettings();
      return [...O.providers.values()].filter(p => !p.stub && p.network && s.providers[p.id]?.enabled && p.configured(s.providers[p.id]))
        .map(p => O.provider(p.id, {settings: s.providers[p.id]}));
    }
    async function findOffers(row) {
      const mpn = row.parts.find(p => p.mpn)?.mpn;
      const providers = supplierProviders();
      if (!providers.length) { status.textContent = "Enable a supplier in Optimise › Suppliers first. Waffle stays offline until you do."; return; }
      status.textContent = "Looking up " + (mpn || row.values.comment) + "…";
      const line = {key: "x", refs: row.refs, qty: row.parts.length, comment: row.values.comment, mpn, manufacturer: row.parts.find(p => p.manufacturer)?.manufacturer,
        supplierPn: row.parts.find(p => p.supplierPn)?.supplierPn};
      try {
        const res = await O.price([line], {providers});
        const offers = res.lines.get("x")?.offers || [];
        state.offers.set(lineKey(row), offers);
        const qty = row.parts.length * Math.max(1, O.loadSettings().quantity || 1);
        const ranked = rank(offers, qty);
        if (mpn && ranked[0]) state.solutions.set(upper(mpn), {supplier: ranked[0].offer.supplier, sku: ranked[0].offer.sku, stock: ranked[0].offer.stock,
          unit: ranked[0].unit, currency: ranked[0].offer.currency, lifecycle: ranked[0].offer.lifecycle});
        status.textContent = offers.length ? count(offers.length, "offer") + " found." : "No exact match." + (res.errors[0] ? " " + res.errors[0].message : "");
        const keep = row.parts[0].id; rows = build(collected, settings()); refilter(keep);
      } catch (e) { status.textContent = e.message || String(e); }
    }
    // Offers that cover the quantity first, then by price at that quantity.
    function rank(offers, qty) {
      return offers.map(o => {
        const p = O.priceAt(o.priceBreaks, Math.max(qty, o.moq || 1));
        return {offer: o, unit: p?.unit ?? Infinity, ok: o.stock >= qty && !!p};
      }).sort((a, b) => (b.ok - a.ok) || a.unit - b.unit || (b.offer.stock - a.offer.stock));
    }
    function paintDetail() {
      if (hold) return;
      detail.replaceChildren();
      const f = flat[state.active.r];
      if (!f) {
        const hint = el("span", null, "bom-hint");
        hint.append("Select a line. ", AtriumShortcut.render("Enter", {variant:"inline"}), " edits a cell, ",
          AtriumShortcut.render("Space", {variant:"inline"}), " expands a line, ",
          AtriumShortcut.render("Mod+C", {variant:"inline"}), " copies the selection.");
        detail.append(hint); return;
      }
      const row = f.row;
      const head = el("div", null, "bom-sol-head");
      head.append(el("strong", "Line " + row.line + " · " + count(row.parts.length, "component")));
      for (const s of row.status) { const badge = el("span", STATUS_TEXT[s], "ui-badge bom-badge"); if (s !== "dnp" || SEVERE.has(s)) badge.dataset.tone = SEVERE.has(s) ? "danger" : "warning"; head.append(badge); }
      const hs = lineHints.get(row);
      if (hs) {
        const suggestions = count(hs.length, "suggestion");
        const b = button("", () => {
          const i = flat.findIndex(x => x.type === "line" && x.row === row);
          if (i >= 0) toggleStrip(i, true);
        }, "bom-hint-detail sev-" + hintSeverity(hs));
        b.setAttribute("aria-expanded", String(state.strip === lineKey(row)));
        b.append(...AtriumNavCommon.shortcutParts(T("bom.hint.detail", {suggestions, key:"{key}"}), {key:stripBinding}));
        b.setAttribute("aria-label", T("bom.hint.detail", {suggestions, key:stripKeySpoken}));
        head.append(b);
      }
      const chips = el("div", null, "bom-chips");
      for (const p of row.parts.slice(0, 60)) {
        const b = chip(p.ref || "?", () => reveal(p));
        b.title = (canReveal(p) ? "Locate " : "") + p.ref + " on " + p.docName; b.disabled = !canReveal(p);
        chips.append(b);
      }
      if (row.parts.length > 60) chips.append(el("span", "+" + (row.parts.length - 60), "bom-hint"));
      const left = el("div", null, "bom-sol-parts"); left.append(head, chips);
      const sol = el("div", null, "bom-solutions");
      const mpn = row.values.mpn, maker = row.values.manufacturer;
      const mp = el("div", null, "bom-sol-mpn");
      mp.append(el("span", "Manufacturer part", "bom-hint"), el("strong", mpn ? mpn + (maker ? " · " + maker : "") : "None — select the MPN cell and type one"));
      sol.append(mp);
      const offers = state.offers.get(lineKey(row));
      if (offers?.length) {
        const qty = row.parts.length * Math.max(1, O?.loadSettings().quantity || 1);
        const list = el("ol", null, "bom-offers");
        for (const [i, r] of rank(offers, qty).slice(0, 6).entries()) {
          const li = el("li", null, r.ok ? "" : "short");
          li.append(el("span", (i === 0 && r.ok ? "★ " : "") + r.offer.supplier, "bom-offer-sup"), el("code", r.offer.sku || ""),
            el("span", "stock " + (r.offer.stock ?? "?"), "bom-hint"), el("span", Number.isFinite(r.unit) ? r.offer.currency + " " + r.unit : "–", "num"),
            el("span", [r.offer.lifecycle !== "unknown" ? r.offer.lifecycle.toUpperCase() : "", r.offer.basic === true ? "JLC basic" : r.offer.basic === false ? "JLC extended" : ""].filter(Boolean).join(" · "), "bom-hint"));
          const use = small("Use", () => edit([...planEdit(row.parts, "supplier", r.offer.supplier), ...planEdit(row.parts, "supplierPn", r.offer.sku || "")], "the supplier"));
          use.title = "Write supplier and supplier part number to these parts";
          li.append(use); list.append(li);
        }
        sol.append(list);
      } else if (O) {
        const b = small("Find offers", () => findOffers(row)); b.classList.add("bom-find-offers");
        b.title = "Look up this line at your enabled suppliers (sends only the MPN or value)";
        sol.append(b);
      }
      detail.append(left, sol);
    }

    // ---------------------------------------------------------- notes
    function describeMismatch(m) {
      if (m.kind === "schematic-only") return m.ref + " is on the schematic but not on " + (collected.board?.name || "the board") + ".";
      if (m.kind === "board-only") return m.ref + " is on " + (collected.board?.name || "the board") + " but not on the schematic.";
      return m.ref + " " + (m.kind === "comment" ? "comment" : "footprint") + " differs: schematic " + (m.schematic || "–") + ", board " + (m.board || "–") + ".";
    }
    function paintNotes() {
      // Sections stay open across repaints (every edit regroups); the difference list is built when shown.
      const open = new Set([...notes.querySelectorAll("details[open]")].map(x => x.dataset.k));
      const section = k => { const box = el("details"); box.dataset.k = k; box.open = open.has(k); return box; };
      notes.replaceChildren();
      const ex = collected.excluded;
      {
        const box = section("excluded"), reasons = new Map(); box.id = "bom-excluded";
        for (const x of ex) { if (!reasons.has(x.reason)) reasons.set(x.reason, []); reasons.get(x.reason).push(x.ref || "?"); }
        box.append(el("summary", ex.length ? count(ex.length, "component") + " excluded" : "No components excluded"));
        box.append(el("p", "Left out of the lines: DNP (do not populate) parts, which stay in the design but are not fitted on the assembled board, " +
          "power and virtual symbols, parts without a footprint and parts marked Not in BOM.", "bom-hint"));
        const ul = el("ul");
        for (const [reason, refs] of reasons) {
          const li = el("li"); li.append(el("strong", (reason === "Do not populate" ? "DNP (do not populate)" : reason) + " · "), document.createTextNode(compress(refs)));
          if (reason === "Do not populate") {
            const b = button(state.showDnp ? "Hide from the lines" : "Show in the lines", () => { state.showDnp = !state.showDnp; regroup(); showExcluded(); }, "bom-link");
            li.append(" ", b);
          }
          ul.append(li);
        }
        if (ul.childElementCount) box.append(ul);
        notes.append(box);
      }
      const mm = collected.mismatches;
      if (collected.board && collected.sheets.length) {
        const box = section("differences");
        box.append(el("summary", mm.length ? count(mm.length, "schematic and board difference") : "Schematic and " + collected.board.name + " match"));
        const fill = () => {
          const ul = el("ul", null, "bom-mismatches"), byId = new Map();
          for (const p of collected.parts) if (!byId.has(p.id)) byId.set(p.id, p);
          for (const m of mm.slice(0, 300)) {
            const li = el("li"), id = m.schematicId || m.boardId;
            const part = byId.get(id) || {id, ref: m.ref, docId: null, docName: m.schematicId ? "the schematic" : collected.board.name, at: [0, 0]};
            const b = chip(m.ref, () => { if (typeof ctx.select === "function") { d.close(); ctx.select(id); } else reveal(part); });
            b.disabled = typeof ctx.select !== "function" && !canReveal(part);
            li.append(b, document.createTextNode(" " + describeMismatch(m).slice(m.ref.length + 1)));
            ul.append(li);
          }
          if (mm.length > 300) ul.append(el("li", "Showing 300 of " + mm.length + "."));
          box.append(ul);
        };
        if (mm.length) { if (box.open) fill(); else box.addEventListener("toggle", () => { if (box.open && box.childElementCount < 2) fill(); }); }
        notes.append(box);
      }
      if (collected.notes.length) {
        const box = section("notes"), ul = el("ul");
        box.append(el("summary", count(collected.notes.length, "note")));
        for (const n of collected.notes) ul.append(el("li", n));
        box.append(ul); notes.append(box);
      }
      notes.hidden = !notes.childElementCount || state.tab !== "lines";
    }

    // ---------------------------------------------------------- tabs
    function showTab(t) {
      state.tab = t === "optimise" && O ? "optimise" : "lines";
      const lines = state.tab === "lines";
      tabLines.setAttribute("aria-selected", String(lines)); tabOpt.setAttribute("aria-selected", String(!lines));
      tabLines.tabIndex = lines ? 0 : -1; tabOpt.tabIndex = lines ? -1 : 0;
      body.hidden = detail.hidden = !lines;
      for (const x of [search, dnpToggle, viewSelect.parentElement]) x.hidden = !lines;
      notes.hidden = !lines || !notes.childElementCount;
      if (!lines) {
        if (!optView) {
          optView = O.panel(ctx, {project: live, status, onApplied: () => recollect(), dismissed: dismissed || undefined,
            restore: id => restoreHint(id), text: {hidden: T("bom.hint.hidden"), restore: T("bom.hint.restore")}});
          optView.element.id = "bom-optimise";
          optView.element.setAttribute("role", "tabpanel"); optView.element.setAttribute("aria-labelledby", tabOpt.id);
          tabOpt.setAttribute("aria-controls", optView.element.id);
          d.insertBefore(optView.element, foot);
          optStale = true;
        }
        if (optStale) { optView.update(collected, analysisNow()); optStale = false; }
        optView.element.hidden = false;
      } else if (optView) optView.element.hidden = true;
      paintHintUI();
      exporter.textContent = lines ? "Export" : "Export optimised";
      remember();
      if (lines) requestAnimationFrame(() => paintRows());
    }

    sources(); paintVariants(); paintViews();
    variantSelect.onchange = () => { state.variant = variantSelect.value; recollect(); };
    sourceSelect.onchange = () => {
      const v = sourceSelect.value;
      if (v.startsWith("pcb:")) { state.source = "pcb"; state.board = v.slice(4); } else state.source = "schematic";
      recollect();
    };
    viewSelect.onchange = () => {
      state.viewName = viewSelect.value;
      Object.assign(state, viewState(state.viewName ? findView(live(), state.viewName) : prefsView()));
      search.value = state.query; paintVariants();
      recollect();
    };
    search.oninput = () => {
      state.query = search.value;
      designFilter?.controller.abort();
      designFilter = null;
      status.textContent = "";
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => { refilter(); paintSummary(); },90);
    };
    search.onkeydown = e => { if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); gridWrap.focus(); } };
    format.onchange = () => { state.format = format.value; remember(); };
    titleCheck.onchange = () => { state.titleBlock = titleCheck.checked; remember(); };
    const offQueryPrefs = globalThis.AtriumPrefs?.on("butter.query", () => { if (d.open) refilter(); });
    d.onclose = () => { clearTimeout(filterTimer); offQueryPrefs?.(); designFilter?.controller.abort(); cancelHints(); d.remove(); };
    d.oncancel = e => { if (editor) { e.preventDefault(); cancelEdit(); } else if (state.strip) { e.preventDefault(); closeStrip(true); } };
    globalThis.AtriumShell.adoptDialog(d, {title: heading, body, actions: foot, initialFocus: () => state.tab === "lines" ? gridWrap : tabOpt});
    document.body.append(d);
    d.showModal();
    recollect();
    setPanel(state.panelOpen);
    showTab(state.tab);
    (state.tab === "lines" ? gridWrap : tabOpt).focus({preventScroll: true});
    return d;
  }

  // Headless entry points for the optimiser (app/bom-optimiser.js), kept here so
  // automation needs only AtriumBOM. Both are DOM-free.
  function optimiser() {
    if (!globalThis.AtriumBOMOptimiser) throw Error("The BOM optimiser is unavailable in this build.");
    return AtriumBOMOptimiser;
  }
  const optimise = (project, options = {}) => optimiser().analyse(project, options);
  const applyOptimisation = (project, analysis, ids) => optimiser().apply(project, analysis, ids);

  return {open, collect, isDnp, optimise, applyOptimisation, columns, build, filterRows, queryMatches, rowHints, report, views, findView, saveView, deleteView, normaliseView, viewSettings,
    editable: editableKey, planEdit, applyChanges, tsv, field, statusText: STATUS_TEXT, compress, naturalCompare, csv, csvCell, xlsxFiles, xlsx, html, printable, fileName,
    defaults: {columns: defaultColumns, groupBy: defaultGroups}};
})();
