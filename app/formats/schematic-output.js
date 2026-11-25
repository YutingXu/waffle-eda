"use strict";
// Physical paper and document projection at the foreign export boundary. Drawing coordinates are
// mm, Y down. Altium's custom SchDoc workspace is 65 inches square (Altium Document Options);
// Eeschema's custom sheets span 1–120 inches on each axis (KiCad PAGE_INFO).
globalThis.AtriumSchematicOutput = (() => {
  const limits = {altium: {min: .254, max: 1651, step: .254, name: "Altium"}, kicad: {min: 25.4, max: 3048, step: .0001, name: "KiCad"}};
  const isFrame = i => i.kind === "textframe" && i.role === "frame";
  const fmt = v => +v.toFixed(4);
  const definitions = project => new Map(project.library.map(d => [d.id,d]));

  // Keep a whole-grid translation unless an exact-limit drawing needs all the available paper.
  function axis(lo, hi, target) {
    const start = Math.max(hi - target.max, Math.floor((lo - 5.08) / 1.27) * 1.27);
    const extent = Math.min(target.max, Math.max(target.min, hi - start + 5.08));
    return [fmt(start), fmt(Math.ceil(extent / target.step - 1e-8) * target.step)];
  }
  function measure(doc, defs, format) {
    const target = limits[format], appearance = globalThis.AtriumSchAppearance;
    const infinite = doc.sheet?.infinite === true;
    let left, top, width, height, fits;
    if (infinite) {
      const box = appearance?.drawingBounds?.(doc, defs) || Atrium.docBounds(doc, defs);
      [left,width] = axis(box[0], box[2], target);
      [top,height] = axis(box[1], box[3], target);
      fits = box[2] - box[0] <= target.max + 1e-7 && box[3] - box[1] <= target.max + 1e-7;
    } else {
      const native = !doc.sourceName && !doc.sheetOrigin;
      const saved = doc.schDrawing || doc.schRestored?.sheet || ((native || doc.sheet?.size) && appearance?.sheetOf(doc));
      // Older imports with no saved paper dimensions keep the writers' drawing-based layout.
      if (!saved) return null;
      ({width, height} = saved);
      const kicad = doc.sheetOrigin === "top-left" || /\.kicad_sch$/i.test(doc.sourceName || "");
      const imported = doc.sheetOrigin === "bottom-left" || !!doc.sourceName;
      left = imported || kicad ? 0 : -12.7;
      top = kicad ? 0 : imported ? -height : -12.7;
      fits = width <= target.max && height <= target.max && width >= target.min && height >= target.min;
    }
    return {doc:doc.id, infinite, left, top, width:fmt(width), height:fmt(height), fits,
      note:(infinite ? "Fit the infinite drawing to custom paper" : "Retained the fixed sheet size") + " (" + fmt(width) + " × " + fmt(height) + " mm)."};
  }
  function problem(doc, format) {
    const t = limits[format];
    return "“" + doc.name + "” exceeds " + t.name + "’s " + t.max + " mm page limit. " +
      (doc.items.some(isFrame) ? "Choose One sheet per frame to export the hierarchy." : "Add named frames to export it as several sheets.");
  }
  function page(doc, defs, format) {
    const result = measure(doc, defs, format);
    if (result && !result.fits) throw Error(result.infinite ? problem(doc,format) :
      "The fixed paper on “" + doc.name + "” is outside " + limits[format].name + "’s supported page sizes.");
    return result;
  }
  function oversized(project, format, documentId) {
    const defs = definitions(project);
    return project.documents.filter(d => d.kind === "schematic" && d.sheet?.infinite === true && (!documentId || d.id === documentId) && !measure(d,defs,format).fits);
  }

  // Compact only empty coordinate bands on the transient overview. A monotone map on each axis
  // preserves contacts and crossings, including diagonal wires split at changes of slope.
  function compact(doc, defs, symbols) {
    const intervals = [[],[]], SO = globalThis.AtriumSchObjects;
    const protect = (p,q = p) => { for (let k=0;k<2;k++) intervals[k].push([Math.min(p[k],q[k]),Math.max(p[k],q[k])]); };
    for (const i of doc.items) {
      if (i.kind === "wire" || i.kind === "bus") { for (const p of i.points) protect(p); }
      else if (symbols.has(i.id)) {
        protect([i.x,i.y], [i.x+Math.min(i.w,30.48),i.y+Math.min(i.h,12.7)]);
        protect([i.x+i.w,i.y+i.h]);
        for (const e of i.entries || []) { const [x,y] = SO.entryPoint(i,e); protect([x-1.27,y-1.27],[x+1.27,y+1.27]); }
      } else {
        const box = Atrium.bounds(Atrium.itemPoints(i,defs.get(i.def),"schematic"));
        if (box) protect(box.slice(0,2),box.slice(2));
      }
    }
    function projection(ranges) {
      let end = -Infinity, removed = 0;
      const bands = [];
      for (const [a,b] of ranges.sort((x,y) => x[0]-y[0])) {
        if (end !== -Infinity && a-end > 10.16) {
          bands.push({start:end,end:a,removed});
          removed += a-end-10.16;
        }
        end = Math.max(end,b);
      }
      return {cuts:bands.flatMap(b => [b.start,b.end]), at(value) {
        let lo=0, hi=bands.length;
        while (lo < hi) { const mid = (lo+hi) >>> 1; if (bands[mid].end <= value) lo = mid+1; else hi = mid; }
        const b = bands[lo];
        if (!b) return fmt(value-removed);
        if (value <= b.start) return fmt(value-b.removed);
        return fmt(b.start-b.removed + (value-b.start)*10.16/(b.end-b.start));
      }};
    }
    const axes = intervals.map(projection), point = p => [axes[0].at(p[0]),axes[1].at(p[1])];
    function line(points) {
      const out = [point(points[0])];
      for (let j=1;j<points.length;j++) {
        const a = points[j-1], b = points[j], dx=b[0]-a[0], dy=b[1]-a[1];
        if (dx && dy) {
          const cuts = new Set();
          for (let k=0;k<2;k++) for (const v of axes[k].cuts) {
            const t = (v-a[k])/(b[k]-a[k]); if (t>0 && t<1) cuts.add(t);
          }
          for (const t of [...cuts].sort((u,v)=>u-v)) out.push(point([a[0]+dx*t,a[1]+dy*t]));
        }
        out.push(point(b));
      }
      return out;
    }
    return {...doc, items:doc.items.map(i => {
      if (i.kind === "imageMarkup") return i;
      if (i.points?.length) return {...i, points:line(i.points)};
      const [x,y] = point([i.x,i.y]);
      if (!symbols.has(i.id)) return {...i,x,y};
      const [r,b] = point([i.x+i.w,i.y+i.h]);
      const entries = (i.entries || []).map(e => {
        const [ex,ey] = point(SO.entryPoint(i,e));
        return {...e,offset:fmt(e.side === "top" || e.side === "bottom" ? ex-x : ey-y)};
      });
      return {...i,x,y,w:fmt(r-x),h:fmt(b-y),entries};
    })};
  }
  function prepare(original, format, options = {}) {
    const large = oversized(original,format,options.documentId), choices = [];
    if (!large.length) return {project:original,choices};
    if (options.pageMode !== "frames") throw Error(problem(large[0],format));
    const conversion = globalThis.AtriumFrameConversion, hierarchy = globalThis.AtriumHierarchy;
    if (!conversion || !hierarchy) throw Error("Frame conversion is required to build the export hierarchy.");
    // Conversion may also relink channel footprints and references to moved schematic objects.
    // Take the complete transient project only after the user chose to split an oversized sheet.
    const project = Atrium.clone(original), defs = definitions(project);
    const before = hierarchy.compile(original), scope = before.effective;
    if (before.scope === "automatic") {
      const rule = project.rules?.list?.find(r => r.type === "ercNetScope" && r.enabled !== false);
      if (rule) rule.netScope = scope;
    }
    const ids = new Set(project.documents.flatMap(d => [d.id,...d.items.map(i => i.id)]));
    let counter = 0;
    const makeId = () => { let id; do { id = "frame-output-"+ ++counter; } while (ids.has(id)); ids.add(id); return id; };
    const filename = n => String(n).normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f]/g,"-").trim().toLowerCase();
    const names = new Set([project.name,...project.documents.map(d => d.name)].map(filename));
    for (const source of large) {
      // Convert inner frames first so their new sheet symbols travel with an enclosing frame.
      const frames = source.items.filter(isFrame).sort((a,b)=>a.w*a.h-b.w*b.h), symbols = new Set(), linked = [];
      if (!frames.length) throw Error(problem(source,format));
      for (const frame of frames) {
        if (frame.w > limits[format].max || frame.h > limits[format].max) throw Error("Frame “"+frame.text+"” itself exceeds the page limit. Divide it into smaller frames.");
        const plan = conversion.plan(project,source.id,frame.id,{scope,makeId});
        const base = String(frame.text || "Frame").trim() || "Frame";
        let name = base, n = 1;
        while (names.has(filename(name))) name = base+" ("+ ++n+")";
        names.add(filename(name)); plan.apply(project);
        const child = project.documents.find(d => d.id === plan.child.id);
        child.name = name; child.sheet = {...child.sheet,infinite:true,titleBlock:"none"};
        page(child,defs,format);
        symbols.add(plan.symbol.id); linked.push({frame:frame.id, name, document:child.id,moved:plan.moved});
      }
      const ix = project.documents.findIndex(d => d.id === source.id);
      project.documents[ix] = compact(project.documents[ix],defs,symbols);
      if (!measure(project.documents[ix],defs,format).fits) throw Error("Unframed artwork on “"+source.name+"” still exceeds the "+limits[format].name+" page limit. Enclose it in another frame.");
      choices.push({document:source.id,frames:linked,note:"Exported “"+source.name+"” as one sheet per frame: "+linked.map(f=>f.name).join(", ")+", with a parent sheet for connections."});
    }
    const pinGroups = graph => graph.nets.filter(n => n.pins.length).map(n => JSON.stringify([n.name,
      n.pins.map(p => JSON.stringify([p.ref,p.part.id,p.pin.number])).sort()])).sort();
    const previous = pinGroups(before), current = pinGroups(hierarchy.compile(project,{scope}));
    if (previous.length !== current.length || previous.some((v,n)=>v!==current[n]))
      throw Error("The frame layout would change schematic connectivity. Adjust the frame edges and retry.");
    return {project, choices};
  }
  return Object.freeze({limits,measure,page,oversized,prepare});
})();
