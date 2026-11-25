"use strict";

// Independent reader for the ODB++ 8.1 subset emitted by Waffle. Format
// reference: Siemens ODB++Design 8.1 Update 4, pp. 32–39, 58–63, 138–141,
// 164–180 and Appendix A. Keep the product exporter out of this module.
const {bboxOf, gridFor, rasterize} = require("../formats/gerber-compare.cjs");
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const idPattern = /^\d+$/;
const tokenPattern = /^[A-Za-z0-9_.+\-]+$/;
const check = (ok, message) => { if (!ok) throw Error(message); };
const number = value => {
  check(numberPattern.test(value ?? "") && Number.isFinite(+value), "Invalid decimal: " + value);
  return +value;
};
const index = value => {
  check(idPattern.test(value ?? "") && Number.isSafeInteger(+value), "Invalid index: " + value);
  return +value;
};
const radians = angle => angle * Math.PI / 180;
const factor = unit => unit === "INCH" ? 25.4 : 1;
const darkOf = flag => {
  check(["P", "N"].includes(flag), "Invalid feature polarity: " + flag);
  return flag === "P";
};
const lines = text => text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
const fields = row => row.trim().split(/\s+/);
const capsule = ([x1,y1], [x2,y2], r, dark) => ({k:"capsule", x1, y1, x2, y2, r, dark});
const circle = ([x,y], r, dark) => ({k:"circle", x, y, r, dark});
const polygon = (rings, dark) => ({k:"poly", rings, dark});
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

function unitRows(text) {
  const [intro, ...rows] = lines(text), unit = /^UNITS=(MM|INCH)$/.exec(intro ?? "")?.[1];
  check(unit, "Missing or invalid UNITS directive");
  check(!rows.some(row => row.startsWith("UNITS=")), "Duplicate UNITS directive");
  return {unit, rows};
}

function structured(source) {
  const root = {type:"", fields:new Map(), blocks:[]}, stack = [root];
  for (const line of lines(source)) {
    const last = stack.at(-1);
    const block = /^([A-Za-z][\w-]*)\s*\{$/.exec(line);
    if (block) {
      const value = {type:block[1], fields:new Map(), blocks:[]};
      last.blocks.push(value);
      stack.push(value);
    } else if (line === "}") {
      check(stack.length > 1, "Unexpected closing brace");
      stack.pop();
    } else {
      const field = /^(\.?[A-Za-z][\w.-]*)\s*=\s*(.*)$/.exec(line);
      check(field && !last.fields.has(field[1]), "Invalid or duplicate structure field: " + line);
      last.fields.set(field[1], field[2]);
    }
  }
  check(stack.length === 1, "Unclosed structured record");
  return root;
}

function arcPoints(first, end, center, rotation, chord) {
  check(rotation === "Y" || rotation === "N", "Invalid arc direction");
  const [cx,cy] = center;
  const r1 = Math.hypot(first[0] - cx, first[1] - cy), r2 = Math.hypot(end[0] - cx, end[1] - cy);
  check(r1 > 0 && r2 > 0 && Math.abs(r1 - r2) <= .002, "Invalid arc radii");
  const a = Math.atan2(first[1] - cy, first[0] - cx), b = Math.atan2(end[1] - cy, end[0] - cx);
  const dir = rotation === "Y" ? -1 : 1;
  const sweep = samePoint(first, end) ? 2 * Math.PI : ((dir * (b - a)) + 2 * Math.PI) % (2 * Math.PI);
  const maxSegment = 2 * Math.acos(Math.max(-1, 1 - chord / Math.max(r1, r2)));
  const count = Math.max(1, Math.ceil(sweep / Math.max(maxSegment, .0001)));
  const points = [first];
  for (let i = 1; i < count; i++) {
    const at = i / count, rad = r1 + (r2 - r1) * at, angle = a + dir * sweep * at;
    points.push([cx + rad * Math.cos(angle), cy + rad * Math.sin(angle)]);
  }
  return [...points, end];
}

function orientation(args) {
  const code = index(args[0]);
  check(code <= 9 && args.length === (code < 8 ? 1 : 2), "Invalid pad orientation");
  const angle = code < 8 ? (code % 4) * 90 : number(args[1]);
  check(angle >= 0 && angle <= 360, "Pad rotation is outside 0–360 degrees");
  return {angle, mirrored:code === 9 || (code >= 4 && code <= 7)};
}

function transform([x,y], angle, mirrored, resize) {
  const theta = radians(-angle), k = mirrored ? -1 : 1;
  return ([px,py]) => [x + resize * k * (px * Math.cos(theta) - py * Math.sin(theta)),
    y + resize * (px * Math.sin(theta) + py * Math.cos(theta))];
}

function move(shape, transform, dark, resize = 1) {
  const paint = shape.dark === dark;
  if (shape.k === "poly") return polygon(shape.rings.map(ring => ring.map(transform)), paint);
  if (shape.k === "circle") return circle(transform([shape.x,shape.y]), shape.r * resize, paint);
  return capsule(transform([shape.x1,shape.y1]), transform([shape.x2,shape.y2]), shape.r * resize, paint);
}

function standard(name, scale) {
  const match = /^(r|s|rect|oval)([0-9.]+)(?:x([0-9.]+))?(?:x([rc])([0-9.]+))?$/.exec(name);
  if (!match) return;
  const [,kind,x,y,corner,amount] = match, w = number(x) * scale, h = y === undefined ? w : number(y) * scale;
  check(w > 0 && h > 0 && (kind === "r" || kind === "s") === (y === undefined), "Invalid standard symbol " + name);
  const rectangle = (a,b) => polygon([[[-a/2,-b/2],[a/2,-b/2],[a/2,b/2],[-a/2,b/2]]], true);
  if (corner) {
    const r = number(amount) * scale, a = w/2, b = h/2;
    check(kind === "rect" && r > 0 && r <= Math.min(a,b), "Invalid rectangle corner " + name);
    if (corner === "r") {
      const centres = [[a-r,b-r],[-a+r,b-r],[-a+r,-b+r],[a-r,-b+r]];
      return {shapes:[rectangle(w-2*r,h),rectangle(w,h-2*r),...centres.map(p => circle(p,r,true))]};
    }
    return {shapes:[polygon([[[-a+r,-b],[a-r,-b],[a,-b+r],[a,b-r],[a-r,b],[-a+r,b],[-a,b-r],[-a,-b+r]]],true)]};
  }
  if (kind === "r") return {round:w / 2, shapes:[circle([0,0], w / 2, true)]};
  if (kind === "oval") {
    const r = Math.min(w,h) / 2, dx = Math.max(0, (w - h) / 2), dy = Math.max(0, (h - w) / 2);
    return {shapes:[capsule([-dx,-dy], [dx,dy], r, true)]};
  }
  return {square:kind === "s" ? w : undefined, shapes:[rectangle(w,h)]};
}

function contourArea(points) {
  let twiceArea = 0;
  for (let i = 1; i < points.length; i++)
    twiceArea += points[i - 1][0] * points[i][1] - points[i][0] * points[i - 1][1];
  return twiceArea / 2;
}

function stepProfileTopology(rings) {
  const contains = (ring, [x,y]) => {
    let inside = false;
    for (let i = 1; i < ring.length; i++) {
      const [ax,ay] = ring[i-1], [bx,by] = ring[i];
      if ((ay > y) !== (by > y) && x < ax + (bx-ax)*(y-ay)/(by-ay)) inside = !inside;
    }
    return inside;
  };
  const edges = [];
  for (const [ring, {points}] of rings.entries()) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i-1], b = points[i];
      edges.push({a,b,ring,i,count:points.length-1,x0:Math.min(a[0],b[0]),x1:Math.max(a[0],b[0]),
        y0:Math.min(a[1],b[1]),y1:Math.max(a[1],b[1])});
    }
  }
  const turn = ([ax,ay], [bx,by], [cx,cy]) => Math.sign((bx-ax)*(cy-ay) - (by-ay)*(cx-ax));
  let active = [];
  for (const e of edges.sort((a,b) => a.x0-b.x0)) {
    active = active.filter(b => b.x1 >= e.x0);
    for (const b of active) {
      if (b.y0 > e.y1 || e.y0 > b.y1) continue;
      const n = Math.abs(b.i-e.i);
      if (b.ring === e.ring && (n === 1 || n === e.count-1)) continue;
      const cross = turn(e.a,e.b,b.a)*turn(e.a,e.b,b.b) <= 0 && turn(b.a,b.b,e.a)*turn(b.a,b.b,e.b) <= 0;
      check(!cross, "Profile boundaries touch or intersect");
    }
    active.push(e);
  }
  for (let i = 1; i < rings.length; i++) {
    const points = rings[i].points;
    check(contains(rings[0].points, points[0]), "Profile hole lies outside the island");
    for (let j = 1; j < i; j++) {
      const other = rings[j].points;
      check(!contains(other, points[0]) && !contains(points, other[0]), "Nested holes violate the step profile's single island");
    }
  }
}

