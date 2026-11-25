"use strict";

// Siemens ODB++Design 8.1 update 4, Product Model, Step, Layer and Symbols chapters.
// https://odbplusplus.com/wp-content/uploads/sites/2/2024/08/odb_spec_user.pdf
globalThis.AtriumODB = (() => {
  const G = globalThis;
  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
  const digits = value => String(Math.round(value * 1e6) / 1e6);
  const direction = arc => arc.ccw ? "N" : "Y";
  const same = (a,b) => a[0] === b[0] && a[1] === b[1];
  const cleanName = value => String(value).toLowerCase().replace(/[^a-z0-9_+.-]+/g, "_").replace(/^[^a-z0-9]+|[._-]+$/g, "");
  const nameOf = (value, fallback) => cleanName(value).slice(0, 42) || fallback;
  const block = (type, fields) => type + " {\n" + Object.entries(fields).map(([key,value]) => key + "=" + value).join("\n") + "\n}\n";
  const text = lines => lines.join("\n") + "\n";
  const linear = points => points.map((a,i) => ({kind:"line", a, b:points[(i+1)%points.length]}));
  const angle = degrees => digits(((degrees || 0) % 360 + 360) % 360);

  let standardFontData;
  function standardFont() {
    if (standardFontData) return standardFontData;
    // The required font is unit-independent. Waffle's stroke grid runs from
    // x=0 to 4 and y=-2 to 7. Lift the baseline to the lower-left origin.
    const rows=["XSIZE 0.4","YSIZE 0.9","OFFSET 0.2"];
    for (let code=33;code<=126;code++) {
      const character=String.fromCharCode(code);
      rows.push("CHAR "+character);
      for (const points of G.AtriumFabOutputs.glyphs.get(character)) {
        for (let i=1;i<points.length;i++) {
          const [x1,y1]=points[i-1], [x2,y2]=points[i];
          rows.push("LINE "+[x1/10,(y1+2)/10,x2/10,(y2+2)/10].map(digits).join(" ")+" P R 0.03");
        }
      }
      rows.push("ECHAR");
    }
    standardFontData=text(rows);
    return standardFontData;
  }

  // Deterministic POSIX ustar and RFC 1952 framing. Reuse the offline raw DEFLATE encoder
  // already used for native STEP references, on desktop and JavaScriptCore alike.
  function tgz(root, files) {
    const directories = new Set([root]), entries = [];
    const padded = length => Math.ceil(length / 512) * 512;
    const encode = value => encoder ? encoder.encode(value) : G.AtriumZip.utf8(value);
    function byteLength(value) {
      if (!/[^\x00-\x7f]/.test(value)) return value.length;
      let size = 0;
      for (let i=0; i<value.length; i++) {
        const code = value.charCodeAt(i);
        if ((code & 0xfc00) === 0xd800 && (value.charCodeAt(i+1) & 0xfc00) === 0xdc00) {
          size += 4;
          i++;
        } else size += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      }
      return size;
    }
    for (const [relative,value] of files) {
      const path = root + "/" + relative, parts = path.split("/");
      if (value === null) directories.add(path);
      else {
        const data = String(value ?? "");
        entries.push({path,data,length:byteLength(data)});
      }
      while (parts.length > 1) {parts.pop(); directories.add(parts.join("/"));}
    }
    for (const path of directories) entries.push({path:path + "/",data:null,length:0});
    entries.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const size = entries.reduce((n,e) => n + 512 + padded(e.length), 1024);
    if (size > 192 * 1024 ** 2) throw Error("The ODB++ product model exceeds the archive byte limit.");

    // Preserve the same 1 MiB compressor input boundaries regardless of member
    // alignment or the UTF-8 encoding slices used to fill the tar block.
    const deflate = new G.AtriumZipDeflate({level:6}), chunks = [];
    const tar = new Uint8Array(Math.min(size,1024*1024)), entry = new Uint8Array(512), zero = new Uint8Array(1024);
    let used = 0, crc = 0;
    function flushBlock() {
      const bytes = tar.subarray(0,used);
      crc = G.AtriumZip.crc32(bytes,crc);
      chunks.push(deflate.append(bytes));
      used = 0;
    }
    function append(bytes) {
      for (let offset=0; offset<bytes.length;) {
        const count = Math.min(bytes.length-offset,tar.length-used);
        tar.set(bytes.subarray(offset,offset+count),used);
        offset += count;
        used += count;
        if (used === tar.length) flushBlock();
      }
    }
    function appendText(value,length) {
      // Only ASCII has the same UTF-8 and UTF-16 length. Encode that common
      // artwork case directly into the tar block where encodeInto exists.
      if (encoder?.encodeInto && value.length === length) {
        for (let start=0; start<length;) {
          const count = Math.min(length-start,tar.length-used);
          encoder.encodeInto(value.slice(start,start+count),tar.subarray(used,used+count));
          start += count;
          used += count;
          if (used === tar.length) flushBlock();
        }
        return;
      }
      const encodingSlice = 64*1024;
      for (let start=0; start<value.length;) {
        let end = Math.min(start+encodingSlice,value.length);
        // Keep paired surrogates together. TextEncoder replaces any lone
        // surrogate with U+FFFD, including at the start or end of the file.
        if ((value.charCodeAt(end-1) & 0xfc00) === 0xd800 && (value.charCodeAt(end) & 0xfc00) === 0xdc00) end--;
        append(encode(value.slice(start,end)));
        start = end;
      }
    }
    function write(entry, value, start, width) {
      const bytes = encode(value);
      if (bytes.length > width) throw Error("An ODB++ archive member name is too long.");
      entry.set(bytes, start);
    }
    function octal(entry,value,start,width) {write(entry, value.toString(8).padStart(width-1,"0") + "\0",start,width);}
    for (const {path,data,length} of entries) {
      const file = data !== null;
      entry.fill(0);
      const boundary = path.length > 100 ? path.lastIndexOf("/", path.length-2) : -1;
      write(entry, path.slice(boundary+1), 0, 100);
      if (boundary >= 0) write(entry, path.slice(0,boundary),345,155);
      octal(entry,file ? 0o644 : 0o755,100,8);
      octal(entry,0,108,8); octal(entry,0,116,8); octal(entry,length,124,12); octal(entry,0,136,12);
      entry.fill(32,148,156);
      write(entry, file ? "0" : "5", 156, 1);
      write(entry, "ustar\0", 257, 6); write(entry, "00", 263, 2);
      const checksum = entry.reduce((sum,byte) => sum+byte,0).toString(8).padStart(6,"0");
      write(entry, checksum + "\0 ", 148, 8);
      append(entry);
      if (file) {
        appendText(data,length);
        append(zero.subarray(0,padded(length)-length));
      }
    }
    append(zero);
    if (used) flushBlock();
    chunks.push(deflate.flush());
    const out = new Uint8Array(18+chunks.reduce((sum,chunk)=>sum+(chunk?.length??0),0));
    out.set([31,139,8,0,0,0,0,0,0,255]);
    let at=10;
    for (const chunk of chunks) if (chunk) {out.set(chunk,at); at+=chunk.length;}
    const trailer = new DataView(out.buffer,at,8);
    trailer.setUint32(0,crc,true);
    trailer.setUint32(4,size,true);
    return out;
  }

  function coordinates(model, options) {
    const F = G.AtriumFabOutputs, mm = F.projectCam(F.originFor(model,options));
    const scale = options.units === "in" ? 1/25.4 : 1;
    const position = options.units === "in" ? "INCH" : "MM";
    const plot = ([x,y]) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x)>2450 || Math.abs(y)>2450)
        throw Error("A coordinate exceeds the ODB++ Design 8.1 range.");
      return [Math.round(x*scale*1e6),Math.round(y*scale*1e6)];
    };
    return {units:"UNITS="+position, raw:point=>plot(mm(point)),
      local:point=>plot([point[0],-point[1]]), dimension:value=>digits(value*scale),
      macroPoint:([x,y])=>[x,-y].map(n=>Math.round(Number((n*scale).toFixed(6))*1e6)),
      aperture:value=>digits(Number((value*scale).toFixed(6))*1000), scale,
      drillPoint:point=>mm(point).map(n=>Math.round(Number((n*scale).toFixed(scale===1?4:5))*1e6)),
      drillSize:value=>digits(Number((value*scale).toFixed(scale===1?3:4))*1000)};
  }
  const pos = point => point.map(value => String(value/1e6)).join(" ");
  function tape(units,id) {
    const symbols=new Map(), attributes=new Map(), rows=[];
    function indexOf(table,name) {
      if (!table.has(name)) table.set(name,table.size);
      return table.get(name);
    }
    return {symbol:name=>indexOf(symbols,name), attr:name=>indexOf(attributes,name),
      rows, add:record=>rows.push(record)-1,
      output:()=>text([units,...(id==null?[]:["ID="+id]),"F "+rows.length,
        ...[...symbols].map(([name,i])=>"$"+i+" "+name),
        ...[...attributes].map(([name,i])=>"@"+i+" "+name),...rows])};
  }
  function stroke(path,width,t,xy,tool=0,attributes="",polarity="P") {
    const aperture=t.symbol("r"+xy.aperture(width));
    let previous=null, first=null, drew=false;
    for (const point of path) {
      const q=xy.raw(point);
      if (!first) first=q;
      if (previous && !same(previous,q)) {
        t.add("L "+pos(previous)+" "+pos(q)+" "+aperture+" "+polarity+" "+tool+attributes);
        drew=true;
      }
      previous=q;
    }
    if (!drew && first) t.add("P "+pos(first)+" "+aperture+" "+polarity+" "+tool+" 0"+attributes);
  }
  function encodedArc(t,a,start,end,center,aperture,attributes="",polarity="P") {
    t.add("A "+pos(start)+" "+pos(end)+" "+pos(center)+" "+aperture+" "+polarity+" 0 "+direction(a)+attributes);
  }
  function arcBetween(t,arc,start,end,center,aperture,xy,attributes,polarity) {
    const A=G.Atrium;
    const sweep=A.arcSweep(arc);
    if (same(start,end) && Math.abs(sweep)<360) {
      const mid=xy.raw(A.arcPoint(arc,arc.start+sweep/2));
      encodedArc(t,arc,start,mid,center,aperture,attributes,polarity);
      encodedArc(t,arc,mid,end,center,aperture,attributes,polarity);
    } else encodedArc(t,arc,start,end,center,aperture,attributes,polarity);
  }
  function arcStroke(t,arc,points,width,xy,polarity) {
    const A=G.Atrium;
    const start=xy.raw(A.arcPoint(arc,arc.start)), end=xy.raw(A.arcPoint(arc,arc.end)), center=xy.raw(arc.c);
    if (same(start,center) || same(start,end) && Math.abs(A.arcSweep(arc))<180) {stroke(points,width,t,xy,0,"",polarity);return;}
    arcBetween(t,arc,start,end,center,t.symbol("r"+xy.aperture(width)),xy,"",polarity);
  }
  function profileStroke(t,rings,width,xy) {
    const S=G.AtriumBoardShape, aperture=t.symbol("r"+xy.aperture(width));
    const drill=t.attr(".drill"), chain=t.attr(".rout_chain");
    for (const [i,ring] of rings.entries()) {
      if (!ring.length) continue;
      const attributes=";"+drill+"=1,"+chain+"="+(i+1);
      let start=xy.raw(S.head(ring[0]));
      for (const segment of ring) {
        const end=xy.raw(S.tail(segment)), center=segment.kind==="arc" ? xy.raw(segment.c) : null;
        // A contour joint is the preceding plotted endpoint, including tiny source stitch lines.
        if (center && !same(start,center) && (!same(start,end)||Math.abs(G.Atrium.arcSweep(segment))>=180))
          arcBetween(t,segment,start,end,center,aperture,xy,attributes);
        else if (!same(start,end)) t.add("L "+pos(start)+" "+pos(end)+" "+aperture+" P 0"+attributes);
        start=end;
      }
    }
  }
  function contour(segments,map,type="I") {
    if (!segments.length) return [];
    const S=G.AtriumBoardShape, first=map(S.head(segments[0]));
    const rows=["OB "+pos(first)+" "+type];
    let prev=first;
    for (const segment of segments) {
      const end=map(S.tail(segment));
      if (segment.kind==="arc") {
        const center=map(segment.c);
        if (!same(center,prev) && (!same(prev,end)||Math.abs(G.Atrium.arcSweep(segment))>=180)) {
          const draw = p => rows.push("OC "+pos(p)+" "+pos(center)+" "+direction(segment));
          if (same(prev,end) && Math.abs(G.Atrium.arcSweep(segment))<360)
            draw(map(G.Atrium.arcPoint(segment,segment.start+G.Atrium.arcSweep(segment)/2)));
          draw(end);
        } else if (!same(prev,end)) rows.push("OS "+pos(end));
      } else if (!same(prev,end)) rows.push("OS "+pos(end));
      prev=end;
    }
    if (!same(prev,first)) rows.push("OS "+pos(first));
    return rows.length>1 ? [...rows,"OE"] : [];
  }
  function routeOnlyProfileRings(profile,xy) {
    const S=G.AtriumBoardShape, {orient}=G.AtriumGeometry, edges=[], routeOnly=new Set(), intersecting=new Set();
    const pair=(i,j)=>Math.min(i,j)+":"+Math.max(i,j);
    for (const [ring,segments] of profile.entries()) {
      // Check the plotted topology using fine chords. The output keeps the original arcs.
      const points=S.flattenContour(segments,.0005).map(xy.raw).filter((p,i,q)=>!same(p,q[(i+q.length-1)%q.length]));
      for (const [i,a] of points.entries()) {
        const b=points[(i+1)%points.length];
        edges.push({a,b,ring,i,count:points.length,x0:Math.min(a[0],b[0]),x1:Math.max(a[0],b[0]),
          y0:Math.min(a[1],b[1]),y1:Math.max(a[1],b[1])});
      }
    }
    let active=[];
    for (const e of edges.sort((a,b)=>a.x0-b.x0)) {
      active=active.filter(b=>b.x1>=e.x0);
      for (const b of active) {
        const key=pair(e.ring,b.ring), delta=Math.abs(e.i-b.i);
        if (b.y0>e.y1 || e.y0>b.y1 || intersecting.has(key) ||
            (e.ring===b.ring && (delta===1 || delta===e.count-1))) continue;
        if (orient(e.a,e.b,b.a)*orient(e.a,e.b,b.b)>0 || orient(b.a,b.b,e.a)*orient(b.a,b.b,e.b)>0) continue;
        if (!e.ring && !b.ring) throw Error("The ODB++ board outline crosses or touches itself. Check the board shape.");
        if (!e.ring || !b.ring) throw Error("An ODB++ profile cutout meets the board outline. Incorporate that cut into the outline before exporting.");
        intersecting.add(key);
        routeOnly.add(e.ring);
        routeOnly.add(b.ring);
      }
      active.push(e);
    }
    return {routeOnly,intersecting:(i,j)=>intersecting.has(pair(i,j))};
  }
  function stepProfile(t,model,xy) {
    const S=G.AtriumBoardShape;
    const profile=model.boardShape ? S.profileContours(model.boardShape) : [linear(model.outline)];
    if (!profile[0].length) throw Error("Define a closed board shape before exporting ODB++.");
    const islandError="The board shape contains a material island inside a cutout. Export Gerber for this shape, or revise the board to have one connected outline for ODB++.";
    if (model.boardShape?.cutouts?.some((_,i)=>S.cutoutRegion(model.boardShape,i)?.cutouts.length)) throw Error(islandError);
    const {routeOnly,intersecting}=routeOnlyProfileRings(profile,xy);
    const bounds=profile.map(ring=>S.contourBounds(ring));
    const encloses=(i,j)=>bounds[i][0]<=bounds[j][0] && bounds[i][1]<=bounds[j][1] &&
      bounds[i][2]>=bounds[j][2] && bounds[i][3]>=bounds[j][3] && S.crossings(profile[i],S.head(profile[j][0]));
    const polygons=profile.flatMap((ring,i)=>{
      if (i && !encloses(0,i)) throw Error("An ODB++ profile cutout must be inside the board outline. Check the board shape.");
      // A step profile permits only one material island (ODB++ Design 8.1, p. 138).
      if (i && profile.some((_,j)=>j>0 && i!==j && !intersecting(i,j) && encloses(j,i))) throw Error(islandError);
      // Keep intersecting cuts on the ROUT layer so the step profile holes are disjoint.
      if (routeOnly.has(i)) return [];
      const type=i?"H":"I", oriented=S.orient(ring,i>0);
      // Model Y points down. After plotting, the island is clockwise and holes are counterclockwise.
      let rows=contour(oriented,xy.raw,type);
      if (rows.length<5) {
        const split=oriented.flatMap(segment=>{
          if (segment.kind!=="arc") return [segment];
          const third=S.sweep(segment)/3;
          return S.splitArc(segment,[segment.start+third,segment.start+2*third]);
        });
        rows=contour(split,xy.raw,type);
      }
      if (rows.length<5 || Math.abs(S.signedArea(ring))<1e-12) throw Error("The ODB++ board shape is degenerate.");
      return [rows];
    });
    surface(t,polygons[0],polygons.slice(1));
    return {profile,routedCutouts:routeOnly.size};
  }
  function pointRing(points, map, type="I") {
    const q=points.map(map);
    if (q.length<3) return [];
    let cur=q[0];
    const rows=["OB "+pos(cur)+" "+type];
    for (let i=0; i<q.length; i++) {
      const next=q[(i+1)%q.length];
      if (!same(cur,next)) rows.push("OS "+pos(next));
      cur=next;
    }
    return rows.length>=4 ? [...rows,"OE"] : [];
  }
  function surface(t, island, holes=[], polarity="P") {
    if (island.length) t.add(text(["S "+polarity+" 0",...island,...holes.flat(),"SE"]).trimEnd());
  }
  function plotRegion(t,f,xy,polarity) {
    const F=G.AtriumFabOutputs, identity=p=>p;
    const simple=(points,type)=>pointRing(F.tidy(points),identity,type);
    if (f.contour) {
      const holes=f.holeContours||(f.holes||[]).map(linear);
      if (polarity==="N" || !holes.length || G.AtriumBoardShapeSources.cutInContours(f.contour,holes)) {
        surface(t,contour(f.contour,xy.raw),holes.map(h=>contour(h,xy.raw,"H")),polarity);
        return;
      }
    }
    const quantized=points=>points.map(xy.raw).filter((p,i,all)=>!i||!same(p,all[i-1]));
    const outer=quantized(f.points);
    const holes=f.holes?.length ? F.cutIns(outer,f.holes.map(quantized)) : {contained:[],failed:[]};
    // ODB holes must be inside their island. Gerber's unattachable voids are explicit clears.
    surface(t,simple(outer,"I"),holes.contained.map(h=>simple(h,"H")));
    for (const hole of holes.failed) surface(t,simple(hole,"I"),[],"N");
  }
  function symbolOf(g,xy,library) {
    const w=xy.aperture(g.w), h=xy.aperture(g.h), box="rect"+w+"x"+h;
    const standard=name=>({name,orient:angle(g.angle)});
    if (g.shape==="circle") return standard("r"+w);
    if (g.shape==="obround") return standard("oval"+w+"x"+h);
    const corner=value=>digits(Math.min(Number(xy.aperture(value)),Number(w)/2,Number(h)/2));
    if (g.shape==="octagon" && g.t>1e-9) return standard(box+"xc"+corner(g.t));
    if (g.shape==="roundrect" && g.r>1e-9) {
      // The common Gerber film rounds each part of a rounded aperture separately.
      // A single parametric ODB radius would derive different corner centres.
      const r=g.r,cx=g.w/2-r,cy=g.h/2-r,primitives=[];
      for (const [width,height] of [[g.w,g.h-2*r],[g.w-2*r,g.h]]) {
        if (width>1e-9 && height>1e-9)
          primitives.push({name:"rect"+xy.aperture(width)+"x"+xy.aperture(height),at:[0,0],orient:angle(g.angle)});
      }
      for (const at of [[cx,cy],[-cx,cy],[-cx,-cy],[cx,-cy]])
        primitives.push({name:"r"+xy.aperture(2*r),at:xy.macroPoint(G.Atrium.rotate(at,g.angle)),orient:"0"});
      return customSymbol(library,{primitives},"0");
    }
    if (g.shape!=="custom" && g.shape!=="ellipse") return standard(box);
    const polygon=pointRing(G.AtriumFabOutputs.padOutline(g),xy.local);
    return customSymbol(library,{polygon},angle(g.angle));
  }
  function customSymbol(library,content,orient) {
    const key=JSON.stringify(content);
    if (!library.has(key)) library.set(key,{name:"waffle_pad_"+(library.size+1),...content});
    return {name:library.get(key).name,orient};
  }
  function plotFeature(t,f,xy,options,symbols) {
    const F=G.AtriumFabOutputs;
    const polarity=f.polarity==="clear" ? "N" : "P";
    if (f.t==="flash") {
      const shape=F.plotPad(f,options);
      if (shape) {
        const {name,orient}=symbolOf(shape,xy,symbols);
        t.add("P "+pos(xy.raw(f.at))+" "+t.symbol(name)+" "+polarity+" 0 8 "+orient);
      }
    } else if (f.t==="stroke") {
      if (f.arc) arcStroke(t,f.arc,f.points,f.width,xy,polarity);
      else stroke(f.points,f.width,t,xy,0,"",polarity);
    } else if (f.t==="circle") {
      const at=xy.raw([f.c[0]+f.r,f.c[1]]);
      encodedArc(t,{ccw:true},at,at,xy.raw(f.c),t.symbol("r"+xy.aperture(f.width)),"",polarity);
    } else if (f.t==="region") plotRegion(t,f,xy,polarity);
    else if (f.t==="pour") {
      G.AtriumPCBPours.contourSegments(f, f.rings).forEach((ring,i)=>{
        const rows = ring.some(g => g.kind === "arc") ? contour(ring,xy.raw) : pointRing(ring.map(g => g.a),xy.raw);
        surface(t,rows,[],i?"N":"P");
      });
    }
  }
  function drillRows(t,group,xy,electrical,layer) {
    const tools=new Map(), drillXY={raw:xy.drillPoint,aperture:xy.drillSize};
    for (const hit of group.hits) {
      const type=group.plated ? hit.via ? "VIA" : "PLATED" : "NON_PLATED";
      const type2=group.laser ? "LASER" : "STANDARD";
      const width=xy.drillSize(hit.d), key=type+" "+type2+" "+width;
      if (!tools.has(key)) tools.set(key,{NUM:tools.size+1,TYPE:type,TYPE2:type2,MIN_TOL:0,MAX_TOL:0,BIT:"",
        FINISH_SIZE:hit.backdrill?-1:width,DRILL_SIZE:width});
      const start=t.rows.length, tool=tools.get(key).NUM;
      const fields=[t.attr(".drill")+"="+["PLATED","NON_PLATED","VIA"].indexOf(type)];
      if (hit.endpoints && group.plated) fields.push(t.attr(".rout_plated"));
      if (hit.backdrill) fields.push(t.attr(".backdrill_max_stub_drill")+"="+digits(hit.stub*xy.scale*1000));
      const attributes=";"+fields.join(",");
      if (hit.endpoints) stroke(hit.endpoints,hit.d,t,drillXY,tool,attributes);
      else t.add("P "+pos(xy.drillPoint(hit.at))+" "+t.symbol("r"+width)+" P "+tool+" 0"+attributes);
      electrical.hole(hit,layer,start,t.rows.length);
    }
    return xy.units+"\n"+[...tools.values()].map(tool=>block("TOOLS",tool)).join("");
  }

  function physicalStack(model) {
    const S=G.AtriumStackup, name=model.doc.name;
    const stored=model.physicalStack ? model.stackStored && model.physicalStack : S.stored(model.doc);
    if (model.doc.stackup!=null && !stored) throw Error("ODB++ cannot export "+name+" because its saved physical stack could not be read.");
    const stack=model.physicalStack||stored||S.derive(model.doc,model.defs);
    if (stack.substacks?.length || stack.regions?.length || stack.bends?.length || model.flex)
      throw Error("ODB++ cannot export "+name+" with stack regions, substacks or bends. This exporter supports one uniform physical stack per product.");
    if (stack.layers.some(row=>row.type==="Stiffener"))
      throw Error("ODB++ cannot export "+name+" with a stiffener layer. Its placement geometry is not supported.");
    if (stack.layers.filter(S.isCopper).map(l=>l.key).join("|")!==model.stack.join("|"))
      throw Error("The ODB++ matrix cannot represent the mismatched copper stack of "+name+".");
    return stack;
  }

  function stackMaterials(stack) {
    return stack.layers.map(row=>JSON.stringify([row.type,row.key,row.thickness,row.material,row.dielectric,row.dk,row.df]));
  }

  function productLayers(models, prepared) {
    const F=G.AtriumFabOutputs, S=G.AtriumStackup, model=models[0];
    const keys=new Map(), drills=new Map(), films=new Map(), materials=[], copper=new Map(), names=new Set();
    const stack=physicalStack(model), expected=stackMaterials(stack);
    for (const other of models.slice(1)) {
      if (other.panel) continue;
      const next=physicalStack(other), seen=stackMaterials(next);
      const difference=Array.from({length:Math.max(expected.length,seen.length)},(_,i)=>i).find(i=>expected[i]!==seen[i]);
      if (difference!==undefined || !!next.main?.flex!==!!stack.main?.flex)
        throw Error("ODB++ panel boards "+model.doc.name+" and "+other.doc.name+" have different physical stacks"+
          (difference===undefined?".":" at layer "+(difference+1)+" ("+(stack.layers[difference]?.name||"missing")+
          " / "+(next.layers[difference]?.name||"missing")+")."));
    }
    const add=(key,name,type,extra={})=>{
      if (!keys.has(key)) {
        const base=name;
        let n=1;
        while (names.has(name)) name=base+"_"+ ++n;
        names.add(name);
        keys.set(key,{key,name,type,context:"BOARD",polarity:"POSITIVE",...extra});
      }
      return keys.get(key);
    };
    const flex=!!stack.main?.flex;
    const surfaceLayers={
      "Solder Mask":{type:"SOLDER_MASK",keys:["Top mask","Bottom mask"],names:["solder_mask_top","solder_mask_bottom"]},
      Overlay:{type:"SILK_SCREEN",keys:["Silk","Bottom silk"],names:["silk_top","silk_bottom"]},
      Coverlay:{type:"SOLDER_MASK",subtype:"COVERLAY",keys:["Top coverlay","Bottom coverlay"],names:["coverlay_top","coverlay_bottom"]}
    };
    function outer(type,bottom) {
      const f=surfaceLayers[type], i=bottom?1:0;
      return add(f.keys[i],f.names[i],f.type,{subtype:f.subtype,side:bottom?"BOTTOM":"TOP",ref:bottom?"Bottom":"Top"});
    }
    const first=stack.layers.findIndex(S.isCopper), last=stack.layers.findLastIndex(S.isCopper);
    const above=stack.layers.slice(0,first), below=stack.layers.slice(last+1);
    const needsMask=rows=>!flex&&!rows.some(r=>r.type==="Solder Mask" || r.type==="Coverlay");
    const materialRows=new Map();
    add("component-top","comp_+_top","COMPONENT");
    add("Top paste","paste_top","SOLDER_PASTE",{ref:"Top"});
    if (!above.some(row=>row.type==="Overlay")) outer("Overlay",false);
    let dielectric=0;
    for (const [i,row] of stack.layers.entries()) {
      const side=i<=first?"TOP":i>=last?"BOTTOM":"INNER";
      if (i===first && needsMask(above)) outer("Solder Mask",false);
      let layer;
      if (S.isCopper(row)) {
        const plane=row.type==="Plane";
        layer=add(row.key,nameOf(row.key,"copper"),plane?"POWER_GROUND":"SIGNAL",{
          side,...(flex?{subtype:plane?"PG_FLEX":"SIGNAL_FLEX"}:{})});
        copper.set(row.key,layer);
      } else if (Object.hasOwn(surfaceLayers,row.type)) {
        layer=outer(row.type,i>last);
        if (materialRows.has(layer.key))
          throw Error("ODB++ cannot export "+model.doc.name+" with multiple "+row.type.toLowerCase()+" layers on the same side.");
      } else {
        const n=++dielectric, material=nameOf(row.material||row.name,"dielectric");
        const finish=row.type==="Surface Finish";
        layer=add("material:"+n,"material_"+n,finish?"MASK":"DIELECTRIC",{side,...(finish ?
          {ref:i<first?"Top":"Bottom"} :
          {dielectricType:row.dielectric?.toUpperCase()||"NONE",material,form:flex?"FLEX":"RIGID"})});
      }
      materials.push({layer,row});
      materialRows.set(layer.key,row);
      if (i===last && needsMask(below)) outer("Solder Mask",true);
    }
    if (!below.some(row=>row.type==="Overlay")) outer("Overlay",true);
    add("Bottom paste","paste_bottom","SOLDER_PASTE",{ref:"Bottom"});
    add("component-bottom","comp_+_bot","COMPONENT");
    if (models.some(fm=>fm.panel) && materials.some(({layer})=>layer.subtype==="COVERLAY"))
      throw Error("ODB++ panel export does not support boards with coverlay.");
    add("outline","profile_rout","ROUT");
    for (const fm of models) {
      const featureOverrides=new Map();
      for (const l of prepared?.catalogue(fm) ?? F.gerberLayers(fm)) {
        if (l.features) featureOverrides.set(l.key,l.features);
        else featureOverrides.delete(l.key);
        if (keys.has(l.key) || l.key==="outline") continue;
        if (["Top mask","Bottom mask"].includes(l.key)) continue;
        add(l.key,"document_"+nameOf(l.key,"layer"),"DOCUMENT",{context:"MISC"});
      }
      films.set(fm,featureOverrides);
      const groups=new Map(), outerBottom=fm.stack.length-1;
      for (const group of F.drillGroups(fm)) for (const hit of group.hits) {
        const slots=!!hit.endpoints, back=hit.backdrill;
        let [start,end]=group.span;
        if (back) {
          // The shared span lists removed copper. The ODB++ operation also
          // names the next, retained layer as its endpoint and its stop.
          const stop=fm.stack.indexOf(hit.stop), [firstRemoved,lastRemoved]=hit.span;
          const fromOuterLayer=back==="top" ? firstRemoved===0 && stop===lastRemoved+1 :
            lastRemoved===outerBottom && stop===firstRemoved-1;
          if (stop<0 || !fromOuterLayer || slots || !Number.isFinite(hit.stub) || hit.stub<0)
            throw Error("ODB++ cannot resolve the "+back+" backdrill to "+hit.stop+" on "+fm.doc.name+".");
          [start,end]=back==="top" ? [firstRemoved,stop] : [stop,lastRemoved];
        }
        if (start<0 || end>outerBottom || start>=end)
          throw Error("ODB++ cannot resolve a drill span on "+fm.doc.name+".");
        const fromBottom=back ? back==="bottom" : start>0&&end===outerBottom;
        const direction=fromBottom?"bottom2top":"top2bottom";
        const span=[copper.get(fm.stack[start]).name,copper.get(fm.stack[end]).name];
        const operation=back?"backdrill_"+back+"_"+span.join("_"):group.key;
        const key=(slots?"rout_":"drill_")+cleanName(operation);
        const row=add(key,key,slots?"ROUT":"DRILL",{start:span[0],end:span[1],direction,
          ...(back?{subtype:"BACKDRILL",stop:copper.get(hit.stop).name}:{})});
        if (!groups.has(row)) groups.set(row,{row,group:{plated:hit.plated,laser:hit.laser,hits:[]}});
        groups.get(row).group.hits.push(hit);
      }
      drills.set(fm,[...groups.values()]);
    }
    const layers=[...keys.values()];
    layers.forEach((l,i)=>{l.number=i; l.uid=i+1;});
    return {layers,keys,copper,materials,materialRows,drills,films};
  }

  function step(files,name,model,schema,settings,symbols,options,assembly,children,index) {
    const F=G.AtriumFabOutputs, xy=coordinates(model,settings), root="steps/"+name+"/";
    const stats={features:0,arcs:0,drills:0,components:0,nets:0};
    const shape=tape(xy.units);
    const {profile,routedCutouts}=stepProfile(shape,model,xy);
    if (routedCutouts) stats.routedCutouts=routedCutouts;
    files.set(root+"profile",shape.output());
    const featureIds=new Map(schema.layers.filter(l=>l.type!=="DIELECTRIC" && l.type!=="COMPONENT")
      .map(l=>[l,schema.layers.length*(index+1)+l.uid]));
    const fids=G.AtriumODBData.electrical(model,schema,xy,assembly,featureIds);
    const repeats=(model.panel?.instances||[]).filter(inst=>!inst.mirror).map(inst=>{
      const child=children.get(inst.board.id);
      const datum=F.originFor(child.model,settings), at=xy.raw(inst.T(datum));
      return block("STEP-REPEAT",{NAME:child.name,X:at[0]/1e6,Y:at[1]/1e6,DX:0,DY:0,NX:1,NY:1,
        ANGLE:angle(inst.rotation),FLIP:"NO",MIRROR:"NO"}).trimEnd();
    });
    files.set(root+"stephdr",text([xy.units,"X_DATUM=0","Y_DATUM=0","X_ORIGIN=0","Y_ORIGIN=0",
      ...(assembly.active&&model.parts.length?["AFFECTING_BOM=0"]:[]),...repeats]));
    if (assembly.rows.length) files.set(root+"attrlist",text([xy.units,".current_variant="+assembly.active]));
    const groups=new Map(schema.drills.get(model).map(({row,group})=>[row,group]));
    const films=schema.films.get(model);
    const coverlay=schema.layers.some(l=>l.subtype==="COVERLAY") ?
      G.AtriumRigidFlex?.fabLayers(model.doc,model.defs,{coverlayOnly:true})?.layers : [];
    for (const layer of schema.layers) {
      if (layer.type==="COMPONENT") continue;
      const path=root+"layers/"+layer.name+"/", attributes=[];
      const material=schema.materialRows.get(layer.key);
      if (material?.dk!=null) attributes.push(".dielectric_constant="+material.dk);
      if (material?.df!=null) attributes.push(".loss_tangent="+material.df);
      if (layer.direction) attributes.push(".drill_layer_direction="+layer.direction);
      if (layer.stop) attributes.push(".backdrill_penetrate_stop_layer="+layer.stop);
      if (layer.type==="DIELECTRIC" || attributes.length) files.set(path+"attrlist",text([xy.units,...attributes]));
      if (layer.type==="DIELECTRIC") continue;
      const t=tape(xy.units,featureIds.get(layer));
      const group=groups.get(layer);
      if (group) {
        files.set(path+"tools",drillRows(t,group,xy,fids,layer));
        stats.drills+=group.hits.length;
        for (const hit of group.hits) options.plottedFeature?.(hit,true,layer.name);
      } else if (layer.key==="outline") {
        // The panel's finished contour includes every routed channel and the tab gaps.
        // A repeated board contributes its profile for reference and no machining paths.
        if (!options.panelId || model.panel) profileStroke(t,profile,settings.profileWidth,xy);
      } else if (layer.subtype==="COVERLAY") {
        const film=coverlay?.find(f=>f.key===layer.key);
        if (!film) throw Error("ODB++ cannot resolve "+layer.key.toLowerCase()+" openings for "+model.doc.name+".");
        // Write the shared film's pad openings as clockwise clearance islands.
        for (const opening of film.openings) {
          const points=G.AtriumBoardShape.polyArea(opening.poly)<0 ? opening.poly.slice().reverse() : opening.poly;
          const before=t.rows.length;
          surface(t,pointRing(points,xy.raw));
          fids.graphic({t:"flash",at:opening.at},layer,before,t.rows.length);
        }
      } else {
        const rows=films.get(layer.key)||model.layers.get(layer.key)||[];
        const plot=f=>{
          const before=t.rows.length;
          plotFeature(t,f,xy,settings,symbols);
          options.plottedFeature?.(f,t.rows.length>before,layer.name);
          fids.graphic(f,layer,before,t.rows.length);
        };
        for (const f of rows) if (f.t==="pour") plot(f);
        for (const f of rows) if (f.t!=="pour") plot(f);
      }
      stats.features+=t.rows.length;
      stats.arcs+=t.rows.reduce((n,row)=>n+(row.startsWith("A ")?1:(row.match(/\nOC /g)||[]).length),0);
      files.set(path+"features",t.output());
    }
    Object.assign(stats,fids.write(files,root));
    return stats;
  }
  function build(project,requested,options={},prepared) {
    const F=G.AtriumFabOutputs, date=options.date==null?new Date(0):new Date(options.date);
    if (!Number.isFinite(date.getTime())) throw Error("Choose a valid ODB++ creation date.");
    const settings=F.settle({...options,date,units:options.units==="in"?"in":"mm"});
    const panel=options.panelId&&G.AtriumPanel.analyse(project,options.panelId,{...options,date,odbRepeat:true},prepared?.panel?.(date));
    const boards=panel ? [...panel.odbBoards.values()] : [options.model||
      F.analyse(project,requested,{variant:options.variant,strictLayers:options.strictLayers,provenance:options.provenance,
        omitUnconnectedMidLayerPads:options.omitUnconnectedMidLayerPads})];
    const board=boards[0], models=panel?[...boards,panel]:boards, schema=productLayers(models,prepared?.writers);
    const assembly=G.AtriumODBData.variants(project,options.variant);
    const title=panel?.doc.name||board.doc.name, root="waffle_"+nameOf(options.fileStem||title,"board");
    const files=new Map(), symbols=new Map(), stats={steps:{}};
    const steps=boards.map((_,i)=>i?"pcb_"+(i+1):"pcb");
    const children=new Map(boards.map((model,i)=>[model.doc.id,{model,name:steps[i]}]));
    if (panel) steps.push("panel");
    const stamp=date.toISOString().slice(0,19).replace(/[-:]/g,"").replace("T",".");
    files.set("fonts/standard",standardFont());
    files.set("misc/info",text(["UNITS="+(settings.units==="in"?"INCH":"MM"),"PRODUCT_MODEL_NAME="+root,"ODB_VERSION_MAJOR=8",
      "ODB_VERSION_MINOR=1","ODB_SOURCE=Waffle","CREATION_DATE="+stamp,"SAVE_DATE="+stamp,"SAVE_APP=Waffle","MAX_UID="+schema.layers.length*(models.length+1)]));
    if (assembly.rows.length) files.set("misc/attrlist",text([coordinates(board,settings).units,
      ".variant_list="+assembly.rows.map(row=>row.token).join(":")]));
    files.set("matrix/matrix",steps.map((name,i)=>block("STEP",{COL:i+1,NAME:name})).join("\n")+
      schema.layers.map(l=>block("LAYER",{ROW:l.number+1,CONTEXT:l.context,TYPE:l.type,ID:l.uid,NAME:l.name,POLARITY:l.polarity,
        START_NAME:l.start||"",END_NAME:l.end||"",OLD_NAME:"",ADD_TYPE:l.subtype||"",
        ...(l.dielectricType?{DIELECTRIC_TYPE:l.dielectricType,DIELECTRIC_NAME:l.material,FORM:l.form}:{}),
        ...(l.ref?{REF:schema.copper.get(l.ref).uid}:{})})).join("\n"));
    files.set("matrix/stackup.xml",G.AtriumODBData.stackup(schema));
    for (const [i,model] of models.entries()) stats.steps[steps[i]]=step(files,steps[i],model,schema,settings,symbols,options,assembly,children,i);
    for (const {name,polygon,primitives} of symbols.values()) {
      const t=tape(coordinates(board,settings).units);
      if (polygon) surface(t,polygon);
      for (const p of primitives||[]) t.add("P "+pos(p.at)+" "+t.symbol(p.name)+" P 0 8 "+p.orient);
      files.set("symbols/"+name+"/features",t.output());
    }
    stats.layers=schema.layers.length; stats.symbols=symbols.size;
    const warnings=[...new Set(models.flatMap((model,i)=>[...F.warnings(model),...(stats.steps[steps[i]].routedCutouts ?
      [model.doc.name+": Intersecting cutout paths are on the profile_rout layer."] : [])]))];
    return {name:F.baseName(options.fileStem||title)+".tgz",bytes:tgz(root,files),stats,warnings};
  }
  return Object.freeze({build});
})();
