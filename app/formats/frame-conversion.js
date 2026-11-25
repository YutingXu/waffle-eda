"use strict";
// Partition a real sheet on a transient project, compile both circuits, then install the
// verified document pair in one editor edit. No model state or undo entries are made by plan().
globalThis.AtriumFrameConversion = (() => {
  const A = Atrium, S = AtriumSchObjects, H = AtriumHierarchy;
  const point = i => [i.x, i.y], equal = (a, b) => A.pointKey(a) === A.pointKey(b);
  const tolerance = .00011; // hierarchy.local's segment-contact tolerance, in mm
  const inside = ([x,y], [l,t,r,b]) => x >= l && x <= r && y >= t && y <= b;
  const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
  const interpolate = (a,b,t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
  const distinct = values => [...new Set(values)];

  // Split a polyline in traversal order (including outside-to-outside and re-entry).
  // Keep original vertices exact. A tangent that just touches a corner stays on its sheet.
  function splitPath(points, box) {
    const runs = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i-1], b = points[i], dx = b[0]-a[0], dy = b[1]-a[1];
      if (!dx && !dy) continue;
      const ts = [0,1];
      for (const [axis, delta] of [[0,dx],[1,dy]]) if (delta) {
        for (const bound of [box[axis],box[axis+2]]) {
          const t = (bound-a[axis])/delta, other = a[1-axis]+(b[1-axis]-a[1-axis])*t;
          if (t > 0 && t < 1 && other >= box[1-axis]-1e-9 && other <= box[3-axis]+1e-9) ts.push(t);
        }
      }
      ts.sort((x,y) => x-y);
      for (let j = 1; j < ts.length; j++) {
        const from = ts[j-1], to = ts[j];
        if (to-from < 1e-12) continue;
        const side = inside(interpolate(a,b,(from+to)/2), box) ? "child" : "parent";
        const first = from === 0 ? a : interpolate(a,b,from), last = to === 1 ? b : interpolate(a,b,to);
        if (runs.at(-1)?.side === side) runs.at(-1).points.push(last);
        else runs.push({side, points:[first,last]});
      }
    }
    return runs.length ? runs : [{side:inside(points[0],box) ? "child" : "parent", points}];
  }

  function entrySide(symbol, at) {
    const {x,y,w,h} = symbol, [px,py] = at;
    return [{side:"left", offset:clamp(py-y,0,h), d:Math.abs(px-x)}, {side:"right", offset:clamp(py-y,0,h), d:Math.abs(px-x-w)},
      {side:"top", offset:clamp(px-x,0,w), d:Math.abs(py-y)}, {side:"bottom", offset:clamp(px-x,0,w), d:Math.abs(py-y-h)}].sort((a,b) => a.d-b.d)[0];
  }

  function direction(pins, otherPins) {
    const roles = list => new Set(list.map(c => globalThis.AtriumERC?.pinType(c.pin) ?? c.pin.electrical).map(t =>
      [2,3,6].includes(t) ? "output" : t === 0 ? "input" : t === 1 ? "bidirectional" : t === 4 ? "passive" : "unknown"));
    const own = roles(pins), outside = roles(otherPins);
    own.delete("passive");
    if (own.has("unknown") || !own.size) return "unspecified";
    if (own.has("bidirectional")) return own.size === 1 ? "bidirectional" : "unspecified";
    if (own.has("output")) return outside.has("output") || outside.has("bidirectional") ? "unspecified" : "output";
    return "input";
  }

  function interfaceGroup() {return {parent:[], child:[], cuts:[], relays:[], virtual:{parent:[],child:[]}};}
  const anchor = (group, side, at) => group[side].push(at);
  function uniqueName(name, used) {
    if (!used.has(name)) return name;
    for (let n = 2; ; n++) if (!used.has(name+"_"+n)) return name+"_"+n;
  }

  // Fingerprint every pre-existing connected item, not just annotated component pins.
  // The sole new, non-repeating symbol can be removed from the *instance path* when
  // comparing a conversion. All other ancestors (including same-named channels) remain.
  function endpoints(compiled, original, fragmentIds = new Map(), wrapper = null) {
    const paths = instancePaths(compiled,wrapper), result = new Map();
    for (const net of compiled.nets) for (const {inst,net:g} of net.local) {
      const add = (kind, id, sub, ref) => {
        const base = fragmentIds.get(id) || id;
        if (!original.has(base)) return;
        const key = JSON.stringify([paths.get(inst),kind,base,sub,ref]);
        if (result.has(key) && result.get(key) !== net) throw Error("The conversion separates two pieces of "+net.name+".");
        result.set(key, net);
      };
      for (const c of g.pins) add("pin",c.i.id,String(c.pin.number),inst.designator ? inst.designator(c.i) : c.i.ref+inst.suffix);
      for (const w of g.wires) add("wire",w.id);
      for (const s of g.sources) if (s.item.kind !== "wire") add("name",s.item.id);
      for (const e of g.entries) if (e.symbol.id !== wrapper) add("entry",e.symbol.id,e.entry.id);
    }
    return result;
  }
  function instancePaths(compiled, wrapper) {
    const paths = new Map();
    for (const inst of compiled.instances) paths.set(inst, inst.parent ?
      inst.symbol.id === wrapper ? paths.get(inst.parent) : [...paths.get(inst.parent),[inst.symbol.id,inst.channel?.index ?? null]] : [inst.doc.id]);
    return paths;
  }
  function corresponding(before, after) {
    const forward = new Map(), reverse = new Map();
    for (const [key,old] of before) {
      const next = after.get(key);
      if (!next || (forward.has(old) && forward.get(old) !== next)) throw Error("The conversion would disconnect "+old.name+".");
      if (reverse.has(next) && reverse.get(next) !== old) throw Error("The conversion would join "+old.name+" to "+reverse.get(next).name+".");
      forward.set(old,next); reverse.set(next,old);
    }
    for (const [key,net] of after) if (!before.has(key)) throw Error("The conversion would connect a previously unused pin to "+net.name+".");
    return forward;
  }

  function prepare(project, docId, frameId) {
    const doc = project.documents.find(d => d.id === docId), frame = doc?.items.find(i => i.id === frameId);
    if (doc?.kind !== "schematic" || !S.isFrame(frame)) throw Error("Choose a frame on a schematic sheet.");
    const defs = new Map(project.library.map(d => [d.id,d])), locals = new Map();
    const local = (doc, build) => {if (!locals.has(doc)) locals.set(doc,build()); return locals.get(doc);};
    const before = H.compile(project, {defs,local}), loc = locals.get(doc);
    const original = new Set(project.documents.filter(d => d.kind === "schematic").flatMap(d => d.items.map(i => i.id)));
    const names = new Map(), instances = new Map();
    for (const n of before.nets) {
      for (const name of distinct([n.name,...n.names])) {
        if (!names.has(name)) names.set(name,new Set());
        names.get(name).add(n);
      }
      for (const {inst,net} of n.local) if (inst.doc === doc) {
        if (!instances.has(net)) instances.set(net,[]);
        instances.get(net).push({inst,n});
      }
    }
    const contained = new Set(S.frameContents(doc,frame,defs));
    const images = new Set([...contained].filter(i=>i.kind==="image").map(i=>i.id));
    if (images.size) for (const item of doc.items) {
      if (item.kind==="imageMarkup" && images.has(item.imageId)) contained.add(item);
    }
    return {doc,frame,defs,loc,local,contained,before,names,instances,original,prior:endpoints(before,original)};
  }

  function assemble(project, data, scope, makeId = A.id) {
    const label = (at,text) => ({kind:"netlabel",id:makeId(),x:at[0],y:at[1],text});
    const make = (kind,at,opts) => {
      const i = S.make(kind,at,opts);
      if (makeId !== A.id) i.id = makeId();
      return i;
    };
    const {doc,frame,defs,loc,local,contained,before,names,instances,original,prior} = data;
    const box = S.frameBounds(frame), title = frame.text.trim() || "Sheet";
    const child = A.sheet("schematic",uniqueName(title,new Set(project.documents.map(d => d.name))));
    if (makeId !== A.id) child.id = makeId();
    child.grid = doc.grid;
    if (doc.hopOvers) child.hopOvers = true;
    if (doc.sheet) child.sheet = A.clone(doc.sheet);
    const page = globalThis.AtriumSchAppearance?.pageBounds?.(child);
    if (doc.sheet?.infinite || !page || !inside(box.slice(0,2),page) || !inside(box.slice(2),page) || doc.schRestored)
      child.sheet = {...child.sheet,infinite:true,titleBlock:"none"};
    const symbol = S.make("sheetsymbol",box.slice(0,2),{name:child.name,sheet:child.id,w:box[2]-box[0],h:box[3]-box[1]});
    symbol.id = frame.id;
    // A frame title is free text. It cannot implicitly turn this wrapper into a channel array.
    if (S.repeatOf(symbol)) symbol.name = "Sheet "+symbol.name;
    const parent = {...doc,items:[]}, sides = {parent,child}, fragmentIds = new Map(), moved = new Set();
    const groups = new Map(), wireGroup = new Map(), occupied = [];
    const segment = (at,a,b) => at[0] >= Math.min(a[0],b[0])-tolerance && at[0] <= Math.max(a[0],b[0])+tolerance &&
      at[1] >= Math.min(a[1],b[1])-tolerance && at[1] <= Math.max(a[1],b[1])+tolerance && A.nearSegment(at,a,b)<tolerance;
    for (const g of loc.nets) {
      const rec = interfaceGroup(); groups.set(g,rec);
      const add = (item, at) => anchor(rec,contained.has(item) ? "child" : "parent",at);
      for (const c of g.pins) add(c.i,c.pin.at);
      for (const s of g.sources) if (s.item.kind !== "wire") {
        add(s.item,point(s.item));
        if (contained.has(s.item) && ["port","offsheet"].includes(s.type) && scope === "hierarchical") rec.relays.push(s);
      }
      for (const e of g.entries) add(e.symbol,S.entryPoint(e.symbol,e.entry));
      for (const w of g.wires) {
        wireGroup.set(w,g);
        for (let k=1;k<w.points.length;k++) occupied.push({g,a:w.points[k-1],b:w.points[k]});
      }
    }
    const ownedPoint = (at, group) => {
      const index = loc.netOfKey(A.pointKey(at));
      return (index === undefined || loc.nets[index] === group) && !occupied.some(s => s.g !== group && segment(at,s.a,s.b));
    };

    const busGroup = new Map(), busGroups = [];
    for (const bus of S.busNetworks(doc,{includeUnnamed:true})) {
      const rec = {...interfaceGroup(),bus}; busGroups.push(rec);
      for (const i of bus.buses) busGroup.set(i,rec);
      for (const n of bus.names) {
        const at = n.entry ? S.entryPoint(n.item,n.entry) : point(n.item);
        anchor(rec,contained.has(n.item) ? "child" : "parent",at);
        if (contained.has(n.item) && !n.entry && ["port","offsheet"].includes(H.sourceType(n.item)) && scope === "hierarchical")
          rec.relays.push({type:H.sourceType(n.item),name:n.name});
      }
    }
    // A bus port or entry can identify members without a drawn bus. Repeat(SIG)
    // likewise binds a different named member on the containing sheet per channel.
    for (const b of loc.buses) {
      const item = b.item || b.symbol, side = contained.has(item) ? "child" : "parent";
      const at = b.entry ? S.entryPoint(item,b.entry) : point(item);
      const repeat = S.repeatEntry(b.name);
      if (repeat) {
        for (const childInst of before.instances.filter(i => i.symbol === item)) {
          const name = repeat+(childInst.channel?.number ?? "");
          const rec = groups.get(loc.nets[loc.netNamed.get(name)]);
          if (rec) rec.virtual[side].push({at,name});
        }
      } else if (!busGroups.some(r => r.bus.names.some(n => n.item === item && n.entry === b.entry))) {
        const rec = {...interfaceGroup(),bus:{names:[{item,name:b.name,entry:b.entry}],buses:[]}};
        anchor(rec,side,at);
        if (side === "child" && scope === "hierarchical" && ["port","offsheet"].includes(b.type)) rec.relays.push({type:b.type,name:b.name});
        busGroups.push(rec);
      }
    }
    for (const i of doc.items) {
      if (i === frame) {parent.items.push(symbol); continue;}
      if (i.kind === "busentry") {
        const ends = S.hotspots(i);
        const busAt = p => busGroups.find(r => r.bus.buses.some(b => b.points.some((v,n) => n && segment(p,b.points[n-1],v))));
        const atWire = p => loc.nets[loc.netOfKey(A.pointKey(p))] || occupied.find(s => segment(p,s.a,s.b))?.g;
        const busEnd = ends.findIndex((p,k) => busAt(p) && atWire(ends[1-k]));
        if (busEnd >= 0) {
          const bus = busAt(ends[busEnd]), tip = ends[1-busEnd], g = atWire(tip), rec = groups.get(g);
          const runs = splitPath(ends,box), busRun = busEnd ? runs.at(-1) : runs[0];
          anchor(bus,busRun.side,ends[busEnd]);
          if (g.names.length) (bus.tapNames ||= new Set()).add(g.names[0]);
          if (runs.length === 2) {
            // Keep the diagonal glyph on its actual bus. The member wire takes the
            // remainder of its old diagonal, so both ends still terminate on real copper.
            const at = runs[1].points[0], wireSide = runs[1-busEnd].side;
            const fraction = Math.hypot(at[0]-ends[busEnd][0],at[1]-ends[busEnd][1]) / Math.hypot(ends[1][0]-ends[0][0],ends[1][1]-ends[0][1]);
            const start = busEnd ? at : ends[0];
            sides[busRun.side].items.push({...i,x:start[0],y:start[1],size:(i.size || 2.54)*fraction});
            if (busRun.side === "child") moved.add(i.id);
            sides[wireSide].items.push({kind:"wire",id:makeId(),points:[at,tip]});
            anchor(rec,busRun.side,at); anchor(rec,wireSide,tip);
            rec.cuts.push({edge:at,parent:at,child:at});
            continue;
          }
          anchor(rec,contained.has(i) ? "child" : "parent",tip);
        }
      }
      if (!["wire","bus"].includes(i.kind) || i.points.length < 2) {
        if (contained.has(i)) {child.items.push(i); moved.add(i.id);} else parent.items.push(i);
        continue;
      }
      const g = wireGroup.get(i), rec = i.kind === "bus" ? busGroup.get(i) : groups.get(g);
      const runs = splitPath(i.points,box);
      for (let k=1;k<runs.length;k++) {
        const a = runs[k-1], b = runs[k], at = b.points[0];
        // Introducing a vertex at a bare crossing would short two nets. Leave short
        // visible gaps there and name each end on its own conductor instead.
        if (rec && !ownedPoint(at,g)) {
          const back = a.points.at(-2), next = b.points[1];
          const retreat = q => interpolate(at,q,Math.min(.2,.25/Math.hypot(q[0]-at[0],q[1]-at[1])));
          a.points[a.points.length-1] = retreat(back); b.points[0] = retreat(next);
        }
        rec?.cuts.push({edge:at,[a.side]:a.points.at(-1),[b.side]:b.points[0]});
      }
      for (const [k,run] of runs.entries()) {
        const piece = runs.length === 1 ? i : {...i,id:k ? makeId() : i.id,points:run.points};
        sides[run.side].items.push(piece);
        if (run.side === "child" && piece.id === i.id) moved.add(i.id);
        if (piece.id !== i.id) fragmentIds.set(piece.id,i.id);
        if (rec) anchor(rec,run.side,run.points[0]);
      }
    }

    // Use an actual crossing when possible. For a name-only link select a free border
    // position, keeping distinct nets apart even on sub-grid and very small frames.
    const usedPoints = new Set();
    function placeEntry(name, io, rec, group) {
      const usable = at => !usedPoints.has(A.pointKey(at)) && ownedPoint(at,group);
      const preferred = [...rec.cuts.map(c => c.edge),...rec.child,...rec.parent];
      const sides = ["left","right","top","bottom"];
      for (let index=0;index<preferred.length+sides.length*257;index++) {
        let e;
        if (index < preferred.length) e = entrySide(symbol,preferred[index]);
        else {
          const pos=index-preferred.length, side=sides[pos%4], span=["left","right"].includes(side) ? symbol.h : symbol.w;
          e={side,offset:span*(Math.floor(pos/4)+.5)/257};
        }
        const at = S.entryPoint(symbol,e);
        if (!usable(at)) continue;
        const entry = {id:makeId(),name,side:e.side,offset:e.offset,io};
        symbol.entries.push(entry); usedPoints.add(A.pointKey(at));
        return {at,entry};
      }
      throw Error("The frame border has no free connection point for "+name+".");
    }

    // Pre-interface topology: a cut net can have several disconnected islands on
    // either sheet. Attach each exactly once; bare intersections remain unjoined.
    const localChild = H.local(child,defs), localParent = H.local(parent,defs);
    const localOf = {child:localChild,parent:localParent};
    const islands = (side,points) => {
      const seen = new Set(), list = [];
      for (const at of points) {
        const index = localOf[side].netOfKey(A.pointKey(at));
        const k = index ?? A.pointKey(at);
        if (!seen.has(k)) {list.push({at,index}); seen.add(k);}
      }
      return list;
    };
    const drawings = {parent:S.busNetworks(parent,{includeUnnamed:true}),child:S.busNetworks(child,{includeUnnamed:true})};
    const allNames = new Set(names.keys());
    const usedEntries = new Set();
    for (const rec of busGroups) {
      // Members are defined by the connected bus identifiers, not by the number of
      // nearby wires. Preserve vector and group spellings and their index/name aliases.
      const spellings = distinct(rec.bus.names.map(n => n.name));
      const tapNames = [...(rec.tapNames || [])];
      const base = spellings[0] || (tapNames.length && tapNames.every(n => /^[^\s{},]+$/.test(n)) ? "{"+tapNames.join(" ")+"}" : uniqueName("Bus",allNames));
      const memberPins = distinct([...spellings,base].flatMap(n => S.busMembers(n)).map(m => loc.nets[loc.netNamed.get(m)]).filter(Boolean));
      const joinsMembers = spellings.length > 1 || rec.bus.names.some(n => n.entry || ["port","offsheet"].includes(H.sourceType(n.item)));
      if (joinsMembers) for (const g of memberPins) for (const side of ["parent","child"]) {
        const pts = groups.get(g)[side];
        if (pts.length && !rec[side].length) anchor(rec,side,pts[0]);
      }
      if (!(rec.child.length && rec.parent.length || rec.relays.length)) continue;
      const versions = new Set(memberPins.flatMap(g => (instances.get(g) || []).map(v => v.n)));
      const collision = scope !== "hierarchical" && S.busMembers(base).some(m => [...(names.get(m) || [])].some(n => !versions.has(n)));
      const prefix = title.replace(/[^\p{L}\p{N}_]/gu,"_");
      let name = base;
      if (collision || usedEntries.has(name)) {
        let i=0;
        do {name=prefix+"_"+(++i===1 ? "" : i+"_")+base;} while (allNames.has(name) || S.busMembers(name).some(m => allNames.has(m)));
      }
      allNames.add(name); usedEntries.add(name);
      const directions = distinct(memberPins.map(g => direction(g.pins.filter(c => contained.has(c.i)),g.pins.filter(c => !contained.has(c.i)))));
      const io = directions.length === 1 ? directions[0] : "unspecified";
      const {at,entry} = placeEntry(name,io,rec);
      const oldPort = rec.bus.names.find(n => n.name === name && contained.has(n.item) && H.sourceType(n.item) === "port");
      const insideAt = rec.cuts.find(c => equal(c.edge,at))?.child || (oldPort ? point(oldPort.item) : at);
      if (!oldPort || !equal(point(oldPort.item),insideAt)) child.items.push(make("port",insideAt,{text:name,io,angle:(S.entryAngle(entry.side)+180)%360}));
      if (scope === "flat") parent.items.push(make("port",at,{text:name,io,angle:(S.entryAngle(entry.side)+180)%360}));
      // Carry aliases once per surviving connected bus drawing. Do not repeat an
      // identifier already on that drawing or stack labels at every cut or vertex.
      const originals = new Set(rec.bus.buses.map(b => b.id));
      for (const side of ["parent","child"]) for (const drawn of drawings[side]) {
        if (!drawn.buses.some(b => originals.has(fragmentIds.get(b.id) || b.id))) continue;
        const present = new Set(drawn.names.map(n => n.name));
        const contact = side === "child" ? insideAt : at;
        const onBus = p => drawn.buses.some(b => b.points.some((q,k) => k && segment(p,b.points[k-1],q)));
        if (onBus(contact)) present.add(name);
        const missing = distinct([name,...spellings]).filter(n => !present.has(n));
        for (let n=0;n<missing.length;n++) {
          const path=drawn.buses[0].points;
          sides[side].items.push(label(interpolate(path[0],path[1],(n+1)/(missing.length+1)),missing[n]));
        }
      }
      // With no bus drawing a flat alias still has to name each real member wire.
      if (name !== base) for (const [oldMember,newMember] of S.busAlias(base,name)) {
        const g = groups.get(loc.nets[loc.netNamed.get(oldMember)]);
        if (g) for (const side of ["parent","child"]) if (g[side].length) sides[side].items.push(label(g[side][0],newMember));
      }
      for (const r of rec.relays) parent.items.push(make(r.type,at,{text:r.name,io}));
    }

    for (const [g,rec] of groups) {
      if (!rec.child.length && !rec.virtual.child.length) continue;
      const versions = instances.get(g) || [], first = versions[0];
      if (!first) continue;
      const external = versions.some(({inst,n}) => n.local.some(l => l.inst !== inst) && g.sources.some(s => contained.has(s.item)));
      if (!rec.parent.length && !rec.virtual.parent.length && !rec.relays.length && !external) continue;
      const base = first.n.candidates.find(c => c.inst === first.inst && g.names.includes(c.name))?.name || g.names[0] || first.n.name;
      const collision = scope !== "hierarchical" && [...(names.get(base) || [])].some(n => !versions.some(v => v.n === n));
      const name = !collision && !usedEntries.has(base) && !S.isBus(base) && !S.repeatEntry(base) ? base :
        uniqueName((title+"_"+base).replace(/[^\p{L}\p{N}_.-]/gu,"_"),allNames);
      allNames.add(name); usedEntries.add(name);
      const io = direction(g.pins.filter(c => contained.has(c.i)),first.n.pins.filter(c => c.doc !== doc || !contained.has(c.part)));
      const {at,entry} = placeEntry(name,io,rec,g);
      const port = g.sources.find(s => s.type === "port" && s.name === name && contained.has(s.item));
      const childAt = rec.cuts.find(c => equal(c.edge,at))?.child || rec.cuts[0]?.child || (port ? point(port.item) : at);
      const angle = (S.entryAngle(entry.side)+180)%360;
      const existing = port && equal(point(port.item),childAt);
      if (!existing) child.items.push(make("port",childAt,{text:name,io,angle}));
      if (scope === "flat") parent.items.push(make("port",at,{text:name,io,angle}));
      for (const [side,term] of [["parent",at],["child",childAt]]) for (const v of rec.virtual[side])
        if (side === "parent" || v.name !== name) sides[side].items.push(label(term,v.name));
      for (const r of rec.relays) {
        if (!parent.items.some(i => H.sourceType(i) === r.type && i.text === r.name && equal(point(i),at)))
          parent.items.push(make(r.type,at,{text:r.name,io:r.item.io || io,angle}));
      }
      for (const [side,term] of [["child",childAt],["parent",at]]) {
        const locSide = localOf[side];
        const nodes = islands(side,[...rec.cuts.map(c => c[side]),...rec[side]]);
        const home = locSide.netOfKey(A.pointKey(term));
        // If the entry lands mid-segment the pre-interface local graph has no node there.
        const connected = n => equal(n.at,term) || home !== undefined && n.index === home ||
          n.index !== undefined && locSide.nets[n.index].wires.some(w => w.points.some((p,k) => k && segment(term,w.points[k-1],p)));
        const others = nodes.filter(n => !connected(n));
        if (others.length) {
          if (side === "parent" && scope !== "flat") parent.items.push(label(at,name));
          for (const n of others) if (!locSide.nets[n.index]?.names.includes(name)) sides[side].items.push(label(n.at,name));
        }
      }
    }

    // Compile the actual edited graph, including untouched sheets and all instances.
    // Restore a displaced auto-name or duplicate-name suffix with a visible native net
    // label, only after proving the physical net partition already matches exactly.
    const draft = {...project,documents:project.documents.flatMap(d => d === doc ? [parent,child] : [d])};
    let verified;
    const verify = () => {
      const compileLocal = (d,build) => d === parent || d === child ? build() : local(d,build);
      verified = H.compile(draft,{scope,defs,local:compileLocal});
      const links = corresponding(prior,endpoints(verified,original,fragmentIds,symbol.id));
      return [...links].filter(([old,next]) => old.name !== next.name);
    };
    const renamed = verify();
    for (const [old,next] of renamed) {
      if (preserveChannelAutoName(old,next,parent,child,original,label)) continue;
      const here = next.local.find(l => l.inst.doc === parent || l.inst.doc === child);
      // Another net can temporarily take an untouched net's name. Restoring the
      // original name on the edited circuit also restores that unrelated net.
      if (!here) continue;
      const {net:g,inst} = here;
      const at = g.pins[0]?.pin.at || g.wires[0]?.points[0] || (g.sources[0] ? point(g.sources[0].item) : S.entryPoint(g.entries[0].symbol,g.entries[0].entry));
      const suffix = inst.suffix && (scope !== "global" || inst.channelScope) ? inst.suffix : "";
      const text = suffix && old.name.endsWith(suffix) ? old.name.slice(0,-suffix.length) : old.name;
      const existing = inst.doc.items.find(i => i.kind === "netlabel" && i.text === text && equal(point(i),at));
      if (existing) inst.doc.items.splice(inst.doc.items.indexOf(existing),1);
      inst.doc.items.unshift(existing || label(at,text));
    }
    if (renamed.length) {
      const remaining = verify();
      if (remaining.length) throw Error("The conversion would rename "+remaining[0][0].name+" to "+remaining[0][1].name+".");
    }
    preserveAppearance(doc,child);
    const references = channelReferences(before,verified,symbol.id,doc.id,moved);
    const itemOrder = doc.items.slice(), geometry = [frame.x,frame.y,frame.w,frame.h,frame.text];
    return {docId:doc.id,frameId:frame.id,parent,child,symbol,moved:[...moved],effective:scope,
      apply(target) {
        const current = target.documents.find(d => d.id === doc.id);
        if (current !== doc || current.items.length !== itemOrder.length || itemOrder.some((item,k) => current.items[k] !== item) ||
            [frame.x,frame.y,frame.w,frame.h,frame.text].some((v,k) => geometry[k] !== v) || target.documents.some(d => d.id === child.id))
          throw Error("The frame changed. Open its context menu again.");
        const needs=notebookNeeds(target), notebook=globalThis.AtriumNotebook, calculations=globalThis.AtriumCalculations;
        if (needs.notes && !notebook?.moveBindings || needs.calculations && !calculations?.syncRules)
          throw Error("Load notebook bindings before converting a frame containing design references.");
        const idx = target.documents.indexOf(current);
        current.items = parent.items;
        target.documents.splice(idx+1,0,child);
        moveReferences(target,current.id,child.id,moved,references);
        if (needs.notes) notebook.moveBindings(target,current.id,child.id,moved,references.instances);
        if (needs.calculations) calculations.syncRules(target);
      }};
  }

  // Ordinary label text suffices on a single sheet instance. Per-channel names
  // can embed the physical designator in the middle of the string. Capture its
  // actual origin only when a proven unchanged, originally unnamed net needs it.
  function preserveChannelAutoName(old, next, parent, child, original, label) {
    if (old.candidates.length || !next.local.some(l => l.inst.suffix)) return false;
    const source = old.pins.find(p => old.name === "Net-"+p.ref+"-"+p.pin.number || old.name === "Net"+p.ref+"_"+p.pin.number);
    if (!source) return false;
    const pin = next.pins.find(p => p.part.id === source.part.id && p.ref === source.ref &&
      p.pin.number === source.pin.number && (p.doc === parent || p.doc === child));
    if (!pin) return false;
    const style = old.name === "Net-"+pin.ref+"-"+pin.pin.number ? "hyphen" : "underscore";
    const hint = {part:pin.part.id,pin:String(pin.pin.number),style};
    const fallback = next.candidates[0]?.name || (style === "hyphen" ? "Net-"+pin.part.ref+"-"+hint.pin : "Net"+pin.part.ref+"_"+hint.pin);
    for (const {net:g,inst} of next.local) if (inst.doc === parent || inst.doc === child) {
      for (const s of g.sources) if (s.type === "label" && s.item.kind === "netlabel" && s.name === fallback && !original.has(s.item.id)) s.item.autoName = hint;
    }
    if (!pin.doc.items.some(i => i.autoName?.part === hint.part && i.autoName.pin === hint.pin && equal(point(i),pin.pin.at)))
      pin.doc.items.unshift({...label(pin.pin.at,fallback),autoName:hint});
    return true;
  }

  function preserveAppearance(doc,child) {
    if (!doc.schRestored) return;
    const {sheet,items,definitions} = doc.schRestored, styles = {}, defs = {};
    for (const i of child.items) {
      if (!i.schSource) continue;
      const k = i.schSource.record+":"+i.schSource.role, style = items[k];
      if (!style) continue;
      styles[k] = style;
      if (style.symbol && definitions[style.symbol]) defs[style.symbol] = definitions[style.symbol];
    }
    if (Object.keys(styles).length) child.schRestored = {sheet:{...sheet,frame:[]},items:styles,definitions:defs};
  }
  // A channel footprint links to schematic-link@instance-path. Part and package IDs
  // stay fixed, but a new wrapper adds a path step for moved parts and descendants.
  function channelReferences(before, after, wrapper, sourceId, moved) {
    const oldPaths = instancePaths(before), old = new Map([...oldPaths].map(([i,path]) => [JSON.stringify(path),i]));
    const links = new Map(), channels = new Map(), instances = new Map(), wrapped = new Map();
    for (const [instance,path] of instancePaths(after,wrapper)) {
      const prior = old.get(JSON.stringify(path));
      if (!prior) continue;
      if (instance.symbol?.id === wrapper) wrapped.set(prior.id,instance.id);
      else if (prior.id!==instance.id && prior.doc.id===instance.doc.id) instances.set(prior.id,instance.id);
      if (prior.channelScope && prior.channelScope !== instance.channelScope) channels.set(prior.channelScope,instance.channelScope);
      if (prior.id === instance.id && prior.doc.id === instance.doc.id) continue;
      for (const part of instance.doc.items) if (part.kind === "part" && part.link) {
        const physical = i => globalThis.AtriumMultichannel?.chLink(part.link,i) ?? part.link;
        links.set(physical(prior), {link:physical(instance),sheet:instance.doc.id,instance:instance.suffix ? instance.id : "",channel:instance.channelScope});
      }
    }
    // Targets outside the frame retain the old sheet occurrence. Descendants of a moved child symbol change occurrence as a whole.
    instances.forTarget=(id,docId,itemId)=>docId===sourceId && moved.has(itemId)?wrapped.get(id) || instances.get(id):instances.get(id);
    return {links,channels,instances};
  }
  function notebookNeeds(project) {
    let notes=false,calculations=false,widgets=false;
    for (const d of project.documents) if (d.kind==="schematic") for (const i of d.items) {
      if (i.calculation || i.kind==="calculation") calculations=true;
      if (i.widget) widgets=true;
      if (i.richText) notes=true;
    }
    notes=notes || widgets || calculations;
    return {notes,calculations,widgets,modules:notes?["AtriumNotebook",...(calculations?["AtriumCalculations"]:[]),...(widgets?["AtriumSheetWidgets"]:[])]:[]};
  }
  async function prepareNotes(project) {
    if (!notebookNeeds(project).notes) return;
    const n=globalThis.AtriumNotebook || (globalThis.AtriumLazy?.modules?.().includes("AtriumNotebook") ? await AtriumLazy.need("AtriumNotebook") : null);
    await n?.demand?.([project]);
  }
  function moveReferences(project,from,to,moved,{links,channels}) {
    for (const r of Object.values(project.review?.records || {}))
      if (r.type === "thread" && r.doc === from && (moved.has(r.anchor?.id) || r.anchor?.ids?.length && r.anchor.ids.every(id => moved.has(id)))) r.doc = to;
    for (const w of project.waivers?.list || []) for (const obj of w.objects || [])
      if (obj.doc === from && moved.has(obj.id)) obj.doc = to;
    for (const r of Object.values(project.insights?.dismissed || {}))
      if (r.doc === from && r.objects?.length && r.objects.every(id => moved.has(id))) r.doc = to;
    for (const s of project.signals?.signals || [])
      if (s.origin?.doc === from && moved.has(s.origin.item)) s.origin.doc = to;
    for (const board of project.documents.filter(d => d.kind === "pcb")) {
      for (const part of board.items) if (part.kind === "part") {
        const next = links.get(part.link);
        if (next) {
          part.link = next.link;
          if (part.channel) part.channel = next.channel;
          const location = board.sync?.locations?.[part.id];
          if (location) {location.sheet = next.sheet; if (location.channel) location.channel = next.instance;}
        }
      }
      for (const room of board.rooms || []) if (channels.has(room.channel)) room.channel = channels.get(room.channel);
    }
    for (const v of project.variants || []) for (const key of Object.keys(v.parts || {})) {
      const next = links.get(key)?.link;
      if (next && next !== key) {v.parts[next] = v.parts[key]; delete v.parts[key];}
    }
  }

  function plan(project,docId,frameId,{scope,makeId} = {}) {
    const data = prepare(project,docId,frameId);
    const setting = scope || H.scopeSetting(project);
    if (setting !== "automatic") return assemble(project,data,setting,makeId);
    const from = data.before.effective;
    if (from === "hierarchical") return assemble(project,data,from,makeId);
    let original;
    try {original = assemble(project,data,from,makeId);} catch {return assemble(project,data,"hierarchical",makeId);}
    const effective = H.effectiveScope({...project,documents:project.documents.flatMap(d => d === data.doc ? [original.parent,original.child] : [d])},"automatic");
    return from === effective ? original : assemble(project,data,effective,makeId);
  }

  async function run(host,docId,frameId) {
    const project = host.project(), revision = host.revision();
    const session = host.folderProject?.(), purpose = "sch-convert-frame";
    if (session?.completeFor(purpose) === false) {
      host.info("Loading schematic sheets…");
      await session.requireClosure({purpose});
    }
    const [notice] = await Promise.all([AtriumLazy.need("AtriumProjectConnections"),prepareNotes(project)]);
    if (host.project() !== project || host.revision() !== revision || host.currentId() !== docId) return false;
    const data = prepare(project,docId,frameId);
    const setting = H.scopeSetting(project), from = data.before.effective;
    let to = from;
    const plans = new Map(), errors = new Map();
    const tryPlan = scope => {try {plans.set(scope,assemble(project,data,scope));} catch (e) {errors.set(scope,e.message);}};
    tryPlan(from);
    if (setting === "automatic" && from !== "hierarchical") {
      const retained = plans.get(from);
      to = retained ? H.effectiveScope({...project,documents:project.documents.flatMap(d => d === data.doc ? [retained.parent,retained.child] : [d])},"automatic") : "hierarchical";
      if (to !== from) tryPlan(to);
    }
    if (setting === "flat" && !plans.has(from)) {
      // Ports are global in Flat. A new port in a repeated sheet could short distinct
      // channel-local nets. Offer the verified hierarchical alternative explicitly.
      to = "hierarchical"; tryPlan(to);
    }
    if (!plans.size) throw Error(errors.get(to) || errors.get(from));
    const done = await notice.convert(host,{from,to,keep:plans.has(from),switch:plans.has(to),reason:errors.get(to) || errors.get(from),
      apply:chosen => plans.get(chosen).apply(project)});
    if (done && host.currentId() === docId) host.select([frameId],frameId);
    return done;
  }
  return {plan,run,prepareNotes,notebookNeeds};
})();