function profileOrFeatures(text, {symbol, chord = .0005, profile = false} = {}) {
  const {unit, rows} = unitRows(text), scale = factor(unit), pt = (x,y) => [number(x) * scale, number(y) * scale];
  const symbols = new Map(), attributes = new Map(), strings = new Map(), features = [], shapes = [];
  let declared = null, surface, contour;
  const add = (value, geometry) => {
    features.push({...value, geometry});
    shapes.push(...geometry);
  };
  const sym = id => {
    const v = symbols.get(index(id));
    check(v, "Missing symbol index " + id);
    return v;
  };
  const table = (map, number, value) => {
    const i = index(number);
    check(!map.has(i), "Duplicate symbol or attribute index " + i);
    map.set(i, value);
  };
  const sweep = (points, tool, dark) => {
    if (tool.round) return points.slice(1).map((p,n) => capsule(points[n], p, tool.round, dark));
    check(tool.square && points.length === 2, "Unsupported stroke symbol");
    const [[x1,y1],[x2,y2]] = points, r = tool.square / 2;
    const vertices = [[x1-r,y1-r],[x1-r,y1+r],[x1+r,y1-r],[x1+r,y1+r],
      [x2-r,y2-r],[x2-r,y2+r],[x2+r,y2-r],[x2+r,y2+r]].sort((a,b) => a[0] - b[0] || a[1] - b[1]);
    const edge = seq => {
      const hull = [];
      for (const q of seq) {
        while (hull.length >= 2) {
          const a = hull.at(-2), b = hull.at(-1);
          if ((b[0]-a[0])*(q[1]-a[1]) > (b[1]-a[1])*(q[0]-a[0])) break;
          hull.pop();
        }
        hull.push(q);
      }
      return hull.slice(0,-1);
    };
    return [polygon([edge(vertices).concat(edge(vertices.reverse()))], dark)];
  };
  for (const row of rows) {
    const [body, assigns = "", identity = "", ...overflow] = row.split(";");
    check(!overflow.length, "Too many feature record separators: " + row);
    const [op, ...args] = fields(body);
    const arity = (...sizes) => check(sizes.includes(args.length), "Invalid " + op + " record: " + row);
    const value = {};
    if (assigns) {
      for (const pair of assigns.split(",")) {
        const [key, data, ...rest] = pair.split("=");
        check(!rest.length && attributes.has(index(key)), "Unknown feature attribute " + key);
        check(!Object.hasOwn(value, attributes.get(+key)), "Duplicate feature attribute " + key);
        value[attributes.get(+key)] = data ?? true;
      }
    }
    if (identity) check(/^ID=\d+$/.test(identity), "Invalid feature identity");
    if (contour) check(["OS","OC","OE"].includes(op), "Unclosed feature contour before " + op);
    else if (surface) check(["OB","SE"].includes(op), "Unclosed surface before " + op);
    if (op.startsWith("$")) {
      arity(1,2);
      const [name, specified] = args;
      check(!specified || ["M","I"].includes(specified), "Invalid symbol measurement flag");
      const symScale = (specified === "M" ? 1 : specified === "I" ? 25.4 : scale) / 1000;
      const tool = standard(name, symScale) ?? symbol?.(name);
      check(tool, "No standard or user-defined symbol " + name);
      table(symbols, op.slice(1), tool);
    } else if (op.startsWith("@")) {
      arity(1);
      table(attributes, op.slice(1), args[0]);
    } else if (op.startsWith("&")) {
      table(strings, op.slice(1), args.join(" "));
    } else if (op.startsWith("ID=")) {
      arity(0);
      index(op.slice(3));
    } else if (op === "F") {
      arity(1);
      check(declared === null, "Duplicate feature count");
      declared = index(args[0]);
    } else if (op === "P") {
      arity(6,7,8,9);
      const at = pt(...args), resized = args[2] === "-1";
      const tool = sym(args[resized ? 3 : 2]), resize = resized ? (1 + number(args[4]) / 1000 * scale / (tool.round * 2)) : 1;
      check(Number.isFinite(resize) && resize > 0, "Unsupported resized pad symbol");
      const start = resized ? 5 : 3, dark = darkOf(args[start]), dcode = index(args[start + 1]);
      const {angle, mirrored} = orientation(args.slice(start + 2)), transformPoint = transform(at, angle, mirrored, resize);
      add({op, at, dark, dcode, tool, attributes:value}, tool.shapes.map(shape => move(shape, transformPoint, dark, resize)));
    } else if (op === "L" || op === "A") {
      const arc = op === "A", i = arc ? 6 : 4;
      arity(arc ? 10 : 7);
      const first = pt(...args), end = pt(...args.slice(2));
      const tool = sym(args[i]), dark = darkOf(args[i + 1]), dcode = index(args[i + 2]);
      const points = arc ? arcPoints(first,end,pt(...args.slice(4)),args[9],chord) : [first,end];
      add({op, first, end, dark, dcode, tool, attributes:value}, sweep(points,tool,dark));
    } else if (op === "S") {
      arity(2);
      surface = {op, dark:darkOf(args[0]), dcode:index(args[1]), attributes:value, contours:[]};
    } else if (op === "OB") {
      arity(3);
      check(surface && ["I","H"].includes(args[2]), "Invalid island/hole record");
      contour = {kind:args[2], points:[pt(...args)], segments:0};
    } else if (op === "OS" || op === "OC") {
      const arc = op === "OC";
      arity(arc ? 5 : 2);
      check(contour, "Contour segment outside polygon");
      const end = pt(...args), start = contour.points.at(-1);
      if (arc) contour.points.push(...arcPoints(start,end,pt(...args.slice(2)),args[4],chord).slice(1));
      else contour.points.push(end);
      if (profile) check(!samePoint(start,end), "Zero-length or full-circle profile segment");
      contour.segments++;
    } else if (op === "OE") {
      arity(0);
      check(contour && contour.points.length >= 4 && samePoint(contour.points[0],contour.points.at(-1)), "Unclosed feature polygon");
      const area = contourArea(contour.points);
      check(area, "Empty feature polygon");
      if (profile) {
        check(contour.segments >= 3, "Profile polygon needs at least three segments");
        check((area < 0) === (contour.kind === "I"), "Invalid profile winding");
      } else if ((area > 0) !== (contour.kind === "I")) contour.points.reverse();
      surface.contours.push(contour);
      contour = null;
    } else if (op === "SE") {
      arity(0);
      check(surface?.contours[0]?.kind === "I", "Surface must start with an island");
      if (profile) {
        check(surface.dark && surface.contours.filter(r => r.kind === "I").length === 1, "A profile needs one positive island");
        stepProfileTopology(surface.contours);
      }
      add(surface, [polygon(surface.contours.map(r => r.points),surface.dark)]);
      surface = null;
    } else throw Error("Unexpected ODB++ feature " + op);
  }
  check(!surface && !contour, "Unclosed surface at end of file");
  check(declared === null || declared === features.length, "Declared feature count disagrees with body");
  if (profile) check(features.length === 1 && features[0].op === "S", "A step profile needs exactly one surface");
  return {unit, features, shapes, bbox:bboxOf(shapes), attributes, strings};
}

