"use strict";

if (!globalThis.AtriumResolvedLand && typeof require === "function") require("./pcb-appearance.js");

// Exact physical aperture and process offsets, loaded for measurement and output.
globalThis.AtriumLandContours=(()=>{
  const line=(a,b)=>({kind:"line",a,b});
  const arc=(center,radius,start,sweep)=>({kind:"arc",center,radius,start,sweep});
  function aperture(g){
    if(!g || !(g.w>0&&g.h>0))return [];
    const x=g.w/2,y=g.h/2,r=g.r;
    let outer;
    if(g.shape==="circle")outer=[arc([0,0],x,90,-360)];
    else if(g.shape==="ellipse")outer=[AtriumResolvedLand.ellipse(g)];
    else if(r>0){
      const a=x-r,b=y-r,corners=[[a,-b], [a,b], [-a,b], [-a,-b]];
      outer=[];
      for(let i=0;i<4;i++){
        const center=corners[i],start=90-90*i,next=corners[(i+1)%4];
        outer.push(arc(center,r,start,-90));
        if(center[0]!==next[0]||center[1]!==next[1]){
          const d=i<2?r:-r, delta=i%2?[0,d]:[d,0];
          outer.push(line([center[0]+delta[0],center[1]+delta[1]],[next[0]+delta[0],next[1]+delta[1]]));
        }
      }
    }else{
      const poly=AtriumPCBAppearance.padPolygon(g);
      outer=poly.map((pt,i)=>line(pt,poly[(i+1)%poly.length]));
    }
    return [{outer,holes:[]}];
  }
  function outline(g,tolerance=.002){
    const area=aperture(g);
    if(!area.length)return [];
    const edges=area[0].outer;
    if(edges.every(edge=>edge.kind==="line"))return edges.map(edge=>edge.a);
    const curves=globalThis.AtriumGeometryCurves;
    return curves.flatten(edges,tolerance).slice(0,-1);
  }
  // Outward (e > 0) or inward offset of a simple polygon with mitred corners; null when a
  // shrink inverts it. Used for mask and paste expansion of custom polygon pads.
  function offsetPoly(pts, e) {
    const n = pts.length;
    if (n < 3) return null;
    const area = q => { let s = 0; for (let i = 0; i < n; i++) { const a = q[i], b = q[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s; };
    const a0 = area(pts), sign = a0 > 0 ? 1 : -1, normals = [];
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; normals.push([sign * dy / l, -sign * dx / l]); }
    const out = pts.map((p, i) => { const n1 = normals[(i + n - 1) % n], n2 = normals[i], k = Math.max(.2, 1 + n1[0] * n2[0] + n1[1] * n2[1]); return [p[0] + (n1[0] + n2[0]) * e / k, p[1] + (n1[1] + n2[1]) * e / k]; });
    const a1 = area(out);
    return Math.sign(a1) === Math.sign(a0) && Math.abs(a1) > 1e-9 ? out : null;
  }
  function expandPad(g, e) {
    if (!e) return g.w > 0 && g.h > 0 ? g : null;
    const w = g.w + 2 * e, h = g.h + 2 * e, min = Math.min(w, h);
    if (!(min > 1e-6)) return null;
    if (g.shape === "custom") {
      const poly = offsetPoly(g.poly, e);
      return poly ? {...g, poly, w, h, min} : null;
    }
    const clamp = v => Math.max(0, Math.min(min / 2, v));
    const shape = g.shape === "circle" || g.shape === "obround" ? AtriumResolvedLand.shape("round",w,h) : g.shape;
    const r = shape === "circle" || shape === "obround" ? min/2 : shape === "roundrect" ? clamp(g.r + e) : 0;
    return {...g, shape, w, h, min, r, t: shape === "octagon" ? clamp(g.t + e * (2 - Math.SQRT2)) : 0};
  }
  // Contact records keep the copper layer, placed contour, and a conservative search radius.
  function placedCopper(p, part, copper) {
    const L = AtriumResolvedLand, PCB = AtriumPCBAppearance, layer = PCB.padLayer(part, p);
    const via = p.kind === "via", all = layer === "Multi";
    if (!all && PCB.index(layer) < 0) return [];
    if (via && !PCB.copperSpan(p)) return [];
    // An unplated hole's land is copper of its pad's net too (connectivity.js, the DRC), so tracks reach
    // it and silk meets it like any land; none where the drill takes the whole land.
    const unplated = !via && p.drill > 0 && p.plated === false;
    const keys = via ? (all && (p.fromLayer != null || p.toLayer != null || p.backdrill || p.stackMode && p.stackMode !== "simple")
      ? copper() : [layer]) : PCB.padPlanes(p, layer, copper), out = [];
    for (const key of keys) {
      const land = L.geometry(p, key === "Multi" ? undefined : key, all ? keys : undefined);
      if (land && !land.holeOnly && !(unplated && p.drill >= Math.min(land.w, land.h) - 1e-9)) out.push({...L.place(land, part), land, layer: key ?? layer, radius: L.radius(land)});
    }
    return out;
  }
  function ellipseSegment({land,at,angle,mirror}, a, b) {
    const A = Atrium, L = AtriumResolvedLand, G = AtriumGeometry;
    const rx = land.w / 2, ry = land.h / 2;
    const local = ([x,y]) => {
      const [u,v] = A.rotate([x-at[0], y-at[1]], -angle);
      return [mirror ? -u : u, v];
    };
    const first = local(a), last = local(b);
    /** @type {(point: Point) => [number, number]} */
    const scaled = ([x,y]) => [x/rx,y/ry];
    // In unit-circle coordinates this point decides intersection with the finite segment.
    const closest = G.projectPointOnSegment([0,0], scaled(first), scaled(last));
    const frame = {x:at[0], y:at[1], angle, mirror};
    if (Math.hypot(...closest) <= 1) return {d:0, at:A.world([closest[0]*rx,closest[1]*ry],frame)};
    const dx = last[0]-first[0], dy = last[1]-first[1], length = Math.hypot(dx,dy);
    if (length) {
      const nx = -dy/length, ny = dx/length, side = nx*first[0]+ny*first[1];
      const support = Math.hypot(nx*rx,ny*ry);
      // An exterior stationary pair is the ellipse's support point and its projection on the line.
      if (Math.abs(side) > support) {
        const k = Math.sign(side)/support, x = k*nx*rx*rx, y = k*ny*ry*ry;
        const t = ((x-first[0])*dx+(y-first[1])*dy)/(length*length);
        if (t >= 0 && t <= 1) return {d:Math.abs(side)-support, at:[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]};
      }
    }
    const da = L.distance(land,a,at,angle,mirror), db = L.distance(land,b,at,angle,mirror);
    return da <= db ? {d:da,at:a} : {d:db,at:b};
  }
  // Distance to filled copper and a witness on the queried segment.
  function segmentDistance(placed, a, b) {
    const {land,at,angle,mirror} = placed, G = AtriumGeometry;
    if (land.shape === "ellipse") return ellipseSegment(placed,a,b);
    const {core,r} = AtriumResolvedLand.core(land,at,angle,mirror);
    if (core.length <= 2) {
      const c = G.closestSegments(a,b,core[0],core.at(-1));
      return {d:Math.max(0,c.d-r),at:c.pa};
    }
    if (G.inRing(a,core)) return {d:0,at:a};
    if (G.inRing(b,core)) return {d:0,at:b};
    let best = {d:Infinity,at:null};
    for (let i=0, j=core.length-1; i<core.length; j=i++) {
      const {d,pa} = G.closestSegments(a,b,core[j],core[i]);
      if (d <= r) return {d:0,at:pa};
      if (d-r < best.d) best = {d:d-r,at:pa};
    }
    return best;
  }
  function strokeContact(placed, a, b, radius) {
    const {d,at} = segmentDistance(placed,a,b);
    if (d <= radius) return at;
    // Bound the roundoff from board-space subtraction and rotation at the input scale.
    let scale = Math.max(placed.land.w,placed.land.h,radius);
    for (const [x,y] of [placed.at,a,b]) scale = Math.max(scale,Math.abs(x),Math.abs(y));
    return d-radius <= 8*Number.EPSILON*scale ? at : null;
  }
  function copperLookup(doc, defs) {
    let keys;
    return () => keys ??= globalThis.AtriumStackup?.copperLayers?.(doc, defs) ||
      doc.stackup?.layers?.map(l => l.key).filter(k => AtriumPCBAppearance.index(k) >= 0) || ["Top", "Bottom"];
  }
  const contactBox = ({at:[x,y],radius:r}) => [x-r,y-r,x+r,y+r];
  return Object.freeze({aperture,outline,film:AtriumResolvedLand.film,expand:expandPad,placedCopper,contactBox,copperLookup,segmentDistance,strokeContact});
})();
