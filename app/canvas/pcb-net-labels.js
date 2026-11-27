"use strict";
// AtriumPCBNetLabels: net names on the copper of the current layer, placed for the view on screen.
//
// Level of detail, as in Altium: a track shows its net name along each segment once the track is wide
// enough on screen for legible text, inside the copper and turned with it (never upside down). A long
// segment repeats the name at a fixed world spacing (a power of two, so the labels stay put while
// panning and only change spacing at zoom octaves); when none of those spots is in view, the nearest
// one slides to the edge of the visible part, so a track that crosses the view keeps a label on
// screen. Labels stay clear of the segment's ends, where pads and vias sit. Pours show their net at
// interior points in view, on a world grid tested once per grid cell (cached), sparsely repeated.
// Pads keep their own captions (canvas.js padText).
//
// Everything is computed in screen space for the camera at hand from the objects in view (the
// canvas's spatial query), so a pan or zoom costs a query plus a few hundred segment tests, and
// both board renderers draw the same labels through canvas.js paintTop.
globalThis.AtriumPCBNetLabels = (() => {
  const MIN_PX = 7, MAX_PX = 15, GLYPH = .6, TRACK_FONT = .62, MAX_LABELS = 400;
  const POUR_PX = 11, POUR_CELL = 120, POUR_PER_REGION = 3, MEMO = 4096;
  const hex = /^#[0-9a-f]{6}$/i;
  function lightInk(ink) {
    if (!hex.test(ink || "")) return false;
    const n = parseInt(ink.slice(1), 16);
    return (.299 * (n >> 16 & 255) + .587 * (n >> 8 & 255) + .114 * (n & 255)) / 255 > .6;
  }
  function mix(a, b, t) {
    if (!hex.test(a || "") || !hex.test(b || "")) return a;
    const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
    return "#" + [16, 8, 0].map(s => Math.round((x >> s & 255) * t + (y >> s & 255) * (1 - t)).toString(16).padStart(2, "0")).join("");
  }
  const textOn = (ink, PCB) => lightInk(ink) ? "#000000" : PCB.system.padText;
  // Liang–Barsky: the part of p→q inside the box, as parameters [t0, t1], or null.
  function clip(p, q, box) {
    let t0 = 0, t1 = 1;
    const dx = q[0] - p[0], dy = q[1] - p[1];
    for (const [d, e] of [[-dx, p[0] - box[0]], [dx, box[2] - p[0]], [-dy, p[1] - box[1]], [dy, box[3] - p[1]]]) {
      if (d === 0) { if (e < 0) return null; continue; }
      const t = e / d;
      if (d < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return [t0, t1];
  }
  // Never upside down: angles in (-90°, 90°].
  const upright = a => a > Math.PI / 2 + 1e-9 ? a - Math.PI : a <= -Math.PI / 2 + 1e-9 ? a + Math.PI : a;
  const pow2 = v => Math.pow(2, Math.ceil(Math.log2(v)));
  // Placed labels' screen boxes (axis-aligned around the turned text): later labels that overlap are dropped.
  function overlaps(placed, box) {
    for (const b of placed) if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) return true;
    return false;
  }
  function boxOf(x, y, w, h, a) {
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)), hw = (w * c + h * s) / 2, hh = (w * s + h * c) / 2;
    return [x - hw, y - hh, x + hw, y + hh];
  }

  // ---------------------------------------------------------------- tracks
  const trackSize = (width, scale) => width * scale * TRACK_FONT;
  // Each view provides its own scene cache. Parked/rebuilt scenes never share bounds.
  const trackWidths=new WeakMap(), SPARSE_TRACKS=32;
  function netTrackWidths(c,layer){
    let e=trackWidths.get(c);
    if(!e||e.rev!==c.rev){
      const d=c.delta;
      // A complete, consecutive non-track change can only leave an extra
      // bound if a track changed kind. The item query still owns placement.
      if(e&&d?.from===e.rev&&d.to===c.rev&&d.itemsKnown&&!d.removed.length&&!d.changed.some(i=>i.kind==="track"))e.rev=c.rev;
      else{e={rev:c.rev,by:new Map()};trackWidths.set(c,e);}
    }
    const cached=e.by.get(layer);
    if(cached)return cached;
    let max=0,bounds=new Map();
    for(const i of c.all){
      if(i.kind!=="track"||i.layer!==layer||!i.net||!(i.width>0))continue;
      max=Math.max(max,i.width);
      if(!bounds)continue;
      const box=c.boxes.get(i), group=bounds.get(i.width);
      // An offscreen group does not need a query. Keep only small groups in
      // document order so a few wide tracks can bypass the whole-scene query.
      if(!box||!group&&bounds.size>=64){bounds=null;continue;}
      if(group){
        const b=group.box;
        b[0]=Math.min(b[0],box[0]);b[1]=Math.min(b[1],box[1]);
        b[2]=Math.max(b[2],box[2]);b[3]=Math.max(b[3],box[3]);
        if(group.tracks){
          if(group.tracks.length===SPARSE_TRACKS)group.tracks=null;
          else group.tracks.push(i);
        }
      }else bounds.set(i.width,{box:box.slice(),tracks:typeof i.width==="number"?[i]:null});
    }
    const result={max,bounds:bounds&&[...bounds]};
    e.by.set(layer,result);return result;
  }
  const noTracks=Object.freeze({maxWidth:0,tracks:null});
  // A null track list asks the caller for its ordinary viewport items.
  function trackCandidates(scene,layer,scale,view,reuseArtwork){
    const {max,bounds}=netTrackWidths(scene,layer), spatial=globalThis.AtriumSpatial;
    if(!(trackSize(max,scale)>=MIN_PX))return noTracks;
    if(!bounds||!spatial)return {maxWidth:max,tracks:null};
    let found=false, tracks=reuseArtwork?null:[], count=0;
    for(const [width,group] of bounds){
      if(!(trackSize(width,scale)>=MIN_PX)||!spatial.overlaps(group.box,view))continue;
      found=true;
      if(!tracks)break;
      if(!group.tracks||(count+=group.tracks.length)>SPARSE_TRACKS){tracks=null;break;}
      // The scene removes a box with its object, even when an in-memory
      // board has absent or duplicate IDs. Kind changes can leave an old group.
      for(const item of group.tracks){
        const box=scene.boxes.get(item);
        if(item.kind==="track"&&box&&spatial.overlaps(box,view))tracks.push(item);
      }
    }
    return found?{maxWidth:max,tracks}:noTracks;
  }
  const trackWidthLimit=(scene,layer,scale,view)=>trackCandidates(scene,layer,scale,view,true).maxWidth;
  function trackLabels(out, placed, i, v) {
    const {scale, toScreen, screen, PCB, opts} = v;
    const w = i.width || 0, size = Math.min(MAX_PX, trackSize(w, scale));
    if (size < MIN_PX) return;
    const text = String(i.net), tw = text.length * GLYPH * size, need = tw + size * 1.2;
    const keep = Math.max(w * scale * .75, size);
    const ink = v.trackInk(i), color = textOn(ink, PCB);
    const pts = i.points;
    for (let n = 1; n < pts.length && out.length < MAX_LABELS; n++) {
      const P = toScreen(pts[n - 1]), Q = toScreen(pts[n]);
      const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
      if (L - 2 * keep < need) continue;
      const t = clip(P, Q, screen);
      if (!t) continue;
      const a = Math.max(t[0] * L, keep) + need / 2, b = Math.min(t[1] * L, L - keep) - need / 2;
      if (a > b) continue;
      // Anchors at a world spacing from the segment's start (screen spacing between `period` and twice it).
      const period = pow2(Math.max(need * 2.5, 320) / scale) * scale;
      const first = Math.ceil((a - period / 2) / period), last = Math.floor((b - period / 2) / period);
      const at = [];
      for (let k = first; k <= last && at.length < 8; k++) at.push((k + .5) * period);
      if (!at.length) {
        const k = Math.max(0, Math.round((a + b) / 2 / period - .5)), s = (k + .5) * period;
        at.push(Math.min(b, Math.max(a, s)));
      }
      const angle = upright(Math.atan2(Q[1] - P[1], Q[0] - P[0]));
      for (const s of at) {
        const x = P[0] + (Q[0] - P[0]) * s / L, y = P[1] + (Q[1] - P[1]) * s / L;
        const box = boxOf(x, y, tw, size, angle);
        if (overlaps(placed, box)) continue;
        placed.push(box);
        out.push({kind: "track", id: i.id, text, x, y, angle, size, ink: color, layer: i.layer});
        if (out.length >= MAX_LABELS) return;
      }
    }
  }

  // ---------------------------------------------------------------- pours
  // Even-odd point test over a region's rings (pcb-pours.js contours), with ring boxes to skip far rings.
  const ringBoxes = new WeakMap();
  function boxesOf(region, rings) {
    let e = ringBoxes.get(region);
    if (e && e.rings === rings) return e.boxes;
    const boxes = rings.map(r => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < r.length; k += 2) { const x = r[k], y = r[k + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return [x0, y0, x1, y1];
    });
    ringBoxes.set(region, {rings, boxes});
    return boxes;
  }
  function scanline(xy, y) {
    const crossings = [], n = xy.length;
    for (let k = 0, j = n - 2; k < n; j = k, k += 2) {
      const yi = xy[k + 1], yj = xy[j + 1];
      if ((yi > y) !== (yj > y)) crossings.push((xy[j] - xy[k]) * (y - yi) / (yj - yi) + xy[k]);
    }
    return crossings;
  }
  function inside(rings, boxes, x, y, row) {
    let odd = false;
    for (let r = 0; r < rings.length; r++) {
      const b = boxes[r];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      const crossings = row[r] ||= scanline(rings[r], y);
      for (const at of crossings) if (x < at) odd = !odd;
    }
    return odd;
  }
  // Per region: grid-cell results ("cell|ix|iy|w|h" → room for the label there), kept while the region is.
  const memo = new WeakMap();
  function pourLabels(out, placed, region, v, obstacles) {
    const {scale, toScreen, view, PCB, opts} = v;
    const b = region.bounds;
    if ((b[2] - b[0]) * scale < POUR_CELL * .6 || (b[3] - b[1]) * scale < POUR_PX * 3) return;
    let rings;
    try { rings = globalThis.AtriumPCBPours?.contours?.(region); } catch { return; } // a region still being written
    if (!rings?.length) return;
    const boxes = boxesOf(region, rings);
    const text = String(region.net), size = POUR_PX, tw = text.length * GLYPH * size;
    // Room in world units: the label's box plus a margin, all inside the copper.
    const hw = (tw / 2 + size * 1.2) / scale, hh = size * 1.4 / scale;
    const cell = pow2(POUR_CELL / scale);
    let m = memo.get(region);
    const key = globalThis.AtriumPCBPours?.dataKey?.(region) ?? region.data;
    if (!m || m.data !== key) { m = {data: key, map: new Map()}; memo.set(region, m); }
    if (m.map.size > MEMO) m.map.clear();
    const x0 = Math.max(view[0], b[0]) + hw, x1 = Math.min(view[2], b[2]) - hw, y0 = Math.max(view[1], b[1]) + hh, y1 = Math.min(view[3], b[3]) - hh;
    if (x0 > x1 || y0 > y1) return;
    const cx = (view[0] + view[2]) / 2, cy = (view[1] + view[3]) / 2, spots = [];
    const firstX = Math.ceil(x0 / cell - .5), dimensions = "|" + hw.toFixed(6) + "|" + hh.toFixed(6);
    for (let iy = Math.ceil(y0 / cell - .5); (iy + .5) * cell <= y1; iy++) {
      const y = (iy + .5) * cell;
      // Positions on the same grid row share the three horizontal edge tests.
      let scanlines;
      for (let ix = firstX; (ix + .5) * cell <= x1; ix++) {
        const x = (ix + .5) * cell, key = cell + "|" + ix + "|" + iy + dimensions;
        let ok = m.map.get(key);
        if (ok === undefined) {
          const [middle, low, high] = scanlines ||= [[], [], []];
          ok = inside(rings, boxes, x, y, middle) &&
            inside(rings, boxes, x - hw, y - hh, low) && inside(rings, boxes, x + hw, y + hh, high) &&
            inside(rings, boxes, x - hw, y + hh, high) && inside(rings, boxes, x + hw, y - hh, low) &&
            inside(rings, boxes, x - hw, y, middle) && inside(rings, boxes, x + hw, y, middle);
          m.map.set(key, ok);
        }
        if (ok) spots.push([x, y, Math.hypot(x - cx, y - cy)]);
      }
    }
    if (!spots.length) return;
    spots.sort((p, q) => p[2] - q[2]);
    const ink = textOn(mix(v.pourInk(region), PCB.system.board, PCB.opacity.pour), PCB), chosen = [];
    for (const [x, y] of spots) {
      if (chosen.length >= POUR_PER_REGION) break;
      if (chosen.some(c => Math.hypot(c[0] - x, c[1] - y) < cell * 3.5)) continue;
      const [sx, sy] = toScreen([x, y]), box = boxOf(sx, sy, tw, size, 0);
      if (overlaps(placed, box) || overlaps(obstacles(box), box)) continue;
      placed.push(box); chosen.push([x, y]);
      out.push({kind: "pour", id: region.id ?? null, text, x: sx, y: sy, angle: 0, size, ink, layer: region.layer});
    }
  }

  // ---------------------------------------------------------------- placement and drawing
  // place(v) -> labels [{kind, id, text, x, y (screen px), angle (radians), size (px), ink, layer}].
  // v: {items (objects in view), pours, scale, width, height, toScreen, view (world box), PCB, opts, trackInk(i), pourInk(region),
  //     maxWidth (widest track on the layer, to skip the whole pass when no track can carry a label),
  //     obstacles() or obstaclesFor(box) (screen boxes of components that could block a pour name)}
  function place(v) {
    const out = [], placed = [], {PCB, opts} = v, layer = opts.layer || "Top";
    if (opts.netNames === false || PCB.index(layer) < 0 || !PCB.visible(layer, null, opts)) return out;
    v.screen = [2, 2, v.width - 2, v.height - 2];
    const hidden = opts.hide, gone = opts.routePreview?.hidden?.length ? new Set(opts.routePreview.hidden) : null;
    if (!(v.maxWidth >= 0) || trackSize(v.maxWidth, v.scale) >= MIN_PX) {
      // Wider tracks first: they carry the larger text.
      const tracks = [];
      for (const i of v.items) {
        if (i.kind !== "track" || i.layer !== layer || !i.net || !(i.points?.length > 1) || hidden?.has(i) || gone?.has(i.id)) continue;
        if (globalThis.Atrium?.pathArc?.(i)) continue;
        if (trackSize(i.width || 0, v.scale) < MIN_PX) continue;
        tracks.push(i);
      }
      tracks.sort((a, b) => (b.width || 0) - (a.width || 0));
      for (const i of tracks) { trackLabels(out, placed, i, v); if (out.length >= MAX_LABELS) return out; }
    }
    if (!opts.hidden?.has("Source pours") && v.pours?.length) {
      // Ask for obstacles only after copper and label collision tests find a usable spot.
      let parts;
      const obstacles = v.obstaclesFor || (() => parts ??= v.obstacles?.() || []);
      for (const region of v.pours || []) {
        if (region?.layer !== layer || !region.net || !Array.isArray(region.bounds) || region.bounds.length !== 4) continue;
        const b = region.bounds;
        if (b[0] > v.view[2] || b[1] > v.view[3] || b[2] < v.view[0] || b[3] < v.view[1]) continue;
        pourLabels(out, placed, region, v, obstacles);
        if (out.length >= MAX_LABELS) break;
      }
    }
    return out;
  }
  function draw(ctx, labels, dpr, font) {
    if (!labels.length) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    let current = "";
    for (const l of labels) {
      const f = (l.kind === "pour" ? 600 : 500) + " " + l.size.toFixed(2) + "px " + font;
      if (f !== current) { ctx.font = f; current = f; }
      ctx.fillStyle = l.ink;
      if (l.angle) { ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.angle); ctx.fillText(l.text, 0, 0); ctx.restore(); }
      else ctx.fillText(l.text, l.x, l.y);
    }
    ctx.restore();
  }
  return Object.freeze({place, draw, clip, upright, MIN_PX, trackWidthLimit, trackCandidates});
})();