function layerXor(actual, reference, {pixel = .005, phase = .371} = {}) {
  const grid = gridFor([actual.bbox, reference.bbox], pixel, .2, phase);
  check(grid.w * grid.h < 8e9, "Comparison raster exceeds test budget");
  const height = Math.min(grid.h, Math.max(1, Math.floor(8e6 / grid.w)));
  const begin = plot => plot.shapes.map(shape => [bboxOf([{...shape,dark:true}]),shape]).filter(([box]) => box);
  const planes = [begin(actual), begin(reference)];
  let differ = 0, first;
  for (let row = 0; row < grid.h; row += height) {
    const tile = {...grid,y0:grid.y0 + row * pixel,h:Math.min(grid.h-row,height)};
    const end = tile.y0 + tile.h * pixel;
    const [x,y] = planes.map(plane => rasterize(plane.filter(([box]) => box[3] >= tile.y0 && box[1] <= end).map(([,shape]) => shape),tile));
    if (Buffer.compare(x,y) === 0) continue;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) {
      differ++;
      first ??= [grid.x0 + ((i % grid.w) + .5) * pixel, grid.y0 + (row + Math.floor(i / grid.w) + .5) * pixel];
    }
  }
  return {differ, first, pixel, width:grid.w, height:grid.h};
}

function unpack(tgz) {
  const {gunzipSync} = require("node:zlib");
  check(tgz[0] === 0x1f && tgz[1] === 0x8b && tgz[2] === 8, "ODB++ output is not gzip");
  const raw = gunzipSync(tgz, {maxOutputLength:192 * 1024 * 1024});
  check(raw.length % 512 === 0, "Invalid archive block boundary");
  const entries = new Map(), visited = new Set(), decoder = new TextDecoder("utf-8", {fatal:true});
  const string = (bytes, from, to) => decoder.decode(bytes.subarray(from,to)).split("\0")[0];
  const octal = value => {
    check(/^[0-7]+$/.test(value.trim()), "Invalid tar octal field");
    return parseInt(value.trim(), 8);
  };
  let root, end = 0;
  for (let i = 0; i + 512 <= raw.length; ) {
    const header = raw.subarray(i,i + 512);
    if (!header.some(Boolean)) {
      end = i;
      break;
    }
    check(string(header,257,263) === "ustar", "Archive member lacks the ustar header");
    const sum = header.reduce((total, value, offset) => total + (148 <= offset && offset < 156 ? 32 : value), 0);
    check(octal(string(header,148,156)) === sum, "Archive member has an invalid header checksum");
    const name = string(header,0,100), prefix = string(header,345,500), type = header[156];
    const path = (prefix ? prefix + "/" + name : name).replace(/\/$/,"");
    const segments = path.split("/");
    check(segments.every(s => s !== "." && s !== ".." && tokenPattern.test(s)) && !visited.has(path), "Unsafe or duplicate archive member " + path);
    visited.add(path);
    root ??= segments[0];
    check(segments[0] === root, "Expected one ODB++ product-model root");
    const size = octal(string(header,124,136));
    check((type === 0 || type === 48) && segments.length >= 2 || type === 53 && size === 0,
      "Unexpected archive member type " + path);
    const start = i + 512;
    i = start + Math.ceil(size / 512) * 512;
    check(i <= raw.length && !raw.subarray(start + size,i).some(Boolean), "Malformed archive data padding");
    if (type !== 53) entries.set(segments.slice(1).join("/"), decoder.decode(raw.subarray(start,start + size)));
  }
  check(end > 0 && raw.length - end >= 1024 && !raw.subarray(end).some(Boolean), "Missing two zero tar end records");
  return {root, entries};
}

const copperTypes = new Set(["SIGNAL","POWER_GROUND","MIXED"]);
const layerTypes = new Set([...copperTypes,"SOLDER_MASK","SOLDER_PASTE","SILK_SCREEN","DRILL","ROUT",
  "DOCUMENT","DIELECTRIC","COMPONENT","MASK","CONDUCTIVE_PASTE"]);
function standardFont(source) {
  const rows = lines(source), metrics = [];
  for (const key of ["XSIZE","YSIZE","OFFSET"]) {
    const [tag,value,...overflow] = fields(rows[metrics.length] ?? "");
    check(tag === key && !overflow.length, "Invalid font header: " + key);
    const size = number(value);
    check(key === "OFFSET" ? size >= 0 : size > 0, "Invalid font size: " + key);
    metrics.push(size);
  }
  const glyphs = new Map();
  for (let i=metrics.length; i<rows.length;) {
    const character = /^CHAR ([!-~])$/.exec(rows[i++])?.[1], strokes = [];
    check(character && !glyphs.has(character), "Invalid or duplicate font character");
    while (rows[i] !== "ECHAR") {
      const [tag,x1,y1,x2,y2,polarity,ends,width,...overflow] = fields(rows[i++] ?? "");
      check(tag === "LINE" && ["P","N"].includes(polarity) && ["R","S"].includes(ends) && !overflow.length,
        "Invalid font line for " + character);
      const size = number(width);
      check(size > 0, "Invalid font stroke width");
      strokes.push({start:[number(x1),number(y1)],end:[number(x2),number(y2)],polarity,ends,width:size});
    }
    check(strokes.length > 0, "Empty font character " + character);
    glyphs.set(character,strokes);
    i++;
  }
  check(glyphs.size === 94, "Standard font does not contain all 94 ASCII glyphs");
  return {metrics,glyphs};
}

function matrix(text) {
  const root = structured(text), steps = new Map(), layers = new Map(), uid = new Map();
  check(root.fields.size === 0, "Unexpected matrix header fields");
  for (const row of root.blocks) {
    const get = key => row.fields.get(key), name = get("NAME")?.toLowerCase();
    check(row.blocks.length === 0 && tokenPattern.test(name ?? ""), "Invalid matrix name");
    if (row.type === "STEP") {
      const col = index(get("COL"));
      check(!steps.has(name) && col === steps.size + 1, "Step columns are not unique and sequential");
      steps.set(name, {name,col});
    } else if (row.type === "LAYER") {
      const num = index(get("ROW")), type = get("TYPE"), context = get("CONTEXT"), polarity = get("POLARITY");
      const start = get("START_NAME")?.toLowerCase() || "", end = get("END_NAME")?.toLowerCase() || "";
      check(!layers.has(name) && num === layers.size + 1, "Layer rows are not unique and in stack order");
      check(layerTypes.has(type) && ["BOARD","MISC"].includes(context) && ["POSITIVE","NEGATIVE"].includes(polarity),
        "Invalid matrix layer type, context or polarity " + name);
      check(copperTypes.has(type) || polarity === "POSITIVE", "Wrong manufacturing layer polarity " + name);
      const row = {name,num,type,context,polarity,start,end,subtype:get("ADD_TYPE"),form:get("FORM"),
        reference:get("REF") === undefined ? null : index(get("REF"))};
      if (get("ID") !== undefined) {
        const id = index(get("ID"));
        check(!uid.has(id), "Duplicate matrix layer UID");
        uid.set(id,row);
      }
      layers.set(name,row);
    } else throw Error("Unexpected matrix block " + row.type);
  }
  check(steps.has("pcb") && layers.size > 0, "No PCB step or matrix layers");
  for (const layer of layers.values()) {
    if (layer.start || layer.end) {
      check(["DRILL","ROUT"].includes(layer.type), "Unexpected span on non-drill/rout layer");
      const first = layers.get(layer.start), last = layers.get(layer.end);
      check(copperTypes.has(first?.type) && copperTypes.has(last?.type) && first.num < last.num, "Invalid drill/rout span " + layer.name);
    }
    if (layer.subtype === "COVERLAY") check(layer.type === "SOLDER_MASK", "Coverlay must be a solder mask subtype");
    if (layer.subtype === "BACKDRILL") check(layer.type === "DRILL", "Backdrill must be a drill subtype");
    if (layer.reference != null) check(["SOLDER_MASK","SOLDER_PASTE","SILK_SCREEN","MASK","CONDUCTIVE_PASTE"].includes(layer.type) &&
      copperTypes.has(uid.get(layer.reference)?.type), "Invalid adjacent copper reference " + layer.name);
  }
  return {steps,layers,uid};
}

function stackup(text, matrix) {
  const total = number(/<Stackup\b[^>]*\bStackupThickness="([^"]+)" Units="MM">/.exec(text)?.[1]);
  check(/<StackupFile\b[^>]*\bVersion="8\.1"[^>]*\bDefaultUnits="MM">/.test(text) &&
    /<\/StackupFile>\s*$/.test(text), "Invalid ODB++ stackup version or unit");
  const materials = new Map(), layers = new Map();
  for (const [,name,body] of text.matchAll(/<Material MaterialName="([^"]+)">(.*?)<\/Material>/gs)) {
    const thickness = number(/<Default_Thickness Thickness="([^"]+)" Units="MM"\/>/.exec(body)?.[1]);
    check(!materials.has(name) && thickness >= 0, "Unknown or duplicate stack material");
    materials.set(name,thickness);
  }
  let previous = 0;
  for (const [,name,type,side,subtype,body] of text.matchAll(/<Layer LayerName="([^"]+)" LayerType="([^"]+)" Side="([^"]+)"(?: LayerSubType="([^"]+)")?>(.*?)<\/Layer>/gs)) {
    const material = /<Material MaterialName="([^"]+)"\/>/.exec(body)?.[1], registered = matrix.layers.get(name);
    check(!layers.has(name) && registered?.type === type && (subtype ?? "") === registered.subtype &&
      materials.has(material) && ["TOP","BOTTOM","INNER"].includes(side),
      "Invalid layer or material link in stackup: " + name);
    check(registered.num > previous, "Stackup and matrix layer order differ");
    previous = registered.num;
    layers.set(name,{thickness:materials.get(material),material,side});
  }
  const physical = [...matrix.layers.values()].filter(layer => copperTypes.has(layer.type) || layer.type === "DIELECTRIC");
  check(physical.length > 1 && physical.every(row => layers.has(row.name) && layers.get(row.name).thickness > 0),
    "A copper or dielectric thickness is missing");
  const sum = [...layers.values()].reduce((acc,row) => acc + row.thickness,0);
  check(Math.abs(total-sum) <= (layers.size + 1) * .00000051, "Stackup total and layer thicknesses disagree");
  return {total,layers};
}

function tools(text) {
  const {unit} = unitRows(text), root = structured(text), out = new Map();
  for (const row of root.blocks) {
    const get = key => row.fields.get(key), type = get("TYPE"), subtype = get("TYPE2") ?? "STANDARD";
    const num = index(get("NUM")), finished = number(get("FINISH_SIZE")), size = finished === -1 ? number(get("DRILL_SIZE")) : finished;
    check(row.type === "TOOLS" && row.blocks.length === 0 && !out.has(num) && num > 0 && size > 0,
      "Invalid or duplicate drill tool");
    check(["PLATED","NON_PLATED","VIA"].includes(type), "Invalid drill plating/tool type");
    check(subtype === "STANDARD" || type === "VIA" && ["PHOTO","LASER"].includes(subtype) || type === "PLATED" && subtype === "PRESS_FIT",
      "Invalid drill tool subtype");
    out.set(num,{size:size * factor(unit) / 1000,type,subtype,plated:type !== "NON_PLATED"});
  }
  return out;
}

function drillFeatures(plot, table, layer) {
  const hits = [], slots = [];
  for (const row of plot.features) {
    const tool = table.get(row.dcode);
    check(row.dark && tool && row.tool.round && Math.abs(row.tool.round * 2 - tool.size) < .000002,
      "Drill feature lacks its declared tool or matching diameter");
    const drill = row.attributes[".drill"], routPlated = row.attributes[".rout_plated"];
    check(["PLATED","NON_PLATED","VIA"][drill] === tool.type, "Feature drill type and tool table disagree");
    check(Boolean(routPlated) === (layer.type === "ROUT" && tool.plated), "Plated slot has no route plating flag");
    const stub = layer.subtype === "BACKDRILL" ? number(row.attributes[".backdrill_max_stub_drill"]) * factor(plot.unit) / 1000 : null;
    check(stub === null || stub >= 0, "Invalid backdrill maximum stub");
    const type = {d:tool.size, tool:row.dcode, plated:tool.plated, subtype:tool.subtype, stub};
    if (row.op === "P") hits.push({...type, x:row.at[0],y:row.at[1]});
    else if (row.op === "L") slots.push({...type, a:row.first,b:row.end});
    else check(row.op === "A", "Unexpected drill or route geometry");
  }
  return {hits,slots};
}

function cadnet(text, matrix, plots) {
  const rows = lines(text);
  if (rows[0]?.startsWith("H ")) rows.unshift(rows.splice(1,1)[0] ?? "");
  const file = unitRows(rows.join("\n")), scale = factor(file.unit), nets = new Map(), points = [];
  const header = file.rows.shift();
  check(/^H optimize n(?: staggered [yn])?$/.test(header ?? ""), "Invalid CAD netlist header");
  const names = new Set(), featureIds = new Map([...plots].filter(([,plot]) => plot.id).map(([name,plot]) => [plot.id,matrix.layers.get(name)]));
  for (const row of file.rows) {
    const [lead,...args] = fields(row);
    if (lead.startsWith("$")) {
      const i = index(lead.slice(1)), name = args[0];
      check(args.length === 1 && /^[!-:<-~]+$/.test(name) && !names.has(name) && i === nets.size && !points.length, "Invalid CAD net name table");
      names.add(name);
      nets.set(i,name);
    } else {
      const net = lead === "-1" ? -1 : index(lead), [radius,x,y,side,...rest] = args;
      check((nets.has(net) || net === -1) && ["T","D","B","I"].includes(side), "Missing CAD net or invalid access side");
      const [w,h] = numberPattern.test(rest[0]) ? [number(rest.shift()) * scale, number(rest.shift()) * scale] : [null,null];
      const [end, exposed, ...flags] = rest;
      check(["e","m"].includes(end) && ["e","c","p","s"].includes(exposed), "Invalid net point endpoint/exposure");
      const pointer = flags.find(value => /^ld=/.test(value));
      const layer = pointer ? featureIds.get(index(pointer.slice(3))) : null;
      check(!pointer || layer, "Net point refers to an unknown feature file ID");
      if (side === "B" && layer) check(["DRILL","ROUT"].includes(layer.type), "Both-side net point must reference its drill or rout layer");
      if (side === "I") check(layer && ["SIGNAL","POWER_GROUND","MIXED"].includes(layer.type), "Inner net point must reference its copper layer");
      const r = number(radius) * scale;
      check(r >= 0, "Negative net hole radius");
      points.push({net:nets.get(net) ?? null,r,x:number(x) * scale,y:number(y) * scale,side,w,h,end,exposed,flags});
    }
  }
  check(nets.get(0) === "$NONE$", "Missing $NONE$ CAD net");
  return {unit:file.unit,nets,points};
}

function edaData(text, matrix, plots) {
  const {unit, rows} = unitRows(text), nets = [], packages = [];
  let layerNames, subnet;
  for (const row of rows) {
    const [op, ...args] = fields(row.split(";")[0]), net = nets.at(-1), pkg = packages.at(-1);
    if (op === "LYR") {
      check(!layerNames && args.length > 0, "Missing or duplicate EDA layer table");
      layerNames = args.map(name => name.toLowerCase());
      check(new Set(layerNames).size === layerNames.length && layerNames.every(name => matrix.layers.has(name)), "EDA refers to unknown matrix layers");
    } else if (op === "NET") {
      check(args.length === 1, "Malformed EDA net");
      nets.push({name:args[0], subnets:[]});
      subnet = null;
    } else if (op === "SNT") {
      const [type,...rest] = args;
      check(net && ["TOP","VIA","TRC","PLN"].includes(type) &&
        rest.length === (type === "TOP" || type === "PLN" ? 3 : 0), "Invalid EDA subnet");
      const contact = type === "TOP" ? {side:rest[0], component:index(rest[1]), pin:index(rest[2])} : null;
      if (contact) check(["T","B"].includes(contact.side), "Invalid EDA toeprint side");
      net.subnets.push(subnet = {type,contact,features:[]});
    } else if (op === "FID") {
      const [type,layer,ref] = args, name = layerNames?.[index(layer)], row = matrix.layers.get(name), i = index(ref);
      check(args.length === 3 && subnet && plots.get(name)?.features[i] && ["C","L","H"].includes(type), "Broken EDA feature address");
      const valid = type === "C" ? copperTypes.has(row.type) : type === "H" ? ["DRILL","ROUT"].includes(row.type) : row.type === "DIELECTRIC";
      check(valid, "EDA feature is stored on the wrong layer type");
      subnet.features.push({type,name,index:i});
    } else if (op === "PKG") {
      check(args.length === 6, "Malformed EDA package");
      const [pitch,x1,y1,x2,y2] = args.slice(1).map(number);
      check(pitch >= 0 && x1 <= x2 && y1 <= y2, "Malformed EDA package bounds");
      packages.push({name:args[0], pins:[], outline:false});
    } else if (op === "PIN") {
      check(pkg?.outline && args.length === 7, "EDA pin is missing a package outline");
      const [name,type,x,y,hole,electrical,mount] = args;
      pkg.pins.push({name,type,x:number(x),y:number(y),hole:number(hole),electrical,mount});
    } else if (["RC","CR","SQ","CT","OB","OS","OC","OE","CE"].includes(op)) {
      check(pkg, "Outline outside an EDA package");
      pkg.outline = true;
    } else check(op === "HDR" || op === "PRP" || op.startsWith("@") || op.startsWith("&") || op.startsWith("ID="),
      "Unexpected EDA record " + op);
  }
  check(layerNames && nets[0]?.name === "$NONE$" && packages.every(pkg => pkg.outline), "Incomplete EDA data file");
  return {unit,nets,packages};
}

function componentData(text, eda) {
  const {unit,rows} = unitRows(text), scale = factor(unit), components = [];
  for (const row of rows) {
    const [op, ...args] = fields(row.split(";")[0]), parent = components.at(-1);
    if (op === "CMP") {
      const [pkg,x,y,angle,mirror,ref,part] = args, pack = eda.packages[index(pkg)], rotation = number(angle);
      check(args.length === 7 && pack && ["M","N"].includes(mirror) && rotation >= 0 && rotation <= 360, "Malformed component or unresolved package");
      components.push({ref,part,pack,x:number(x)*scale,y:number(y)*scale,rotation,mirrored:mirror === "M",pins:new Map(),properties:[]});
    } else if (op === "TOP") {
      const [pin,x,y,angle,mirror,net,subnet,name] = args, pinIndex = index(pin), netIndex = index(net);
      check(args.length === 8 && parent?.pack.pins[pinIndex] && !parent.pins.has(pinIndex) && eda.nets[netIndex] &&
        ["M","N"].includes(mirror) && number(angle) >= 0 && number(angle) <= 360, "Malformed component toeprint");
      const sub = subnet === "-1" ? -1 : index(subnet);
      check(sub === -1 && netIndex === 0 || !!eda.nets[netIndex].subnets[sub], "Unresolved toeprint subnet");
      parent.pins.set(pinIndex,{name,x:number(x)*scale,y:number(y)*scale,net:eda.nets[netIndex].name,netIndex,sub});
    } else if (op === "PRP") {
      check(parent && /^PRP [^\s]+ '.*'/.test(row), "Malformed component property");
      parent.properties.push(row);
    } else check(op.startsWith("@") || op.startsWith("&") || op.startsWith("ID="), "Unexpected component record " + op);
  }
  return components;
}

function checkToeprints(eda, components) {
  for (const [netIndex,net] of eda.nets.entries()) for (const [subIndex,sub] of net.subnets.entries()) {
    if (!sub.contact) continue;
    const {side,component,pin} = sub.contact, toeprint = components[side][component]?.pins.get(pin);
    check(toeprint && toeprint.netIndex === netIndex && toeprint.sub === subIndex, "EDA toeprint is not bidirectionally linked to its component pin");
  }
}

function read(tgz) {
  const {root,entries} = unpack(tgz), required = name => {
    check(entries.has(name), "Missing " + name);
    return entries.get(name);
  };
  const layerMatrix = matrix(required("matrix/matrix")), info = structured(required("misc/info")).fields;
  check(info.get("ODB_VERSION_MAJOR") === "8" && info.get("ODB_VERSION_MINOR") === "1", "Expected ODB++ 8.1");
  const font = standardFont(required("fonts/standard"));
  const stack = stackup(required("matrix/stackup.xml"),layerMatrix);
  const symbolCache = new Map(), active = new Set(), symbol = name => {
    check(tokenPattern.test(name), "Invalid symbol name");
    if (symbolCache.has(name)) return symbolCache.get(name);
    const path = "symbols/" + name + "/features";
    check(!active.has(name), "Circular user-defined symbol " + name);
    active.add(name);
    const parsed = profileOrFeatures(required(path), {symbol});
    check(parsed.features.length > 0, "Empty user-defined symbol " + name);
    active.delete(name);
    symbolCache.set(name,parsed);
    return parsed;
  };
  const steps = new Map(), usedIds = new Set(layerMatrix.uid.keys());
  for (const name of layerMatrix.steps.keys()) {
    const pref = "steps/" + name + "/", profile = profileOrFeatures(required(pref + "profile"), {symbol,profile:true});
    const headerSource = required(pref + "stephdr");
    const {unit} = unitRows(headerSource), header = structured(headerSource);
    for (const key of ["X_DATUM","Y_DATUM","X_ORIGIN","Y_ORIGIN"]) number(header.fields.get(key));
    const repeat = header.blocks.map(row => {
      const get = key => row.fields.get(key), child = get("NAME")?.toLowerCase(), angle = number(get("ANGLE"));
      const [nx,ny] = [index(get("NX")),index(get("NY"))];
      check(row.type === "STEP-REPEAT" && row.blocks.length === 0 && child !== name && layerMatrix.steps.has(child) &&
        angle >= 0 && angle <= 360 && nx > 0 && ny > 0 && nx * ny <= 900 &&
        ["YES","NO"].includes(get("MIRROR")) && ["YES","NO"].includes(get("FLIP")), "Invalid step repeat");
      return {child,angle,nx,ny,x:number(get("X")) * factor(unit),y:number(get("Y")) * factor(unit),
        dx:number(get("DX")) * factor(unit),dy:number(get("DY")) * factor(unit),mirrored:get("MIRROR") === "YES",
        flip:get("FLIP") === "YES"};
    });
    const layers = new Map(), attributes = new Map();
    for (const [layer, row] of layerMatrix.layers) {
      const dir = pref + "layers/" + layer + "/";
      const source = entries.get(dir + "features"), attr = entries.get(dir + "attrlist");
      if (attr !== undefined) {
        unitRows(attr);
        attributes.set(layer,structured(attr).fields);
      }
      if (row.type === "DIELECTRIC" || row.type === "COMPONENT") {
        check(source === undefined, "Geometry stored on incompatible layer " + layer);
        required(dir+(row.type==="DIELECTRIC"?"attrlist":"components"));
        continue;
      }
      required(dir+"features");
      const plot = profileOrFeatures(source, {symbol});
      plot.id = index(/^ID=(\d+)$/m.exec(source)?.[1]);
      check(!usedIds.has(plot.id), "Duplicate layer feature ID " + plot.id);
      usedIds.add(plot.id);
      if (["DRILL","ROUT"].includes(row.type) && row.start) {
        const attr = attributes.get(layer);
        plot.drillDirection = attr?.get(".drill_layer_direction");
        check(["top2bottom","bottom2top"].includes(plot.drillDirection), "Missing or invalid drill direction " + layer);
        if (row.subtype === "BACKDRILL") {
          plot.stop = attr.get(".backdrill_penetrate_stop_layer");
          check(plot.stop === (plot.drillDirection === "bottom2top" ? row.start : row.end), "Backdrill stop layer and span disagree");
        }
        if (plot.features.length) plot.drill = drillFeatures(plot,tools(required(dir + "tools")),row);
      }
      layers.set(layer,plot);
    }
    if (name === "panel") check(repeat.some(row => row.child === "pcb"), "Panel does not repeat the PCB step");
    const edaFile = pref + "eda/data", cadFile = pref + "netlists/cadnet/netlist";
    const hasElectrical = name === "pcb" || entries.has(edaFile);
    const eda = hasElectrical ? edaData(required(edaFile),layerMatrix,layers) : null;
    const electrical = hasElectrical ? cadnet(required(cadFile),layerMatrix,layers) : null;
    const components = eda ? {
      T:componentData(required(pref + "layers/comp_+_top/components"),eda),
      B:componentData(required(pref + "layers/comp_+_bot/components"),eda)
    } : null;
    if (eda) checkToeprints(eda, components);
    steps.set(name,{profile,repeat,layers,attributes,electrical,eda,components});
  }
  check(Math.max(...usedIds) === index(info.get("MAX_UID")), "Wrong product model MAX_UID");
  for (const name of entries.keys()) {
    const valid = /^(?:fonts\/standard|matrix\/(?:matrix|stackup\.xml)|misc\/(?:info|attrlist)|symbols\/[^/]+\/features|steps\/[^/]+\/(?:profile|stephdr|attrlist|eda\/data|netlists\/cadnet\/netlist|layers\/[^/]+\/(?:attrlist|features|tools|components)|boms\/[^/]+\/bom))$/.test(name);
    check(valid, "Unexpected product-model archive member " + name);
    const step = /^steps\/([^/]+)\//.exec(name);
    if (step) check(steps.has(step[1]), "Orphan file in undisclosed step " + name);
    const layer = /^steps\/[^/]+\/layers\/([^/]+)\//.exec(name);
    if (layer) check(layerMatrix.layers.has(layer[1]), "Orphan geometry references no matrix layer " + name);
  }
  return {root,entries,matrix:layerMatrix,stack,steps,font};
}

function panelLayer(product, name) {
  const panel = product.steps.get("panel");
  check(panel, "Expected a real panel step");
  const shapes = [];
  for (const row of panel.repeat) {
    const child = product.steps.get(row.child);
    check(child && !child.repeat.length && !row.flip, "Unexpected nested or layer-flipped panel");
    const plot = child.layers.get(name);
    if (!plot) continue;
    for (let j = 0; j < row.ny; j++) for (let i = 0; i < row.nx; i++) {
      const map = transform([row.x + row.dx*i,row.y + row.dy*j],row.angle,row.mirrored,1);
      for (const shape of plot.shapes) shapes.push(move(shape,map,true));
    }
  }
  shapes.push(...(panel.layers.get(name)?.shapes ?? []));
  return {shapes,bbox:bboxOf(shapes)};
}

module.exports = {read, unpack, matrix, cadnet, edaData, componentData, profileOrFeatures, layerXor, panelLayer, standardFont};
