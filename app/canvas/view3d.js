"use strict";
if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// 3D layout view (key 3; key 2 returns to 2D). Loaded on first use by editor.js.
//
// No 3D library: a ~40-line shader pair over plain WebGL2 (or WebGL1 with
// ANGLE_instanced_arrays + OES_element_index_uint). Geometry comes from
// AtriumSTEP.model/mesh (board prisms with true arcs, generated or boxed
// component bodies, optional copper and silk); identical bodies share arrays
// and are drawn instanced.
//
// Rendering is on demand only: input, camera animation, option changes and
// editor refreshes request a single animation frame. Nothing runs while idle.
// Meshes follow the committed board, library and assembly data. They are
// built and uploaded on demand while visible and deleted on close.
// Pressing 3 draws the board and component bodies at once; copper, silk and mask openings follow
// in time-sliced tasks (layerJob) and STEP bodies from a worker, both cancelled when the view hides.
// Covered copper takes the mask colour; bare copper shows only at mask openings (stencil).
// The first camera looks straight down over the 2D framing; the last one is kept per document
// (storeCamera: in memory, and in a folder project's local workspace state).
//
// API (editor.js):
//   open(ctx)            ctx: {doc, defs, project, stage, info, revision(), and optionally
//                        document(), selection(), select(ids), activate(), alive(), exportFile(name, bytes),
//                        view2d() (canvas.js camera), folder() (the folder session, for the stored 3D camera),
//                        camera3d(cam?) (optional: replaces that store)}
//   isOpen(stage)        open on that stage (no argument: on any stage)
//   close(stage)         close on that stage (no argument: all)
//   command(action, stage, param)  editor actions while 3D is open; true when handled
//   refresh()            re-check revision, document and selection (called from the editor's frame)
//   stats(stage)         renderer and build figures
// Embedded STEP models are tessellated in a worker (step-import.js, lazy) and replace their
// bounding boxes when ready. Collisions (toolbar; collision-3d.js, lazy) tints bodies that
// break the board's Component Clearance rule, or simply touch, at the current fold. View options ›
// Rigid-flex › Preview folded STEP writes the folded STEP export and shows it read back.
// Pure helpers for tests: math, buildScene, pick.
globalThis.Atrium3D = (() => {
  const D2R = Math.PI / 180, now = () => globalThis.performance?.now ? performance.now() : Date.now();

  // ---------------------------------------------------------------- math (column-major 4x4)
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  function invert(m) {
    const a = m, o = new Float64Array(16);
    const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4], b03 = a[1] * a[6] - a[2] * a[5];
    const b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6], b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12];
    const b08 = a[8] * a[15] - a[11] * a[12], b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    const d = 1 / det;
    o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * d; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * d;
    o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * d; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * d;
    o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * d; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * d;
    o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * d; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * d;
    o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * d; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * d;
    o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * d; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * d;
    o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * d; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * d;
    o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * d; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * d;
    return o;
  }
  const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);

  // Camera: orbit about `target`; yaw/pitch in degrees, pitch in [-90, 90] (90 looks
  // straight down). The up vector is the derivative of the eye direction, so the
  // poles are well defined: pitch 90, yaw -90 is the 2D view (x right, y up).
  const TOP = {yaw: -90, pitch: 90}, BOTTOM = {yaw: 90, pitch: -90}, HOME = {yaw: -115, pitch: 38};
  function frame(cam) {
    const cy = Math.cos(cam.yaw * D2R), sy = Math.sin(cam.yaw * D2R), cp = Math.cos(cam.pitch * D2R), sp = Math.sin(cam.pitch * D2R);
    const back = [cp * cy, cp * sy, sp], up = [-sp * cy, -sp * sy, cp], fwd = [-back[0], -back[1], -back[2]];
    return {eye: add(cam.target, back, cam.dist), fwd, up, right: cross(fwd, up), back};
  }
  // View-projection for an aspect ratio; near/far hug the scene sphere {c, r}.
  function matrices(cam, aspect, sphere) {
    const f = frame(cam), {eye, up, right, back} = f;
    const view = new Float32Array([right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0,
      -dot(right, eye), -dot(up, eye), -dot(back, eye), 1]);
    const r = sphere?.r || cam.dist, dc = sphere ? len(sub(sphere.c, eye)) : cam.dist;
    const far = Math.max(dc + r * 1.2, 1e-3), near = Math.max(dc - r * 1.2, far / 4000);
    const t = 1 / Math.tan(cam.fov * D2R / 2);
    const proj = new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
    return {...f, view, proj, vp: mul(proj, view), near, far};
  }
  // Ray through normalised device coordinates (x right, y up, both in [-1, 1]).
  function ray(cam, aspect, nx, ny) {
    const f = frame(cam), t = Math.tan(cam.fov * D2R / 2);
    const d = add(add(f.fwd, f.right, nx * t * aspect), f.up, ny * t), l = len(d);
    return {o: f.eye, d: [d[0] / l, d[1] / l, d[2] / l]};
  }
  function project(vp, p, w, h) {
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const W = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    return W > 1e-9 ? [(x / W + 1) / 2 * w, (1 - y / W) / 2 * h] : null;
  }
  // Slab test; returns the entry distance (0 when inside) or Infinity.
  function rayBox(o, d, b) {
    let t0 = 0, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) { if (o[k] < b[k] || o[k] > b[k + 3]) return Infinity; continue; }
      let a = (b[k] - o[k]) / d[k], c = (b[k + 3] - o[k]) / d[k];
      if (a > c) { const s = a; a = c; c = s; }
      if (a > t0) t0 = a; if (c < t1) t1 = c;
      if (t0 > t1) return Infinity;
    }
    return t0;
  }
  // Möller–Trumbore, double-sided; P is a flat xyz array.
  function rayTri(o, d, P, i0, i1, i2) {
    const ax = P[i0 * 3], ay = P[i0 * 3 + 1], az = P[i0 * 3 + 2];
    const e1x = P[i1 * 3] - ax, e1y = P[i1 * 3 + 1] - ay, e1z = P[i1 * 3 + 2] - az, e2x = P[i2 * 3] - ax, e2y = P[i2 * 3 + 1] - ay, e2z = P[i2 * 3 + 2] - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x, det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) return Infinity;
    const inv = 1 / det, tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az, u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return Infinity;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) return Infinity;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-9 ? t : Infinity;
  }
  const geometryBounds = new WeakMap();
  function boxOf(P) {
    if (geometryBounds.has(P)) return geometryBounds.get(P);
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v; }
    geometryBounds.set(P, b);
    return b;
  }
  const sphereOf = b => ({c: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], r: Math.max(1e-3, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2)});
  // Camera that frames box b at the current (or given) angles.
  function cameraFor(b, aspect, angles = HOME, fov = 30) {
    const s = sphereOf(b), half = Math.min(fov, 2 * Math.atan(Math.tan(fov * D2R / 2) * aspect) / D2R) * D2R / 2;
    return {target: s.c, dist: s.r / Math.sin(half) * 1.04, yaw: angles.yaw, pitch: angles.pitch, fov};
  }
  // Straight down over the 2D view's centre at its zoom (v2: canvas.js camera(): cx, cy, scale px/mm,
  // flipped). The board's top face (bottom face when flipped) fills the canvas as the 2D view did.
  function cameraFrom2D(v2, thickness, [w, h], fov = 30) {
    if (!v2 || !(v2.scale > 0) || !Number.isFinite(v2.cx) || !Number.isFinite(v2.cy) || !(h > 0)) return null;
    const dist = h / v2.scale / 2 / Math.tan(fov * D2R / 2), angles = v2.flipped ? BOTTOM : TOP;
    return {target: [v2.cx, -v2.cy, v2.flipped ? 0 : thickness || 0], dist, yaw: angles.yaw, pitch: angles.pitch, fov};
  }
  function orbit(cam, dx, dy) {
    return {...cam, yaw: cam.yaw - dx * 0.35, pitch: Math.max(-90, Math.min(90, cam.pitch + dy * 0.35))};
  }
  // Drag by (dx, dy) pixels in a viewport `h` pixels high: the point under the cursor follows it.
  function pan(cam, dx, dy, h, depth = cam.dist) {
    const f = frame(cam), w = 2 * depth * Math.tan(cam.fov * D2R / 2) / Math.max(1, h);
    return {...cam, target: add(add(cam.target, f.right, -dx * w), f.up, dy * w)};
  }
  // Scale the camera rig about p: p keeps its place on screen.
  function zoomAt(cam, p, factor, min = 1e-3, max = 1e6) {
    const d = Math.max(min, Math.min(max, cam.dist * factor)), f = d / cam.dist;
    return {...cam, dist: d, target: p ? add(p, sub(cam.target, p), f) : cam.target};
  }
  const flipped = cam => ({...cam, yaw: cam.yaw + 180, pitch: -cam.pitch});
  function lerpCam(a, b, t) {
    let dy = ((b.yaw - a.yaw) % 360 + 540) % 360 - 180;
    return {target: a.target.map((v, i) => v + (b.target[i] - v) * t), dist: a.dist * Math.pow(b.dist / a.dist, t), yaw: a.yaw + dy * t, pitch: a.pitch + (b.pitch - a.pitch) * t, fov: a.fov};
  }
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  // ---------------------------------------------------------------- scene
  // Batches of instances that share one body. Board, stiffener and layer meshes are
  // single instances with an identity matrix; components group by shared arrays.
  function buildScene(meshed) {
    const batches = [], byArray = new Map(), parts = [];
    let triangles = 0, cpuBytes = 0;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], grow = b => { for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], b[k]); box[k + 3] = Math.max(box[k + 3], b[k + 3]); } };
    for (const p of meshed.parts) {
      if (!p.indices?.length) continue;
      let b = byArray.get(p.positions);
      if (!b) {
        b = {kind: p.kind, side: p.side || null, name: p.name, positions: p.positions, normals: p.normals, indices: p.indices, box: boxOf(p.positions), instances: [], gl: null};
        byArray.set(p.positions, b); batches.push(b);
        cpuBytes += p.positions.byteLength + p.normals.byteLength + p.indices.byteLength;
      }
      const M = p.matrix, inst = {kind: p.kind, bodyRecord: p.bodyRecord, id: p.id || null, ref: p.ref || p.name, side: p.side || null, color: p.color, opacity: p.opacity, matrix: M,
        inv: invert(M), box: globalThis.AtriumGeometry.affine3D.bounds(M, b.box), batch: b, boundsOnly: !!p.boundsOnly};
      b.instances.push(inst); triangles += p.indices.length / 3;
      if (p.kind === "component" && !p.sub) parts.push(inst);
      grow(inst.box);
    }
    return {batches, parts, box, sphere: sphereOf(box), triangles, cpuBytes};
  }
  // Copper and silk are 15-35 µm prisms: their walls and the caps facing the board are
  // never seen, so keep only the outward caps and compact the vertices (about a third).
  function outerCaps(p) {
    const N = p.normals, I = p.indices, sign = p.side === "Bottom" ? -1 : 1, map = new Int32Array(p.positions.length / 3).fill(-1);
    const keep = [];
    for (let i = 0; i < I.length; i += 3) if (N[I[i] * 3 + 2] * sign > 0.5) keep.push(I[i], I[i + 1], I[i + 2]);
    let n = 0;
    for (const v of keep) if (map[v] < 0) map[v] = n++;
    const P = new Float32Array(n * 3), Q = new Float32Array(n * 3), J = new Uint32Array(keep.length);
    for (let v = 0; v < map.length; v++) { const k = map[v]; if (k < 0) continue; for (let c = 0; c < 3; c++) { P[k * 3 + c] = p.positions[v * 3 + c]; Q[k * 3 + c] = N[v * 3 + c]; } }
    for (let i = 0; i < keep.length; i++) J[i] = map[keep[i]];
    return {...p, positions: P, normals: Q, indices: J};
  }
  // Nearest hit along a world ray. Components test a world box, then their
  // triangles in the part frame; board and layers (opts.surfaces) test triangles.
  function pick(scene, o, d, opts = {}) {
    const visible = opts.visible || (() => true), clip = opts.clip;
    let best = {t: Infinity, inst: null, point: null};
    const keep = t => { if (!clip) return true; const p = add(o, d, t); return dot(p, clip.n) <= clip.d + 1e-9; };
    const test = (inst, lo, ld, scale) => {
      const P = inst.batch.positions, I = inst.batch.indices;
      for (let i = 0; i < I.length; i += 3) {
        const t = rayTri(lo, ld, P, I[i], I[i + 1], I[i + 2]) * scale;
        if (t < best.t && keep(t)) best = {t, inst, point: null};
      }
    };
    for (const b of scene.batches) {
      if (b.kind !== "component" && !opts.surfaces) continue;
      for (const inst of b.instances) {
        if (!visible(inst)) continue;
        const tb = rayBox(o, d, inst.box);
        if (!(tb < best.t)) continue;
        if (b.kind !== "component") { test(inst, o, d, 1); continue; }
        const A = globalThis.AtriumGeometry.affine3D, lo = A.point(inst.inv, o), ld = A.direction(inst.inv, d), l = len(ld);
        test(inst, lo, [ld[0] / l, ld[1] / l, ld[2] / l], 1 / l);
      }
    }
    if (best.inst) best.point = add(o, d, best.t);
    return best;
  }

  // ---------------------------------------------------------------- GL
  const VS = `
attribute vec3 aPos;attribute vec3 aNor;attribute vec4 aM0;attribute vec4 aM1;attribute vec4 aM2;attribute vec4 aM3;attribute vec4 aCol;
uniform mat4 uVP;varying vec3 vN;varying vec3 vW;varying vec4 vC;
void main(){mat4 M=mat4(aM0,aM1,aM2,aM3);vec4 w=M*vec4(aPos,1.0);vW=w.xyz;vN=mat3(M)*aNor;vC=aCol;gl_Position=uVP*w;}`;
  const FS = `
precision highp float;
uniform vec3 uEye;uniform vec3 uLight;uniform vec3 uHemi;uniform vec4 uClip;uniform float uEdge;uniform vec4 uCore;
varying vec3 vN;varying vec3 vW;varying vec4 vC;
void main(){
  if(uClip.x+uClip.y+uClip.z!=0.0&&dot(vW,uClip.xyz)>uClip.w)discard;
  vec3 N=normalize(vN);vec3 V=normalize(uEye-vW);vec3 base=vC.rgb;
  // Back faces are only visible through a section: paint them as the cut material.
  if(!gl_FrontFacing){gl_FragColor=vec4(uCore.a>0.0?uCore.rgb*0.8:vC.rgb*0.5,vC.a);return;}
  if(uCore.a>0.0&&abs(N.z)<0.5)base=uCore.rgb;
  float hemi=0.5+0.5*dot(N,uHemi);vec3 amb=mix(vec3(0.30,0.30,0.33),vec3(0.62,0.63,0.66),hemi);
  float diff=max(dot(N,uLight),0.0);float spec=pow(max(dot(N,normalize(uLight+V)),0.0),40.0)*0.22;
  float rim=mix(1.0-uEdge,1.0,pow(abs(dot(N,V)),0.55));
  gl_FragColor=vec4(base*(amb+0.62*diff)*rim+spec,vC.a);
}`;
  // Returns null when neither WebGL2 nor WebGL1 with the needed extensions is available.
  function createRenderer(canvas) {
    const attrs = {antialias: true, depth: true, stencil: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "default"};
    let gl = canvas.getContext("webgl2", attrs), version = 2, inst = null;
    if (!gl) {
      gl = canvas.getContext("webgl", attrs) || canvas.getContext("experimental-webgl", attrs); version = 1;
      if (!gl) return null;
      inst = gl.getExtension("ANGLE_instanced_arrays");
      if (!inst || !gl.getExtension("OES_element_index_uint")) { gl.getExtension("WEBGL_lose_context")?.loseContext(); return null; }
    }
    const divisor = (i, n) => version === 2 ? gl.vertexAttribDivisor(i, n) : inst.vertexAttribDivisorANGLE(i, n);
    const drawInst = (count, n) => version === 2 ? gl.drawElementsInstanced(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0, n) : inst.drawElementsInstancedANGLE(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0, n);
    const live = new Set(), sizes = new Map();
    const buffer = (target, data, usage = gl.STATIC_DRAW) => {
      const b = gl.createBuffer(); live.add(b); gl.bindBuffer(target, b); gl.bufferData(target, data, usage); sizes.set(b, data.byteLength); return b;
    };
    const drop = b => { if (b && live.delete(b)) { sizes.delete(b); gl.deleteBuffer(b); } };
    const dropVertexArray = g => { if (g.vao) { gl.deleteVertexArray(g.vao); g.vao = null; } };
    function shader(type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw Error("3D shader: " + gl.getShaderInfoLog(s));
      return s;
    }
    const vs = shader(gl.VERTEX_SHADER, VS), fs = shader(gl.FRAGMENT_SHADER, FS), prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    ["aPos", "aNor", "aM0", "aM1", "aM2", "aM3", "aCol"].forEach((n, i) => gl.bindAttribLocation(prog, i, n));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw Error("3D program: " + gl.getProgramInfoLog(prog));
    const U = {};
    for (const n of ["uVP", "uEye", "uLight", "uHemi", "uClip", "uEdge", "uCore"]) U[n] = gl.getUniformLocation(prog, n);
    gl.useProgram(prog);
    function enableAttributes() {
      for (let i = 0; i < 7; i++) { gl.enableVertexAttribArray(i); divisor(i, i >= 2 ? 1 : 0); }
    }
    enableAttributes();
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    const samples = gl.getParameter(gl.SAMPLES) || 0;
    let batches = [];
    function upload(scene, incremental = false) {
      if (!incremental) release();
      else if (batches === scene.batches) return;
      // Reuse substrate, layer and already-visible component buffers when another
      // component model becomes ready. Only removed or replaced arrays leave the GPU.
      const previous = new Map(batches.map(b => [b.positions, b]));
      for (const b of scene.batches) {
        const old = previous.get(b.positions);
        if (old?.gl && old.normals === b.normals && old.indices === b.indices) {
          b.gl = old.gl; old.gl = null;
          continue;
        }
        b.gl = {pos: buffer(gl.ARRAY_BUFFER, b.positions), nor: buffer(gl.ARRAY_BUFFER, b.normals), idx: buffer(gl.ELEMENT_ARRAY_BUFFER, b.indices),
          inst: null, cap: 0, count: 0, data: null, vao: null};
      }
      release(); batches = scene.batches;
    }
    // Instance data: 16 floats of matrix and 4 of colour per visible instance.
    function instances(b, list) {
      const n = list.length, g = b.gl;
      if (!g.data || g.data.length < n * 20) g.data = new Float32Array(Math.max(20, n * 20));
      const D = g.data;
      let changed = !g.inst || g.count !== n;
      for (let i = 0; i < n; i++) {
        const x = list[i], start = i * 20;
        if (!changed) {
          for (let k = 0; k < 16; k++) if (D[start + k] !== Math.fround(x.matrix[k])) { changed = true; break; }
          for (let k = 0; k < 4; k++) if (D[start + 16 + k] !== Math.fround(x.rgba[k])) { changed = true; break; }
        }
        if (changed) { D.set(x.matrix, start); D.set(x.rgba, start + 16); }
      }
      if (!changed) return;
      if (!g.inst || g.cap < n) {
        // A vertex array captures the instance buffer as well as the mesh.
        dropVertexArray(g); drop(g.inst);
        g.inst = buffer(gl.ARRAY_BUFFER, D, gl.DYNAMIC_DRAW); g.cap = D.length / 20;
      }
      else { gl.bindBuffer(gl.ARRAY_BUFFER, g.inst); gl.bufferSubData(gl.ARRAY_BUFFER, 0, D.subarray(0, n * 20)); }
      g.count = n;
    }
    function bind(b) {
      const g = b.gl;
      if (version === 2) {
        if (g.vao) { gl.bindVertexArray(g.vao); return; }
        g.vao = gl.createVertexArray();
        gl.bindVertexArray(g.vao);
        if (g.vao) enableAttributes();
        // The default vertex array is configured above if allocation fails.
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pos); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.nor); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.inst);
      for (let k = 0; k < 4; k++) gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, 80, k * 16);
      gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 80, 64);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idx);
    }
    // Exposed copper: copper marks its pixels in the stencil (bit 1 top, 2 bottom), anything opaque drawn
    // after it clears them, and the solder mask openings (kind "opening", drawn last) paint bare copper only
    // where copper shows. Copper elsewhere keeps its mask tint. Without a stencil buffer the openings
    // simply draw over the copper.
    const STENCIL = (gl.getContextAttributes?.()?.stencil ?? true) && gl.getParameter(gl.STENCIL_BITS) > 0;
    function stencil(b) {
      const bit = b.side === "Bottom" ? 2 : 1;
      if (b.kind === "opening") { gl.stencilFunc(gl.EQUAL, bit, 3); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP); }
      else { gl.stencilFunc(gl.ALWAYS, b.kind === "copper" ? bit : 0, 3); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); }
      // Openings lie in the plane of the copper they expose.
      if (b.kind === "opening") { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -4); } else gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    // f: {w, h, bg, m (matrices), light, hemi, clip [nx,ny,nz,d] or null, edge, core, opaque: [batch], blend: [batch]}
    function draw(f) {
      let calls = 0;
      gl.viewport(0, 0, f.w, f.h);
      gl.clearColor(f.bg[0], f.bg[1], f.bg[2], 1); gl.clearStencil(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | (STENCIL ? gl.STENCIL_BUFFER_BIT : 0));
      gl.useProgram(prog);
      gl.uniformMatrix4fv(U.uVP, false, f.m.vp); gl.uniform3fv(U.uEye, f.m.eye); gl.uniform3fv(U.uLight, f.light); gl.uniform3fv(U.uHemi, f.hemi);
      gl.uniform4fv(U.uClip, f.clip || [0, 0, 0, 0]); gl.uniform1f(U.uEdge, f.edge);
      const clipped = !!f.clip;
      const pass = (list, blend) => {
        if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); } else { gl.disable(gl.BLEND); gl.depthMask(true); }
        if (STENCIL && !blend) gl.enable(gl.STENCIL_TEST); else gl.disable(gl.STENCIL_TEST);
        for (const b of list) {
          if (!b.gl?.count) continue;
          if (STENCIL && !blend) stencil(b);
          else if (b.kind === "opening") { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -4); } else gl.disable(gl.POLYGON_OFFSET_FILL);
          // Closed solids: cull back faces unless a section shows their insides.
          if (clipped || blend && b.kind !== "board") gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
          gl.uniform4fv(U.uCore, b.kind === "board" && f.core ? f.core : [0, 0, 0, 0]);
          bind(b); drawInst(b.indices.length, b.gl.count); calls++;
        }
      };
      pass(f.opaque, false); if (f.blend.length) pass(f.blend, true);
      // Geometry uploads may bind the element buffer between frames.
      if (version === 2 && calls) gl.bindVertexArray(null);
      gl.depthMask(true); gl.disable(gl.STENCIL_TEST); gl.disable(gl.POLYGON_OFFSET_FILL);
      return calls;
    }
    function release() {
      for (const b of batches) {
        if (!b.gl) continue;
        dropVertexArray(b.gl); drop(b.gl.pos); drop(b.gl.nor); drop(b.gl.idx); drop(b.gl.inst); b.gl = null;
      }
      batches = [];
    }
    function bytes() { let n = 0; for (const v of sizes.values()) n += v; return n; }
    function dispose() {
      release();
      for (const b of [...live]) drop(b);
      gl.useProgram(null); gl.detachShader(prog, vs); gl.detachShader(prog, fs); gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(prog);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    return {gl, version, samples, upload, instances, draw, release, dispose, bytes, live: () => live.size,
      program: () => prog, renderer: () => { try { return gl.getParameter(gl.RENDERER); } catch { return ""; } }};
  }

  // ---------------------------------------------------------------- options
  const STORE = "atrium-3d-v1";
  const MASKS = [["Green", "#0d5426"], ["Black", "#141414"], ["Blue", "#123d8a"], ["Red", "#8a1616"], ["White", "#e6e6e2"], ["Purple", "#4a2270"], ["Yellow", "#b49512"]];
  const DEFAULTS = {board: true, components: true, copper: true, silk: true, sides: "all", boardOpacity: 1, mask: "#0d5426", edge: true};
  function loadOptions() {
    try { const o = JSON.parse(globalThis.localStorage?.getItem(STORE) || "null"); if (o && typeof o === "object") return {...DEFAULTS, ...o}; } catch { /* default */ }
    return {...DEFAULTS};
  }
  function saveOptions(o) { try { globalThis.localStorage?.setItem(STORE, JSON.stringify(o)); } catch { /* private window */ } }
  function rgb(hex, fallback = [0.2, 0.2, 0.2]) {
    const s = String(hex || "").trim(), m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) { const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]; return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); }
    const r = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
    return r ? [r[1] / 255, r[2] / 255, r[3] / 255] : fallback;
  }
  // Copper seen through the solder mask: the mask colour lifted toward copper, as a real board and
  // Altium's 3D view show it. Bare copper is left only where the mask opens (kind "opening").
  const COPPER = [0.83, 0.68, 0.32];
  const coveredCopper = mask => mask.map((v, i) => v * 0.68 + COPPER[i] * 0.32);
  const reducedMotion = () => {
    try { const M = globalThis.AtriumMotion; if (M?.level) return M.level() !== "full"; } catch {}
    const m = globalThis.document?.documentElement?.getAttribute("data-motion");
    if (m === "reduce" || m === "off") return true; if (m) return false;
    try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
  };

  // ---------------------------------------------------------------- build cache
  // One entry per board document, dropped a minute after its last view closes.
  const cache = new WeakMap(), dropTimers = new Map();
  const BODY_MODULES = ["AtriumSTEP", "AtriumBoardShape", "AtriumStackup", "AtriumRigidFlex", "AtriumGeometryMaterial"];
  const FIT_MODULES = ["AtriumVariants", "AtriumBOM"];
  const modulesChanged = (names, refs) => names.some((name, i) => globalThis[name] !== refs[i]);
  const moduleRefs = names => names.map(name => globalThis[name]);
  const versionsOf = (project, doc, committed) => globalThis.AtriumUndoStore?.documentVersions?.(doc, project, committed) ?? null;
  const nativeBodyKey = asset => asset?.model && !asset.zlib && !asset.stepText
    ? [asset.model.mediaType, asset.model.sha256, asset.model.byteLength].join("/") : null;
  function excludedParts(project, doc) {
    const excluded = new Set(), include = globalThis.AtriumVariants?.includer(project);
    if (include) for (const i of doc.items || []) if (i.kind === "part" && !include(i)) excluded.add(i);
    return excluded;
  }
  function meshGeometry(project, doc, revision, versions, c) {
    const R = globalThis.AtriumResolvedGeometry, U = globalThis.AtriumUndoStore;
    if (!R) throw Error("Load the resolved geometry module before requesting a 3D mesh.");
    if (versions || U?.verifiedDocumentVersion?.(doc) != null)
      return R.read({kind: "editor", project, root: doc});
    if (c?.project === project && c.revision === revision && c.geometryRevision?.kind === "snapshot")
      return c.geometryView;
    return R.read({kind: "snapshot", project, root: doc,
      revision: {kind: "snapshot", projectId: project.id, rootId: doc.id, generation: String(revision)}});
  }
  const ownerId = ({documentId, instancePath, id}) => JSON.stringify([documentId, instancePath, id]);
  const profile = (geometry, doc) => geometry.owner({documentId: doc.id, instancePath: [], kind: "board"})
    ?.features.filter(f => f.key.role === "profile").map(({ink, polarity}) => [ink, polarity]) || [];
  function bodyChanges(c, doc, geometry, change) {
    const parts = new Set(), items = globalThis.AtriumUndoStore?.documentItems?.(doc, c.project)?.byId;
    let board = !c.profile.length && change.bounds.length > 0;
    for (const owner of change.owners) {
      if (owner.kind === "board") {
        if (JSON.stringify(profile(geometry, doc)) !== JSON.stringify(c.profile)) board = true;
        continue;
      }
      const item = items ? items.get(owner.id) : doc.items.find(item => item.id === owner.id);
      if (item?.kind === "part" || c.partIds.has(owner.id)) parts.add(owner.id);
      if (c.boreOwners.has(ownerId(owner)) || geometry.owner(owner)?.bores.length) board = true;
    }
    return {board, parts};
  }
  function invalidateLayers(c, keys) {
    const dirty = VIEW_LAYERS.filter(key => keys.includes(key));
    if (!dirty.length) return;
    for (const key of dirty) c.dirtyLayers.add(key);
    if (c.layers) c.staleLayers = c.layers;
    c.layers = null; c.layerError = null; c.layerGeneration++; c.layerJob?.cancel();
  }
  function cachedMesh(project, doc, revision, versions, folder, geometry) {
    const c = cache.get(doc);
    if (!c || c.invalid || c.project !== project || c.folder !== folder || modulesChanged(BODY_MODULES, c.bodyModules)) return null;
    if (c.readyModels || c.pendingModels.some(t => globalThis.AtriumSTEPImport?.cached(t)?.parts?.length)) return null;
    const old = c.versions, next = geometry.revision;
    const fitterChanged = modulesChanged(FIT_MODULES, c.fitModules);
    if (fitterChanged || old?.assembly !== versions?.assembly) {
      const excluded = excludedParts(project, doc);
      if (excluded.size !== c.excluded.size || [...excluded].some(part => !c.excluded.has(part))) return null;
      if (fitterChanged) c.fitModules = moduleRefs(FIT_MODULES);
    }
    if (next !== c.geometryRevision) {
      const change = geometry.changes(c.geometryRevision);
      if (change.kind === "cold" || old?.outer !== versions?.outer || old?.project !== versions?.project) return null;
      if (change.owners.length) {
        const bodies = bodyChanges(c, doc, geometry, change);
        if (bodies.board || bodies.parts.size)
          return buildMesh(project, doc, revision, versions, folder, geometry, {...bodies, layers: change.layers});
      }
      invalidateLayers(c, change.layers);
      // A pending job held the old view. Keep its dirty layers for the new view.
      c.layerJob?.cancel();
    }
    c.revision = revision;
    c.versions = versions;
    c.geometryView = geometry;
    c.geometryRevision = next;
    return c;
  }
  function buildMesh(project, doc, revision, versions, folder, geometry, update) {
    const S = globalThis.AtriumSTEP, t0 = now(), excluded = excludedParts(project, doc);
    const external = new Set(), M = globalThis.AtriumKiCadModels;
    const resolveModel = m3 => {
      if (!/^\$\{KICAD[0-9]*_3DMODEL_DIR\}/i.test(m3.file)) return null;
      const text = M?.cached(m3.file);
      if (text === undefined) external.add(m3.file);
      return text;
    };
    const model = S.model(project, doc, {copper: false, silk: false, include: i => !excluded.has(i), resolveModel,
      deferBodyModels: true, deferNativeModels: !!folder?.readModel, geometryView: geometry});
    const old = cache.get(doc), same = old?.project === project && old.folder === folder;
    const ready = same ? old.readyModels : null;
    const getModel = text => ready?.get(text) || globalThis.AtriumSTEPImport?.cached(text);
    const pendingModels = [...new Set(model.parts.filter(p => p.source === "model" && !p.model.asset && !getModel(p.model.text)).map(p => p.model.text))];
    // A library publication or an edit can rebuild placements without changing the STEP bytes.
    // Keep only still-referenced verified meshes in this board and folder's existing cache.
    const pendingBodies = new Map(), nativeBodies = new Map();
    let bodyBytes = 0;
    for (const p of model.parts) {
      const a = p.model?.asset;
      if (!a) continue;
      const key = nativeBodyKey(a), retained = same && old.nativeBodies.get(key);
      if (retained) {
        if (!nativeBodies.has(key)) { nativeBodies.set(key, retained); bodyBytes += retained.bytes; }
        continue;
      }
      if (!pendingBodies.has(a)) pendingBodies.set(a, []);
      pendingBodies.get(a).push(p);
    }
    const sceneModel = update ? {...model, board: update.board ? model.board : {bodies: []},
      parts: model.parts.filter(part => update.parts.has(part.id))} : model;
    const meshed = S.mesh(sceneModel, {tolerance: 0.02, modelMesh: assetOrText => typeof assetOrText === "string" ?
      getModel(assetOrText) : nativeBodies.get(nativeBodyKey(assetOrText))?.mesh});
    if (update) {
      // Regenerate only changed body meshes. Retain array identity for unchanged
      // components and preserve model order so picks and GPU reuse agree.
      const board = (update.board ? meshed : old.meshed).parts.filter(p => p.kind !== "component");
      const placed = new Map();
      for (const [source, changed] of [[old.meshed, false], [meshed, true]])
        for (const part of source.parts) if (part.kind === "component" && update.parts.has(part.id) === changed) {
          if (!placed.has(part.id)) placed.set(part.id, []);
          placed.get(part.id).push(part);
        }
      meshed.parts = board.concat([...new Set(model.parts.map(p => p.id))].flatMap(id => placed.get(id) || []));
      meshed.stats.parts = meshed.parts.length;
      meshed.stats.triangles = meshed.parts.reduce((n, p) => n + p.indices.length / 3, 0);
    }
    old?.layerJob?.cancel();
    const c = {revision, project, folder, versions, geometryView: geometry, geometryRevision: geometry.revision,
      profile: profile(geometry, doc), boreOwners: new Set(Array.from(geometry.bores(), bore => ownerId(bore.key.owner))),
      dirtyLayers: new Set(VIEW_LAYERS), layerMeshes: new Map(), partIds: new Set(model.parts.map(p => p.id)),
      excluded, model, meshed, pendingModels, pendingBodies, nativeBodies, bodyBytes, bodyRevision: 0, bodyWarnings: [], external, loadingModels: false,
      readyModels: null, layers: null, staleLayers: null, layerJob: null, layerGeneration: 0, layerError: null, layerWarnings: [], layerMs: 0, bodyModules: moduleRefs(BODY_MODULES), fitModules: moduleRefs(FIT_MODULES), ms: now() - t0};
    if (same) c.staleLayers = old.layers || old.staleLayers;
    if (update) {
      c.layers = old.layers;
      c.layerMeshes = old.layerMeshes;
      c.layerWarnings = old.layerWarnings;
      c.layerMs = old.layerMs;
      c.dirtyLayers = new Set(old.dirtyLayers);
      invalidateLayers(c, update.layers);
    }
    cache.set(doc, c);
    return c;
  }
  async function loadBodyMeshes(c, importer, {signal, selected, current, update} = {}) {
    if (c.loadingBodies || !c.pendingBodies.size || signal?.aborted) return;
    c.loadingBodies = true;
    try {
      const first = selected?.size ? [...c.pendingBodies].sort((a, b) =>
        Number(b[1].some(p => selected.has(p.id))) - Number(a[1].some(p => selected.has(p.id)))) : c.pendingBodies;
      const accept = (asset, r) => {
        if (signal?.aborted || current?.() === false) return;
        const parts = c.pendingBodies.get(asset);
        c.pendingBodies.delete(asset);
        const bytes = r.parts.reduce((n, g) => n + g.positions.byteLength + g.normals.byteLength + g.indices.byteLength, 0);
        const key = nativeBodyKey(asset);
        if (!r.parts.length || c.bodyBytes + bytes > 128 * 1048576) {
          const warning = "STEP body " + (asset.file || asset.id) + " was omitted. " + (r.error || (bytes ? "The view exceeds its 128 MB component mesh limit." : "No readable faces."));
          c.model.notes.push(warning);
          if (key) c.bodyWarnings.push(warning);
        } else {
          const more = globalThis.AtriumSTEP.mesh({board: {bodies: []}, parts, layers: []}, {modelMesh: () => r});
          for (const p of more.parts) c.meshed.parts.push(p);
          c.meshed.stats.parts += more.stats.parts; c.meshed.stats.triangles += more.stats.triangles; c.bodyBytes += bytes;
          if (key) c.nativeBodies.set(key, {mesh: r, bytes});
        }
        c.bodyRevision++;
        update?.();
      };
      const assets = [...first].map(([asset]) => asset);
      await importer.readAssets(assets, {
        signal,
        readModel: ({ownerId, model}) => {
          if (current?.() === false) throw new DOMException("STEP loading cancelled.", "AbortError");
          return c.folder.readModel({ownerId, modelRef: model, signal});
        }
      }, accept);
    } finally { c.loadingBodies = false; }
  }
  const VIEW_LAYERS = ["Top", "Bottom", "Top mask", "Bottom mask", "Silk", "Bottom silk"];
  const layersCurrent = c => c.layers && !c.dirtyLayers.size;
  const LAYER_MESH = {tolerance: 0.02, skipInvalidLayerPrisms: true, flatLayerCaps: true};
  // The writer encodes only the current view's dirty films. Tessellation is
  // still sliced, and no work is published until the requested view is current.
  function* layerSteps(c, project, doc, budget = () => Infinity, pause) {
    const S = globalThis.AtriumSTEP, geometry = c.geometryView, t0 = now();
    const keys = VIEW_LAYERS.filter(key => c.dirtyLayers.has(key));
    const meshes = new Map(c.layerMeshes), board = {bodies: []};
    for (const key of keys) meshes.set(key, {parts: [], warnings: []});
    const artwork = S.layerStepsFor(project, doc, c.model,
      {copper: true, silk: true, maskOpenings: true, geometryView: geometry, layerKeys: keys}, pause);
    let result;
    while (!(result = artwork.next()).done) yield {done: 0, total: 0, n: 0};
    const {layers, layerWarnings} = result.value;
    const total = layers.reduce((count, layer) => count + layer.prisms.length, 0);
    let done = 0;
    yield {done, total, n: 0};
    for (const layer of layers) {
      const output = meshes.get(layer.key);
      for (let at = 0; at < layer.prisms.length;) {
        const n = Math.max(1, Math.min(layer.prisms.length - at, budget())), t = now();
        const r = S.mesh({board, parts: [], layers: [{...layer, prisms: layer.prisms.slice(at, at + n)}]}, LAYER_MESH);
        output.parts.push(...r.parts); output.warnings.push(...r.layerWarnings);
        at += n; done += n;
        yield {done, total, n, ms: now() - t};
      }
    }
    geometry.assertCurrent();
    const ordered = VIEW_LAYERS.map(key => meshes.get(key)).filter(Boolean);
    return {meshes, parts: ordered.flatMap(layer => layer.parts),
      warnings: layerWarnings.concat(ordered.flatMap(layer => layer.warnings)), ms: now() - t0};
  }
  function applyLayers(c, r) {
    c.layers = r.parts; c.staleLayers = null; c.layerWarnings = r.warnings; c.layerMs = r.ms; c.layerError = null;
    c.layerMeshes = r.meshes; c.dirtyLayers.clear();
  }
  function meshLayers(c, project, doc) {
    c.layerJob?.cancel();
    const steps = layerSteps(c, project, doc);
    let s;
    while (!(s = steps.next()).done);
    applyLayers(c, s.value);
  }
  // The same work in time slices of about SLICE ms, one task each, so pressing 3 shows the board at once
  // and input and frames keep flowing while copper arrives. The job belongs to the board's cache entry;
  // it stops when no view of the board is visible (2 pressed, pane hidden) or the copper changes, and
  // the next visible refresh starts it again.
  const SLICE = 12;
  function layerJob(c, project, doc, {alive, progress, done}) {
    c.layerJob?.cancel();
    const generation = c.layerGeneration;
    let size = 256, deadline;
    const steps = layerSteps(c, project, doc, () => size, () => now() >= deadline);
    const job = {done: 0, total: 0, timer: 0, cancelled: false, cancel() {
      job.cancelled = true; clearTimeout(job.timer); job.timer = 0;
      if (c.layerJob === job) c.layerJob = null;
    }};
    c.layerJob = job;
    const step = () => {
      job.timer = 0;
      if (job.cancelled) return;
      if (c.layerGeneration !== generation || !alive()) { job.cancel(); return; }
      const t = now();
      deadline = t + SLICE * 0.75;
      try {
        for (;;) {
          const s = steps.next();
          if (s.done) { c.layerJob = null; applyLayers(c, s.value); done(); return; }
          job.done = s.value.done; job.total = s.value.total;
          // Artwork yields at its deadline. Tessellation then fits measured chunks to each slice.
          if (!s.value.n) break;
          if (s.value.ms > 0) size = Math.max(64, Math.min(50000, Math.round(s.value.n * SLICE / s.value.ms)));
          if (now() >= deadline) break;
        }
      } catch (e) {
        c.layerJob = null;
        if (e.code === "STALE_GEOMETRY") { done(); return; }
        c.layerError = e.message; done(e); return;
      }
      progress();
      job.timer = setTimeout(step, 0);
    };
    job.timer = setTimeout(step, 0);
    return job;
  }
  function meshFor(project, doc, revision, layers) {
    const versions = versionsOf(project, doc, true);
    const geometry = meshGeometry(project, doc, revision, versions, cache.get(doc));
    const c = cachedMesh(project, doc, revision, versions, undefined, geometry) ||
      buildMesh(project, doc, revision, versions, undefined, geometry);
    if (layers && !layersCurrent(c)) meshLayers(c, project, doc);
    return c;
  }

  // ---------------------------------------------------------------- viewer
  const viewers = new Map();
  // The last 3D camera of each board: for this session by document, and for a folder project in the
  // folder's local workspace state (session.setView, cameras3d by document id) beside the 2D cameras,
  // so it survives a reopen. UI state only: the design files are never written.
  const cameras3d = new WeakMap();
  function storedCamera(ctx, d) {
    if (!d) return null;
    return cameras3d.get(d) || ctx.folder?.()?.localState?.cameras3d?.[d.id] || null;
  }
  function storeCamera(ctx, d, cam) {
    if (!d) return;
    cameras3d.set(d, cam);
    const session = ctx.folder?.();
    if (typeof session?.setView === "function" && d.id) Promise.resolve(session.setView({cameras3d: {...session.localState?.cameras3d, [d.id]: cam}})).catch(() => {});
  }
  // Body meshes arrive one asset at a time (a whole batch at once from the cache): one rebuild per frame.
  const refreshQueue = new Set();
  let refreshTimer = 0;
  function refreshSoon(d) {
    refreshQueue.add(d);
    if (!refreshTimer) refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      const docs = new Set(refreshQueue); refreshQueue.clear();
      for (const view of [...viewers.values()]) if (docs.has(view.doc?.())) view.refresh();
    }, 16);
  }
  let cssLoaded = false, optionsId = 0;
  function ensureCSS() {
    if (cssLoaded || !globalThis.document) return; cssLoaded = true;
    if (document.querySelector('link[href$="canvas/view3d.css"]')) return;
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "canvas/view3d.css"; document.head.append(l);
  }
  const el = (tag, cls, text) => AtriumNavCommon.classedElement(document, tag, cls, text);
  function button(text, title, fn, cls = "v3d-btn") {
    const b = el("button", cls, text); b.type = "button"; if (title) { b.title = title; b.setAttribute("aria-label", title); }
    b.addEventListener("click", e => { e.stopPropagation(); fn(e); }); return b;
  }

  function createViewer(ctx) {
    const stage = ctx.stage, t0 = now();
    const root = el("div", "v3d ui-viewport-layer"), canvas = el("canvas", "v3d-canvas ui-viewport");
    canvas.setAttribute("data-interaction", "orbit"); canvas.tabIndex = 0; canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "3D board view");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("class", "v3d-overlay"); svg.setAttribute("aria-hidden", "true");
    const hud = el("div", "v3d-hud"); hud.setAttribute("role", "status"); hud.setAttribute("aria-live", "polite");
    root.append(canvas, svg, hud);
    stage.append(root);
    let R = null;
    try { R = createRenderer(canvas); } catch (e) { R = null; globalThis.console?.warn?.(e); }
    const v = {ctx, stage, root, canvas, R, closed: false};
    if (!R) { fallback(v); return v; }

    const opt = loadOptions();
    let scene = null, built = {doc: null, revision: null, project: null, mesh: null, layers: null}, cam = null, anim = null;
    let rafId = 0, dirty = true, colorsDirty = true, sceneDirty = false;
    let renderedSize = null, renderedDpr;
    let hover = null, selected = new Set(), selSig = "", pointer = null, hoverPending = false, measure = null, clip = null;
    let lastStats = {draws: 0, ms: 0}, buildMs = 0, rebuildTimer = 0, journalTimer = 0, journalIdle = 0;
    let rendererPending = false, bodyJob = null, preparing = null;
    let releaseOpening, releaseInput, inputTimer = 0;
    const touches = new Map();
    let drag = null, gesture = null, lastTouch = -Infinity, touchSeen = false, touchOrbit = false;
    const hasTouch = () => touchSeen || globalThis.navigator?.maxTouchPoints > 0 || globalThis.matchMedia?.("(any-pointer: coarse)").matches;
    function updateCanvasHelp() {
      const desktop = "Arrow keys orbit. Shift with an arrow takes a larger step. Drag to orbit, or Shift-drag to pan. Trackpad scroll pans. Mouse wheel or pinch zooms.";
      const touch = " One finger pans. Pinch to zoom. View options can switch one-finger drag to orbit.";
      canvas.setAttribute("aria-description", desktop + (hasTouch() ? touch : ""));
    }
    updateCanvasHelp();
    const coveredCanvas = stage.querySelector(":scope > canvas[tabindex]");
    const coveredTabIndex = coveredCanvas?.getAttribute("tabindex"), coveredAria = coveredCanvas?.getAttribute("aria-hidden");
    function forwardFocus() {
      if (!root.hidden && !stage.querySelector(":scope > .doc-view:not([hidden])")) canvas.focus({preventScroll: true});
    }
    if (coveredCanvas) {
      // Exclude the covered canvas from sequential focus. Existing pane and panel shortcuts can
      // still focus it programmatically and land on this visible surface instead.
      coveredCanvas.tabIndex = -1;
      coveredCanvas.setAttribute("aria-hidden", "true");
      coveredCanvas.addEventListener("focus", forwardFocus);
    }
    canvas.addEventListener("focus", () => ctx.activate?.());
    const docOf = () => { try { return ctx.document ? ctx.document() : ctx.doc; } catch { return null; } };
    const projectOf = () => ctx.currentProject?.() || ctx.project;
    const visible = () => !v.closed && globalThis.AtriumPower?.visible?.() !== false && document.visibilityState !== "hidden" &&
      stage.isConnected && stage.clientWidth > 0 && stage.clientHeight > 0 && !root.hidden;
    const wantLayers = () => opt.copper || opt.silk;
    const size = () => [canvas.clientWidth || stage.clientWidth || 1, canvas.clientHeight || stage.clientHeight || 1];
    const pixelRatio = () => Math.min(2, globalThis.devicePixelRatio || 1);
    const aspect = () => { const [w, h] = size(); return w / h; };

    // ---- toolbar and options popover
    const bar = el("div", "v3d-bar ui-canvas-tools"); bar.setAttribute("data-canvas-tools", "right"); bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "3D view");
    const pop = el("div", "v3d-pop ui-popover"); pop.id = "v3d-options-" + ++optionsId; pop.hidden = true; pop.setAttribute("data-anchor", "right");
    pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "3D view options");
    const optBtn = button("View", "View options", () => togglePop(undefined, true));
    optBtn.setAttribute("aria-haspopup", "dialog"); optBtn.setAttribute("aria-expanded", "false"); optBtn.setAttribute("aria-controls", pop.id);
    const shortcutButtons = [];
    function viewButton(text, label, actions, run, cls = "") {
      const b = button(text, label, run, "v3d-btn " + cls);
      shortcutButtons.push({b, label, actions});
      return b;
    }
    bar.append(viewButton("Top", "View from top", ["view3d-top"], () => command("view3d-top")),
      viewButton("Bottom", "View from bottom", ["view3d-bottom"], () => command("view3d-bottom")),
      viewButton("Flip", "Flip board", ["view3d-flip"], () => command("view3d-flip")),
      viewButton("Fit", "Fit board", ["fit", "fit-objects", "fit-document"], () => command("fit")), optBtn,
      viewButton("2D", "Back to 2D layout", ["view-2d"], back2D, "v3d-2d"));
    const keys = globalThis.AtriumKeymap;
    function updateShortcuts() {
      const state = {kind: "pcb", tool: "select", canvas: true, view3d: true};
      for (const {b, label, actions} of shortcutButtons) {
        const key = actions.flatMap(a => keys.bindingsFor(a)).find(({key}) => actions.includes(keys.resolve(key, state)))?.key;
        globalThis.AtriumNavCommon?.shortcutTitle(b, label, key);
      }
    }
    if (keys) updateShortcuts();
    const offShortcuts = keys?.onChange(updateShortcuts);
    root.append(bar, pop);
    // ---- rigid-flex fold (flex-fold.js): bend lines fold in their fold order; t 0 flat, 1 folded.
    const foldBtn = button("Fold", "Fold the flex bends in fold order", () => command("view3d-fold"));
    foldBtn.hidden = true; foldBtn.setAttribute("aria-pressed", "false"); bar.insertBefore(foldBtn, optBtn);
    const fold = {t: 0, anim: null, notes: []};
    let foldSrc = null;
    // ---- collisions (collision-3d.js) and the folded STEP preview
    const collBtn = button("Collisions", "Show colliding component bodies (Component Clearance rule)", () => command("view3d-collisions"));
    collBtn.setAttribute("aria-pressed", "false"); bar.insertBefore(collBtn, optBtn);
    const coll = {on: false, ids: new Set(), findings: [], timer: 0, text: ""};
    let preview = null, previewRequest = 0, previewPending = null, previewController = null;
    function collisionRules(d, project) {
      const R = globalThis.AtriumRules, set = R?.stored(d, project);
      return set ? R.kit.compile(R.migrate(set), {doc:d, project}).byType.componentClearance : [];
    }
    function runCollisions() {
      if (!coll.on || !visible()) return;
      const C = globalThis.AtriumCollision3D, d = docOf(), project = projectOf();
      if (!C || !d) return;
      const rules = collisionRules(d, project), r = rules[0];
      let res;
      try { res = C.check(d, new Map((project.library || []).map(x => [x.id, x])), {project, rules, t: fold.t, gap: r ? r.gap : 0, vertical: r ? r.vertical : 0, mode: r?.mode, skipMissingBody: r?.skipMissingBody, board: r ? r.board !== false : true}); }
      catch (e) { coll.text = "Collision check failed: " + e.message; hudText(); return; }
      coll.findings = res.findings; coll.ids = new Set(res.findings.flatMap(f => [f.a.id, f.b?.id].filter(Boolean)));
      const n = res.findings.length, what = r ? "closer than " + r.gap + " / " + r.vertical + " mm" : "touching";
      coll.text = (n ? n + " collision" + (n === 1 ? "" : "s") + " (" + what + ")" + (res.folded ? " folded " + Math.round(fold.t * 100) + " %" : "") + ": " +
        res.findings.slice(0, 4).map(f => f.a.ref + " ↔ " + (f.b?.ref || "board") + (f.kind === "collision" || f.kind === "board" ? "" : " " + f.actual.toFixed(2) + " mm")).join(", ") + (n > 4 ? " …" : "")
        : "No collisions (" + what + ")" + (res.folded ? " folded " + Math.round(fold.t * 100) + " %" : "")) + " · " + res.stats.ms.toFixed(0) + " ms";
      colorsDirty = true; hudText(); invalidate();
    }
    function setCollisions(on) {
      coll.on = on; collBtn.setAttribute("aria-pressed", String(on)); collBtn.classList.toggle("is-on", on);
      if (!on) { coll.ids = new Set(); coll.findings = []; coll.text = ""; colorsDirty = true; hudText(); invalidate(); return Promise.resolve(null); }
      const L = globalThis.AtriumLazy, ready = globalThis.AtriumCollision3D ? Promise.resolve() : L ? L.need("AtriumCollision3D") : Promise.reject(Error("unavailable"));
      return ready.then(() => { runCollisions(); return coll.findings; }, e => { coll.text = "Collisions need the 3D collision module: " + e.message; hudText(); return null; });
    }
    const collisionsSoon = () => { if (!coll.on || !visible()) return; clearTimeout(coll.timer); coll.timer = setTimeout(runCollisions, fold.anim ? 120 : 0); };
    // The folded STEP export, read back with the STEP reader and shown instead of the live model.
    async function setPreview(on) {
      previewController?.abort();
      previewController = null;
      const request = ++previewRequest;
      previewPending = null;
      if (!on) { preview = null; rebuild({force: true}); hudText(); invalidate(); return null; }
      if (!visible()) return null;
      const d = docOf(), project = projectOf(), S = globalThis.AtriumSTEP, L = globalThis.AtriumLazy;
      const current = () => !v.closed && request === previewRequest && docOf() === d && projectOf() === project;
      hud.textContent = "Writing the folded STEP export…";
      if (!globalThis.AtriumSTEPImport && L) await L.need("AtriumSTEPImport");
      if (!current()) return null;
      if (!visible()) {
        previewPending = () => { if (current()) setPreview(true).catch(e => { hud.textContent = "STEP preview failed: " + e.message; }); };
        return null;
      }
      const t = fold.t > 0 ? fold.t : 1, t0 = now(), controller = new AbortController();
      previewController = controller;
      let out;
      try { out = await S.buildAsync(project, d, {fold: t, deterministic: true}, controller.signal); }
      catch (error) { if (controller.signal.aborted) return null; throw error; }
      finally { if (previewController === controller) previewController = null; }
      if (!current()) return null;
      const res = await globalThis.AtriumSTEPImport.load(out.text);
      if (!current()) return null;
      const show = () => {
        if (!current()) return null;
        const parts = res.parts.map((g, i) => ({kind: "preview", name: "STEP " + i, color: g.color, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), positions: g.positions, normals: g.normals, indices: g.indices}));
        scene = buildScene({parts}); scene.notes = out.notes; scene.thickness = foldSrc?.c.model.board.thickness || 1.6; R.upload(scene); colorsDirty = true;
        const b = res.bbox || [0, 0, 0, 0, 0, 0];
        preview = {t, text: "STEP preview, folded " + Math.round(t * 100) + " % · " + (res.stats.solids || 0) + " solids · " + (out.stats.entities || 0) + " entities · " + (out.text.length / 1024).toFixed(0) + " KB · " +
          [0, 1, 2].map(k => (b[k + 3] - b[k]).toFixed(1)).join(" × ") + " mm · " + Math.round(now() - t0) + " ms", stats: res.stats, bbox: res.bbox, notes: out.notes, solids: res.stats.solids, bytes: out.text.length};
        hudText(); fit(); invalidate();
        return preview;
      };
      if (visible()) return show();
      previewPending = show;
      return null;
    }
    function foldedParts(c, d, project, layers) {
      foldSrc = {c, d, project, layers};
      const all = [...c.meshed.parts, ...(layers || [])], F = globalThis.AtriumFlexFold, ref3d = globalThis.AtriumMCADStep?.sceneParts?.(d) || []; // the MCAD enclosure (mcad-step.js) never folds
      let has = false;
      try { has = !!F?.hasBends(d); } catch { has = false; }
      foldBtn.hidden = !has;
      if (!has || !(fold.t > 0)) return all.concat(ref3d);
      try { return F.fold(all, {doc: d, project, thickness: c.model.board.thickness, t: fold.t}).concat(ref3d); }
      catch (e) { hud.textContent = "Fold failed: " + e.message; return all.concat(ref3d); }
    }
    function refold() {
      if (!foldSrc || v.closed || preview) return;
      if (!visible()) { sceneDirty = true; return; }
      const {c, d, project, layers} = foldSrc;
      scene = buildScene({parts: foldedParts(c, d, project, layers)}); scene.hasLayers = !!layers; scene.notes = layers ? c.model.notes.concat(c.layerWarnings) : c.model.notes; scene.thickness = c.model.board.thickness;
      R.upload(scene); colorsDirty = true; invalidate(); collisionsSoon();
    }
    function setFold(t, animate) {
      const to = Math.max(0, Math.min(1, +t || 0));
      foldBtn.setAttribute("aria-pressed", String(to > 0)); foldBtn.textContent = to > 0 ? "Unfold" : "Fold";
      if (!animate || reducedMotion() || !globalThis.requestAnimationFrame) { fold.anim = null; fold.t = to; refold(); return fold.t; }
      const groups = (() => { try { return globalThis.AtriumFlexFold.plan(foldSrc.d, null, {thickness: foldSrc.c.model.board.thickness}).groups; } catch { return 1; } })();
      fold.anim = {from: fold.t, to, start: now(), ms: 900 * Math.max(1, groups) * Math.abs(to - fold.t)};
      requestFrame();
      return to;
    }
    function togglePop(force, restoreFocus = false) {
      const open = force ?? pop.hidden, surface = globalThis.AtriumSurfaceMotion;
      if (surface) surface.popover(pop, open);
      else pop.hidden = !open;
      optBtn.setAttribute("aria-expanded", String(open));
      if (!pop.hidden) { renderPop(); pop.querySelector("input,select,button")?.focus({preventScroll: true}); }
      else if (restoreFocus) optBtn.focus({preventScroll: true});
    }
    function back2D() {
      ctx.activate?.();
      if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") globalThis.dispatchEvent(new CustomEvent("atrium-command", {detail: "view-2d"}));
      if (!v.closed) close();
    }
    function setOpt(k, val) { opt[k] = val; saveOptions(opt); colorsDirty = true; if (k === "copper" || k === "silk") ensureLayers(); if (k === "components") rebuild(); invalidate(); }
    function checkbox(label, checked, change) {
      const l = el("label", "v3d-row"), i = el("input", "ui-checkbox"); i.type = "checkbox"; i.checked = checked;
      i.addEventListener("change", () => change(i.checked)); l.append(i, el("span", null, label)); return l;
    }
    const check = (key, label) => checkbox(label, !!opt[key], value => setOpt(key, value));
    function renderPop() {
      const focusKey = pop.contains(document.activeElement) && document.activeElement.dataset.v3dControl;
      pop.replaceChildren();
      const sec = t => el("div", "v3d-sec", t);
      if (hasTouch()) pop.append(sec("Touch"), checkbox("Orbit with one finger", touchOrbit, value => { touchOrbit = value; }));
      pop.append(sec("Show"), check("board", "Board"), check("components", "Components"), check("copper", "Copper"), check("silk", "Silkscreen"));
      const sides = el("div", "v3d-seg ui-segmented"); sides.setAttribute("role", "radiogroup"); sides.setAttribute("aria-label", "Component sides");
      for (const [k, t] of [["all", "Both"], ["Top", "Top"], ["Bottom", "Bottom"]]) {
        const label = el("label", "ui-segment", t), input = el("input");
        label.dataset.size = "sm"; input.type = "radio"; input.name = pop.id + "-sides"; input.checked = opt.sides === k;
        input.addEventListener("change", () => setOpt("sides", k));
        label.append(input); sides.append(label);
      }
      pop.append(sides, sec("Board"));
      const op = el("input"); op.type = "range"; op.min = "0.15"; op.max = "1"; op.step = "0.05"; op.value = String(opt.boardOpacity); op.setAttribute("aria-label", "Board opacity");
      op.addEventListener("input", () => setOpt("boardOpacity", +op.value));
      const opl = el("label", "v3d-row"); opl.append(el("span", null, "Opacity"), op); pop.append(opl);
      const mask = el("select", "ui-field"); mask.dataset.size = "sm"; mask.setAttribute("aria-label", "Solder mask colour");
      for (const [n, c] of MASKS) mask.add(new Option(n, c));
      if (!MASKS.some(m => m[1] === opt.mask)) mask.add(new Option("Custom", opt.mask));
      mask.value = opt.mask;
      const pick = el("input"); pick.type = "color"; pick.value = opt.mask; pick.setAttribute("aria-label", "Custom solder mask colour");
      mask.addEventListener("change", () => { pick.value = mask.value; setOpt("mask", mask.value); });
      pick.addEventListener("input", () => setOpt("mask", pick.value));
      const ml = el("label", "v3d-row"); ml.append(el("span", null, "Solder mask"), mask, pick); pop.append(ml, check("edge", "Edge shading"));
      pop.append(sec("Section"));
      const seg = el("div", "v3d-seg ui-segmented"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Section");
      for (const [k, t] of [[null, "Off"], ["x", "X"], ["y", "Y"]]) {
        const on = (clip?.axis || null) === k, b = button(t, "Section " + (k ? "along " + t : "off"), () => { setClip(k); renderPop(); }, "ui-segment");
        b.dataset.size = "sm"; b.dataset.v3dControl = "section-" + t;
        b.setAttribute("aria-pressed", String(on)); seg.append(b);
      }
      pop.append(seg);
      if (clip && scene) {
        const k = clip.axis === "x" ? 0 : 1, s = el("input"); s.type = "range"; s.min = String(scene.box[k]); s.max = String(scene.box[k + 3]); s.step = "any"; s.value = String(clip.pos);
        s.setAttribute("aria-label", "Section position");
        const out = el("output", "v3d-num", clip.pos.toFixed(2) + " mm");
        s.addEventListener("input", () => { clip.pos = +s.value; out.textContent = clip.pos.toFixed(2) + " mm"; invalidate(); });
        const flip = button("⇄", "Keep the other side", () => { clip.flip = !clip.flip; invalidate(); }, "ui-button"); flip.dataset.size = "sm";
        const l = el("label", "v3d-row"); l.append(s, out, flip); pop.append(l);
      }
      if (!foldBtn.hidden) {
        const fs = el("input"); fs.type = "range"; fs.min = "0"; fs.max = "1"; fs.step = "0.01"; fs.value = String(fold.t); fs.setAttribute("aria-label", "Fold sequence");
        const fo = el("output", "v3d-num", Math.round(fold.t * 100) + " %");
        fs.addEventListener("input", () => { setFold(+fs.value, false); fo.textContent = Math.round(fold.t * 100) + " %"; });
        const fl = el("label", "v3d-row"); fl.append(el("span", null, "Fold"), fs, fo); pop.append(sec("Rigid-flex"), fl);
        const pv = el("div", "v3d-pop-actions");
        const previewButton = button(preview ? "Back to the live model" : "Preview folded STEP", "Write the STEP export at this fold (fully folded when flat) and show it read back", () => { command("view3d-step-preview"); renderPop(); }, "ui-button");
        previewButton.dataset.size = "sm"; previewButton.dataset.v3dControl = "preview"; previewButton.setAttribute("aria-pressed", String(!!preview));
        pv.append(previewButton);
        pop.append(pv);
      }
      pop.append(sec("Tools"));
      const tools = el("div", "v3d-pop-actions");
      const shortcut = globalThis.AtriumKeymap?.hintKey?.("measure", "pcb"), measureLabel = "Measure the distance between two points";
      const measureButton = button(measure ? "Stop measuring" : "Measure", measureLabel, () => { toggleMeasure(); renderPop(); }, "ui-button");
      globalThis.AtriumNavCommon?.shortcutTitle(measureButton, measureLabel, shortcut);
      measureButton.dataset.size = "sm"; measureButton.dataset.v3dControl = "measure"; measureButton.setAttribute("aria-pressed", String(!!measure));
      const shot = button("Screenshot…", "Save the view as PNG", () => screenshot(), "ui-button"); shot.dataset.size = "sm";
      tools.append(measureButton, shot);
      pop.append(tools, el("div", "v3d-stats", statsText()));
      if (focusKey) pop.querySelector('[data-v3d-control="' + focusKey + '"]')?.focus({preventScroll: true});
    }
    function statsText() {
      const s = stats();
      return "GPU " + (s.gpuBytes / 1048576).toFixed(2) + " MB · " + Math.round(s.triangles / 1000) + "k triangles · " + s.batches + " bodies · " +
        s.draws + " draws · " + s.frameMs.toFixed(1) + " ms · WebGL" + s.webgl + (s.samples ? " · MSAA ×" + s.samples : "");
    }

    // ---- scene
    function ensureLayers() {
      if (wantLayers()) rebuild();
      else { built.mesh?.layerJob?.cancel(); hudText(); }
    }
    function stopJournalWait() {
      if (journalIdle) globalThis.AtriumIdle?.cancel(journalIdle);
      clearTimeout(journalTimer);
      journalIdle = journalTimer = 0;
    }
    function waitForJournal() {
      if (journalTimer) return;
      // The undo writer already has an idle callback. Let it publish the exact
      // range first, with a conservative rebuild if no committed read arrives.
      journalIdle = globalThis.AtriumIdle?.idle(() => {
        journalIdle = 0;
        if (visible() && versionsOf(projectOf(), docOf())) rebuild();
      }, {timeout: 420}) || 0;
      journalTimer = setTimeout(() => { stopJournalWait(); rebuild({fallback: true}); }, 440);
    }
    // Copper and silk follow the first frame of the board and its bodies (layerJob, time-sliced).
    function layersSoon(c, d, project) {
      if (c.layerJob || c.layerError) return;
      const views = () => [...viewers.values()].filter(view => !view.closed && view.doc?.() === d);
      layerJob(c, project, d, {
        alive: () => cache.get(d) === c && views().some(view => view.visible?.() && view.wantLayers?.()),
        progress: () => { for (const view of views()) view.progress?.(); },
        done: e => {
          if (e) ctx.info?.("3D copper and silkscreen could not be built. " + e.message);
          for (const view of views()) view.refresh();
        }});
    }
    async function externalModelsSoon(c, d, project) {
      if (!c.external.size || c.loadingExternal) return;
      const L = globalThis.AtriumLazy, current = () => visible() && cache.get(d) === c && docOf() === d && projectOf() === project;
      c.loadingExternal = true;
      let loaded = false;
      try {
        const M = globalThis.AtriumKiCadModels || await L?.need("AtriumKiCadModels");
        if (!M?.list().length) { c.external.clear(); return; }
        for (const file of c.external) {
          if (!current()) break;
          if (await M.load(file)) loaded = true;
          c.external.delete(file);
        }
        if (loaded && cache.get(d) === c) {
          c.invalid = true;
          for (const view of viewers.values()) if (view.doc?.() === d) view.refresh();
        }
      } finally { c.loadingExternal = false; }
    }
    const modelsChanged = () => {
      const c = cache.get(docOf());
      if (c) c.invalid = true;
      rebuild();
    };
    globalThis.addEventListener?.("atrium-kicad-models-change", modelsChanged);
    function cancelBodies() { bodyJob?.controller.abort(); bodyJob = null; }
    function bodiesSoon(c, d) {
      if (bodyJob && (bodyJob.cache !== c || !opt.components)) cancelBodies();
      if (bodyJob || !opt.components || !visible() || !c.pendingBodies.size || c.loadingBodies) return;
      const controller = new AbortController(), job = {cache: c, controller};
      const current = () => visible() && docOf() === d && projectOf() === c.project &&
        ctx.folder?.() === c.folder && cache.get(d) === c;
      bodyJob = job;
      Promise.resolve(globalThis.AtriumSTEPImport || globalThis.AtriumLazy?.need("AtriumSTEPImport")).then(I => {
        if (!I || controller.signal.aborted || !current()) return;
        return loadBodyMeshes(c, I, {signal: controller.signal, selected, current, update: () => refreshSoon(d)});
      }).catch(e => { if (!controller.signal.aborted && current()) ctx.info?.("STEP body could not be read. " + e.message); })
        .finally(() => {
          if (bodyJob === job) bodyJob = null;
          if (controller.signal.aborted && cache.get(d) === c) refreshSoon(d);
        });
    }
    function modelsSoon(c, d, project) {
      if (!c.pendingModels.length || c.loadingModels) return;
      const L = globalThis.AtriumLazy, importer = globalThis.AtriumSTEPImport;
      if (!importer && !L) return;
      const current = () => cache.get(d) === c && docOf() === d && projectOf() === project;
      c.loadingModels = true;
      (importer ? Promise.resolve(importer) : L.need("AtriumSTEPImport"))
        .then(I => visible() && current() ? Promise.all(c.pendingModels.map(t => I.load(t))) : null)
        .then(rs => {
          c.loadingModels = false;
          if (!rs || cache.get(d) !== c) return;
          const ready = new Map();
          rs.forEach((r, n) => { if (r.parts?.length) ready.set(c.pendingModels[n], r); });
          c.pendingModels = [];
          if (ready.size) {
            c.readyModels = ready;
            for (const view of viewers.values()) if (view.doc?.() === d) view.refresh();
          }
          const bad = rs.filter(r => r.error);
          if (bad.length && visible() && current()) ctx.info?.(bad.length + " STEP model" + (bad.length === 1 ? "" : "s") + " could not be read and show as boxes: " + bad[0].error);
        }, () => { c.loadingModels = false; c.pendingModels = []; });
    }
    function geometryFor(d, project, revision, versions, host) {
      if (!host) return meshGeometry(project, d, revision, versions, cache.get(d));
      const view = host.boardGeometry(d);
      if (view || preparing?.project === project && preparing.doc === d) return view;
      const pending = preparing = {project, doc: d};
      const current = () => !v.closed && preparing === pending && docOf() === d && projectOf() === project;
      host.prepareBoardGeometry(d).then(() => {
        if (current()) rebuild();
      }, error => {
        if (current()) hud.textContent = "3D geometry could not be prepared: " + error.message;
      });
      return null;
    }
    function rebuild({force = false, urgent = false, fallback = false} = {}) {
      const d = docOf(), project = projectOf(), revision = ctx.revision?.(), folder = ctx.folder?.();
      if (bodyJob && (built.doc !== d || built.project !== project || bodyJob.cache.folder !== folder)) cancelBodies();
      if (!d || d.kind !== "pcb") { close(); return; }
      if (force) sceneDirty = true;
      if (!visible()) return;
      if (previewPending) { const apply = previewPending; previewPending = null; apply(); }
      if (preview && !force) { if (built.doc === d && built.project === project) return; preview = null; }
      const same = built.doc === d && built.project === project;
      const nav = globalThis.AtriumNavHost, host = nav?.project?.() === project && nav.boardGeometry ? nav : null;
      const t = now();
      let c;
      try {
        const versions = versionsOf(project, d, true);
        if (!host && !fallback && same && built.revision !== revision && !versions && globalThis.AtriumUndoStore?.root() === project) {
          waitForJournal();
          return;
        }
        const geometry = geometryFor(d, project, revision, versions, host);
        if (!geometry) { if (!fallback) waitForJournal(); return; }
        stopJournalWait();
        c = cachedMesh(project, d, revision, versions, folder, geometry);
        if (!c && same && buildMs > 40 && !urgent && !force) {
          if (!rebuildTimer) rebuildTimer = setTimeout(() => { rebuildTimer = 0; rebuild({urgent: true, fallback}); }, 150);
          return;
        }
        clearTimeout(rebuildTimer); rebuildTimer = 0;
        c ||= buildMesh(project, d, revision, versions, folder, geometry);
      } catch (e) {
        if (e.code === "STALE_GEOMETRY") { if (!fallback) waitForJournal(); return; }
        hud.textContent = "3D build failed: " + e.message; return;
      }
      const layers = wantLayers() ? c.layers || c.staleLayers : c.layers;
      const unchanged = built.mesh === c && built.layers === layers && built.bodyRevision === c.bodyRevision;
      built = {doc: d, revision, project, mesh: c, layers, bodyRevision: c.bodyRevision};
      if (wantLayers() && !layersCurrent(c)) layersSoon(c, d, project);
      bodiesSoon(c, d);
      modelsSoon(c, d, project);
      externalModelsSoon(c, d, project).catch(() => { c.external.clear(); });
      hudText();
      if (unchanged && !force && !sceneDirty) return;
      sceneDirty = false;
      scene = buildScene({parts: foldedParts(c, d, project, layers)});
      scene.hasLayers = !!c.layers; scene.notes = c.layers ? c.model.notes.concat(c.layerWarnings) : c.model.notes; scene.thickness = c.model.board.thickness;
      R.upload(scene, same);
      buildMs = now() - t; colorsDirty = true;
      if (!cam || !same) { cam = initialCamera(c); savedCam = cam; }
      if (clip) clip.pos = Math.max(scene.box[clip.axis === "x" ? 0 : 1], Math.min(scene.box[clip.axis === "x" ? 3 : 4], clip.pos));
      canvas.setAttribute("aria-label", "3D view of " + (d.name || "the board") + ": " + scene.parts.length + " components");
      invalidate(); collisionsSoon();
    }
    // ---- camera memory: the board's last 3D camera (storeCamera, or ctx.camera3d when given),
    // else straight down over what the 2D view showed, so pressing 3 only adds depth.
    let savedCam = null, camTimer = 0;
    function validCamera(x) {
      const n = v => typeof v === "number" && Number.isFinite(v);
      if (!x || !Array.isArray(x.target) || x.target.length !== 3 || !x.target.every(n) || !n(x.dist) || !(x.dist > 0) || !n(x.yaw) || !n(x.pitch)) return null;
      return {target: x.target.slice(), dist: x.dist, yaw: x.yaw, pitch: Math.max(-90, Math.min(90, x.pitch)), fov: n(x.fov) && x.fov >= 5 && x.fov <= 120 ? x.fov : 30};
    }
    function initialCamera(c) {
      let saved = null;
      try { saved = validCamera(ctx.camera3d ? ctx.camera3d() : storedCamera(ctx, docOf())); } catch { saved = null; }
      if (saved) return saved;
      return cameraFrom2D(ctx.view2d?.(), c.model.board.thickness, size()) || cameraFor(scene.box, aspect(), TOP);
    }
    function saveCamera() {
      clearTimeout(camTimer); camTimer = 0;
      if (!cam || cam === savedCam || anim) return;
      savedCam = cam;
      const keep = {target: cam.target.slice(), dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov};
      try { if (ctx.camera3d) ctx.camera3d(keep); else storeCamera(ctx, built.doc, keep); } catch { /* view state is best effort */ }
    }
    function visibleInst(x) {
      if (x.kind === "board" || x.kind === "stiffener") return opt.board;
      if (x.kind === "copper" || x.kind === "opening") return opt.copper;
      if (x.kind === "silk") return opt.silk;
      if (x.kind === "preview" || x.kind === "enclosure") return true;
      return opt.components && (opt.sides === "all" || x.side === opt.sides);
    }
    function colors() {
      const mask = rgb(opt.mask, [0.05, 0.33, 0.15]), covered = coveredCopper(mask), selC = rgb(cssVar("--v3d-selection") || "#3d8bff", [0.24, 0.55, 1]), errC = rgb(cssVar("--error") || "#f0706a", [0.94, 0.44, 0.42]);
      for (const b of scene.batches) {
        const list = [];
        for (const x of b.instances) {
          if (!visibleInst(x)) continue;
          let c = x.kind === "board" ? mask : x.kind === "copper" && opt.board ? covered : x.color || [0.5, 0.5, 0.5], a = x.kind === "board" ? opt.boardOpacity : x.kind === "enclosure" ? 0.3 : x.opacity ?? 1;
          if (x.id && (coll.ids.has(x.id) || globalThis.AtriumMCADPanel?.flagged?.(x.id))) c = c.map((v, i) => v * 0.2 + errC[i] * 0.8);
          if (x.id && selected.has(x.id)) c = c.map((v, i) => v * 0.35 + selC[i] * 0.65);
          if (x === hover) c = c.map(v => v + (1 - v) * 0.28);
          x.rgba = [c[0], c[1], c[2], a]; list.push(x);
        }
        b.translucent = list.some(x => x.rgba[3] < .999);
        R.instances(b, list);
      }
      colorsDirty = false;
    }
    function cssVar(n) { try { return getComputedStyle(root).getPropertyValue(n).trim(); } catch { return ""; } }
    function background() {
      const sys = globalThis.AtriumPCBAppearance?.system;
      return rgb(sys?.workspace || cssVar("--canvas-bg") || "#1e1e1e", [0.12, 0.12, 0.12]);
    }

    // ---- rendering (on demand)
    function invalidate() { dirty = true; requestFrame(); }
    function requestFrame() { if (!rafId && globalThis.requestAnimationFrame && visible()) rafId = requestAnimationFrame(tick); }
    function tick(ts) {
      rafId = 0;
      if (!visible()) return;
      if (anim) {
        const t = Math.min(1, (now() - anim.start) / anim.ms);
        cam = lerpCam(anim.from, anim.to, ease(t)); dirty = true;
        if (t >= 1) { cam = anim.to; anim = null; }
      }
      if (fold.anim) {
        const a = fold.anim, k = a.ms > 0 ? Math.min(1, (now() - a.start) / a.ms) : 1;
        fold.t = a.from + (a.to - a.from) * ease(k);
        if (k >= 1) fold.anim = null;
        refold();
      }
      if (hoverPending) updateHover();
      if (dirty) renderNow();
      if (anim || fold.anim) requestFrame();
      void ts;
    }
    function finishOpening() {
      if (!releaseOpening) return;
      releaseOpening(); releaseOpening = null;
    }
    function finishInput() {
      clearTimeout(inputTimer); inputTimer = 0;
      releaseInput?.(); releaseInput = null;
    }
    function cameraInput() {
      if (!ctx.holdIdle) return;
      releaseInput ||= ctx.holdIdle();
      clearTimeout(inputTimer); inputTimer = setTimeout(finishInput, 100);
    }
    function renderNow() {
      if (!scene || !visible()) return;
      const t = now(), dpr = pixelRatio(), cssSize = size(), [cw, ch] = cssSize;
      const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      if (colorsDirty) colors();
      const m = matrices(cam, w / h, scene.sphere);
      const light = add(add(m.back, m.right, -0.45), m.up, 0.55), ll = len(light);
      const opaque = [], blend = [], openings = [];
      for (const b of scene.batches) (b.translucent ? blend : b.kind === "opening" ? openings : opaque).push(b);
      for (const b of openings) opaque.push(b);
      lastStats.draws = R.draw({w, h, bg: background(), m, light: light.map(x => x / ll), hemi: [0, 0, cam.pitch >= 0 ? 1 : -1],
        clip: clipPlane(), edge: opt.edge ? 0.38 : 0, core: [0.78, 0.71, 0.5, 1], opaque, blend});
      renderedSize = cssSize; renderedDpr = dpr;
      lastStats.ms = now() - t; v.lastMatrices = m; dirty = false;
      if (cam !== savedCam && !anim && !camTimer) camTimer = setTimeout(saveCamera, 400);
      if (releaseOpening && (!wantLayers() || scene.hasLayers || built.mesh?.layerError) &&
          (!opt.components || !built.mesh?.pendingBodies.size && !built.mesh?.pendingModels.length)) finishOpening();
      drawOverlay(m, cw, ch);
    }
    function clipPlane() {
      if (!clip) return null;
      const n = clip.axis === "x" ? [1, 0, 0] : [0, 1, 0], s = clip.flip ? -1 : 1;
      return [n[0] * s, n[1] * s, n[2] * s, clip.pos * s];
    }
    function setClip(axis) {
      if (!axis) clip = null;
      else { const k = axis === "x" ? 0 : 1, b = scene?.box || [0, 0, 0, 0, 0, 0]; clip = {axis, pos: clip?.axis === axis ? clip.pos : (b[k] + b[k + 3]) / 2, flip: false}; }
      invalidate();
    }

    // ---- camera
    function goTo(next, instant) {
      if (instant || reducedMotion() || !globalThis.requestAnimationFrame) { anim = null; cam = next; invalidate(); return; }
      anim = {from: cam, to: next, start: now(), ms: 260}; invalidate();
    }
    function fit(angles) { if (scene) goTo(cameraFor(visibleBox(), aspect(), angles || cam, cam.fov)); }
    function visibleBox() {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const bt of scene.batches) for (const x of bt.instances) if (visibleInst(x)) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], x.box[k]); b[k + 3] = Math.max(b[k + 3], x.box[k + 3]); }
      return b[0] <= b[3] ? b : scene.box;
    }
    function rayAt(x, y) { const [w, h] = size(); return ray(cam, w / h, x / w * 2 - 1, 1 - y / h * 2); }
    function pickAt(x, y, surfaces) {
      const r = rayAt(x, y), c = clipPlane();
      return {...pick(scene, r.o, r.d, {visible: visibleInst, surfaces, clip: c ? {n: c.slice(0, 3), d: c[3]} : null}), ray: r};
    }
    // Zoom anchor: the part under the cursor, else the board plane facing the camera.
    function anchorAt(x, y) {
      const h = pickAt(x, y, false);
      if (h.point) return h.point;
      const {o, d} = h.ray, z = o[2] >= (scene.thickness || 0) / 2 ? (scene.thickness || 0) : 0;
      if (Math.abs(d[2]) > 1e-6) { const t = (z - o[2]) / d[2]; if (t > 0) return add(o, d, t); }
      return add(o, d, cam.dist);
    }
    function zoom(factor, x, y) {
      cameraInput();
      const r = scene.sphere.r;
      cam = zoomAt(cam, x == null ? null : anchorAt(x, y), factor, r * 0.01, r * 40); anim = null; invalidate();
    }

    // ---- selection
    function syncSelection() {
      const ids = ctx.selection?.() || [], sig = ids.join("\u0001");
      if (sig === selSig) return false;
      selSig = sig; selected = new Set(ids); colorsDirty = true; invalidate(); return true;
    }
    function updateHover() {
      hoverPending = false;
      const h = pointer && !drag && !measure ? pickAt(pointer[0], pointer[1], false).inst : null;
      if (h !== hover) {
        hover = h; colorsDirty = true; invalidate();
        hudText();
      }
    }
    function hudText() {
      if (measure) {
        const [a, b] = measure.points;
        if (!a) hud.textContent = "Measure: click the first point. Escape cancels.";
        else if (!b) hud.textContent = "Measure: click the second point.";
        else { const d = sub(b, a); hud.textContent = "Distance " + len(d).toFixed(3) + " mm · ΔX " + d[0].toFixed(3) + " · ΔY " + d[1].toFixed(3) + " · ΔZ " + d[2].toFixed(3); }
        return;
      }
      if (hover) { const it = docOf()?.items?.find(i => i.id === hover.id); hud.textContent = [hover.ref, it?.value, hover.side, hover.boundsOnly ? "model box" : "", coll.ids.has(hover.id) ? "collides" : ""].filter(Boolean).join(" · "); return; }
      const warnings = (built.mesh?.layers && wantLayers() ? built.mesh.layerWarnings : []).concat(built.mesh?.bodyWarnings || []);
      const text = preview ? preview.text : coll.text || (warnings.length > 1 ? warnings[0] + " " + (warnings.length - 1) + " more shapes could not be displayed." : warnings[0]) || "";
      const busy = !text && showProgress && pendingText();
      if (!busy) { hud.textContent = text; return; }
      // The library's status line: a small spinner and what is still on its way (docs/ui-library.md#progress).
      const line = el("span", "ui-status-line"), spin = el("span", "ui-spinner");
      spin.setAttribute("data-size", "sm"); spin.setAttribute("aria-hidden", "true");
      line.append(spin, el("span", "ui-status-text", busy));
      hud.textContent = ""; hud.append(line);
    }
    // What the view still builds or reads, for the status line; null when the view is complete.
    function pendingText() {
      const c = built.mesh;
      if (!c || preview) return null;
      const out = [], job = c.layerJob;
      if (wantLayers() && !c.layers && !c.layerError)
        out.push("Building copper and silkscreen" + (job?.total ? " " + Math.min(99, Math.floor(100 * job.done / job.total)) + " %" : "…"));
      const bodies = opt.components ? c.pendingBodies.size + c.pendingModels.length : 0;
      if (bodies) out.push("Reading " + bodies + " 3D model" + (bodies === 1 ? "" : "s") + "…");
      return out.length ? out.join(" · ") : null;
    }
    // Work under a second shows nothing; after that the status line follows it (docs/ui-library.md).
    let showProgress = false, progressTimer = setTimeout(() => { progressTimer = 0; showProgress = true; if (!v.closed) hudText(); }, 1000);
    let progressFrame = 0;
    function progress() {
      if (!showProgress || progressFrame || !globalThis.requestAnimationFrame) return;
      progressFrame = requestAnimationFrame(() => { progressFrame = 0; if (!v.closed) hudText(); });
    }
    function clickSelect(x, y, additive) {
      const h = pickAt(x, y, false).inst, id = h?.id || null;
      let ids;
      if (additive) { ids = new Set(selected); if (id) { if (ids.has(id)) ids.delete(id); else ids.add(id); } ids = [...ids]; }
      else ids = id ? [id] : [];
      if (ctx.select) ctx.select(ids);
      else { selected = new Set(ids); }
      syncSelection(); colorsDirty = true; invalidate();
      if (h) ctx.info?.(h.ref + " selected in 3D");
    }

    // ---- measure
    function toggleMeasure(on = !measure) {
      measure = on ? {points: []} : null; canvas.classList.toggle("is-measuring", !!measure);
      hudText(); invalidate();
    }
    function measureClick(x, y) {
      const h = pickAt(x, y, true);
      if (!h.point) return;
      if (measure.points.length >= 2) measure.points = [];
      measure.points.push(h.point); hudText(); invalidate();
    }
    function drawOverlay(m, w, h) {
      svg.setAttribute("viewBox", "0 0 " + w + " " + h); svg.setAttribute("width", w); svg.setAttribute("height", h);
      const pts = measure?.points || [];
      if (!pts.length) { if (svg.firstChild) svg.replaceChildren(); return; }
      const NS = "http://www.w3.org/2000/svg", s = pts.map(p => project(m.vp, p, w, h)).filter(Boolean), kids = [];
      if (s.length === 2) { const l = document.createElementNS(NS, "line"); l.setAttribute("x1", s[0][0]); l.setAttribute("y1", s[0][1]); l.setAttribute("x2", s[1][0]); l.setAttribute("y2", s[1][1]); kids.push(l); }
      for (const p of s) { const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", p[0]); c.setAttribute("cy", p[1]); c.setAttribute("r", 4); kids.push(c); }
      if (s.length === 2) {
        const t = document.createElementNS(NS, "text"); t.setAttribute("x", (s[0][0] + s[1][0]) / 2 + 8); t.setAttribute("y", (s[0][1] + s[1][1]) / 2 - 8);
        t.textContent = len(sub(pts[1], pts[0])).toFixed(3) + " mm"; kids.push(t);
      }
      svg.replaceChildren(...kids);
    }

    // ---- screenshot
    async function screenshot() {
      renderNow();
      const url = canvas.toDataURL("image/png"), bin = atob(url.slice(url.indexOf(",") + 1)), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const name = String(docOf()?.name || "board").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim() + " 3D.png";
      try { if (await (ctx.exportFile || globalThis.AtriumIO?.exportFile)?.(name, bytes)) ctx.info?.("Saved " + name + " (" + canvas.width + "×" + canvas.height + ")"); }
      catch (e) { ctx.info?.("Screenshot failed: " + e.message); }
      return bytes;
    }

    // ---- input
    const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const touchMode = () => touchOrbit ? "orbit" : "pan";
    function contacts() {
      const points = touches.values(), a = points.next().value, b = points.next().value;
      return {at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], span: Math.hypot(a[0] - b[0], a[1] - b[1])};
    }
    function startPinch(at, scale) {
      // Keep the point first under the fingers at their moving midpoint in perspective.
      const anchor = anchorAt(...at), f = frame(cam);
      return {at, scale, anchor, depth: dot(sub(anchor, f.eye), f.fwd)};
    }
    function movePinch(g, at, scale) {
      const dx = at[0] - g.at[0], dy = at[1] - g.at[1], factor = g.scale > 0 && scale > 0 ? g.scale / scale : 1;
      if (dx || dy) cam = pan(cam, dx, dy, size()[1], g.depth);
      if (factor !== 1) {
        const before = cam.dist, radius = scene.sphere.r;
        cam = zoomAt(cam, g.anchor, factor, radius * 0.01, radius * 40);
        g.depth *= cam.dist / before;
      }
      g.at = at; g.scale = scale;
      if (dx || dy || factor !== 1) { cameraInput(); anim = null; invalidate(); }
    }
    function resetTouchDrag(moved) {
      if (touches.size >= 2) {
        const {at, span} = contacts();
        drag = {touch: true, input: startPinch(at, span), moved: true};
      } else {
        const at = touches.values().next().value;
        drag = at ? {touch: true, mode: touchMode(), start: at, last: at, moved} : null;
      }
    }
    canvas.addEventListener("pointerdown", e => {
      if (!scene || e.button > 2) return;
      const touch = e.pointerType === "touch", p = pos(e);
      if (drag && !(touch && drag.touch)) return;
      e.preventDefault(); anim = null;
      if (!pop.hidden) togglePop(false);
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      if (touch) {
        if (!touchSeen) { touchSeen = true; updateCanvasHelp(); }
        pointer = null; hoverPending = true; requestFrame();
        if (gesture) gesture.direct = true;
        touches.set(e.pointerId, p);
        if (touches.size <= 2) resetTouchDrag(false);
      } else {
        canvas.focus({preventScroll: true}); lastTouch = -Infinity;
        const panMode = e.button === 1 || e.button === 2 || e.shiftKey && e.button === 0;
        drag = {id: e.pointerId, mode: panMode ? "pan" : "orbit", start: p, last: p, moved: false, button: e.button, additive: e.ctrlKey || e.metaKey || e.shiftKey};
      }
    });
    function moveDrag(p) {
      const dx = p[0] - drag.last[0], dy = p[1] - drag.last[1];
      if (!dx && !dy || !drag.moved && Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) < 4) return;
      drag.moved = true; drag.last = p; cameraInput();
      cam = drag.mode === "pan" ? pan(cam, dx, dy, size()[1]) : orbit(cam, dx, dy); invalidate();
    }
    function moveTouch(id, p) {
      touches.set(id, p);
      if (drag.input) {
        const {at, span} = contacts();
        movePinch(drag.input, at, span);
      } else moveDrag(p);
    }
    canvas.addEventListener("pointermove", e => {
      const p = pos(e);
      if (e.pointerType === "touch") {
        if (touches.has(e.pointerId)) { e.preventDefault(); moveTouch(e.pointerId, p); }
        return;
      }
      if (drag) { if (drag.id === e.pointerId) moveDrag(p); return; }
      pointer = p; hoverPending = true; requestFrame();
    });
    function end(e) {
      const d = drag, touch = touches.has(e.pointerId), up = e.type === "pointerup";
      if (!d || !touch && d.id !== e.pointerId) return;
      if (touch) {
        e.preventDefault(); lastTouch = now();
        if (up) moveTouch(e.pointerId, pos(e));
        touches.delete(e.pointerId); resetTouchDrag(true);
      } else drag = null;
      if (!drag) finishInput();
      if (!up || d.moved || !touch && d.button !== 0) return;
      if (touch) canvas.focus({preventScroll: true});
      const [x, y] = pos(e);
      if (measure) measureClick(x, y); else clickSelect(x, y, d.additive);
    }
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(type, end);
    canvas.addEventListener("pointerleave", () => { if (!drag) { pointer = null; hoverPending = true; requestFrame(); } });
    canvas.addEventListener("dblclick", e => {
      e.stopPropagation();
      if (!scene || e.pointerType === "touch" || touches.size || now() - lastTouch < 700) return;
      const h = pickAt(...pos(e), true); if (!h.point) return;
      goTo({...cam, target: h.point, dist: h.inst?.kind === "component" ? Math.max(scene.sphere.r * 0.08, len(sub(h.inst.box.slice(3), h.inst.box.slice(0, 3))) * 2.5) : cam.dist});
    });
    canvas.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      if (!scene || gesture || touches.size) return;
      const h = size()[1], k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * k, dy = e.deltaY * k, legacy = e.wheelDeltaY;
      if (!dx && !dy) return;
      // WebKit also reports a single macOS notch as a 40-pixel vertical event.
      const notched = Number.isFinite(legacy) && legacy !== 0 && legacy % 120 === 0 && legacy !== -3 * e.deltaY;
      const detent = e.deltaMode !== 0 || !dx && (notched || Math.abs(dy) >= 40 && Number.isInteger(dy) && dy % 40 === 0);
      if (e.ctrlKey || e.metaKey || detent && !e.shiftKey && dy) {
        zoom(Math.exp((dy || dx) * (e.ctrlKey ? 0.01 : 0.0015)), ...pos(e));
      } else {
        cameraInput(); anim = null;
        cam = e.shiftKey && !dx ? pan(cam, -dy, 0, h) : pan(cam, -dx, -dy, h);
        invalidate();
      }
    }, {passive: false});
    function webPinch(e) {
      e.preventDefault();
      if (!scene) return;
      const at = Number.isFinite(e.clientX) && Number.isFinite(e.clientY) ? pos(e) : gesture?.at || pointer || size().map(x => x / 2);
      const scale = Number.isFinite(e.scale) && e.scale > 0 ? e.scale : 0;
      if (e.type === "gesturestart") {
        anim = null;
        gesture = touches.size ? {at, direct: true} : startPinch(at, scale || 1);
      } else if (e.type !== "gesturechange") gesture = null;
      else if (gesture && !gesture.direct && scale) movePinch(gesture, at, scale);
    }
    for (const type of ["gesturestart", "gesturechange", "gestureend", "gesturecancel"]) canvas.addEventListener(type, webPinch, {passive: false});
    canvas.addEventListener("keydown", e => {
      if (e.key === "Escape" && measure) { e.stopPropagation(); e.preventDefault(); toggleMeasure(false); return; }
      if (!cam || e.ctrlKey || e.metaKey || e.altKey) return;
      const step = e.shiftKey ? 45 : 15, a = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]}[e.key];
      if (a) { e.preventDefault(); goTo({...cam, yaw: cam.yaw - a[0], pitch: Math.max(-90, Math.min(90, cam.pitch - a[1]))}, true); }
    });
    pop.addEventListener("keydown", e => {
      if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); togglePop(false, true); }
    });
    function stopDrawing() {
      renderedSize = null;
      finishOpening();
      finishInput();
      cancelBodies();
      if (rafId) globalThis.cancelAnimationFrame?.(rafId);
      clearTimeout(rebuildTimer); clearTimeout(coll.timer); clearTimeout(progressTimer); stopJournalWait();
      rafId = rebuildTimer = coll.timer = progressTimer = 0;
    }
    function cancelInput() {
      finishInput();
      if (touches.size) lastTouch = now();
      touches.clear(); drag = null; gesture = null; pointer = null;
      hoverPending = true; requestFrame();
    }
    globalThis.addEventListener?.("blur", cancelInput);
    function visibilityChanged() {
      if (!visible()) { cancelInput(); stopDrawing(); return; }
      refresh(); invalidate();
      collisionsSoon();
    }
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      // Observation starts after the synchronous opening draw. Redraw only
      // if the viewport changed or drawing was suspended while it was hidden.
      if (renderedSize && visible()) {
        const [w, h] = size();
        if (w === renderedSize[0] && h === renderedSize[1] && pixelRatio() === renderedDpr) return;
      }
      visibilityChanged();
    }) : null;
    ro?.observe(stage);
    const offPower = globalThis.AtriumPower?.onChange?.(visibilityChanged);
    if (!offPower) document.addEventListener?.("visibilitychange", visibilityChanged);
    const offTheme = globalThis.AtriumPCBAppearance?.onChange?.(() => invalidate());
    const onTheme = () => { colorsDirty = true; invalidate(); };
    globalThis.addEventListener?.("atrium-theme", onTheme);
    const onLost = e => { e.preventDefault(); scene && scene.batches.forEach(b => { b.gl = null; }); };
    const onRestored = () => {
      rendererPending = !visible();
      if (rendererPending) return;
      try { const r = createRenderer(canvas); if (r) { R = r; v.R = r; rebuild({force: true}); invalidate(); } } catch { /* stay blank */ }
    };
    canvas.addEventListener("webglcontextlost", onLost); canvas.addEventListener("webglcontextrestored", onRestored);

    // ---- commands (keys routed by the editor while this pane shows 3D)
    const BLOCKED = /^(route|route-diffpair|via|label|junction|split-wire|move-object|length-tune|length-tune-pair|length-tune-skew|polygon-pour|paste|place-at-pointer|select-at-pointer|cursor-step|layer-mode|layer-controls|view-config|grid|grid-next|grid-picker|grid-custom|tool-properties|pan|library|rotate|rotate-cw|rotate-ccw|nudge|duplicate)$/;
    function command(a) {
      if (!scene) return false;
      switch (a) {
        case "view3d-top": goTo(cameraFor(visibleBox(), aspect(), TOP, cam.fov)); return true;
        case "view3d-bottom": goTo(cameraFor(visibleBox(), aspect(), BOTTOM, cam.fov)); return true;
        case "view3d-flip": goTo(flipped(cam)); return true;
        case "view3d-home": goTo(cameraFor(visibleBox(), aspect(), HOME, cam.fov)); return true;
        case "fit": case "fit-objects": case "fit-document": fit(); return true;
        case "zoom-in": case "zoom-out": case "zoom-in-pointer": case "zoom-out-pointer": {
          const f = /in/.test(a) ? 0.8 : 1.25, [w, h] = size(), p = /pointer/.test(a) && pointer ? pointer : [w / 2, h / 2]; zoom(f, p[0], p[1]); return true;
        }
        case "measure": toggleMeasure(); return true;
        case "escape": if (measure) { toggleMeasure(false); return true; } if (!pop.hidden) { togglePop(false); return true; } return false;
        case "view-3d": canvas.focus({preventScroll: true}); refresh(); return true;
        case "screenshot-3d": screenshot(); return true;
        case "view3d-options": togglePop(); return true;
        case "view3d-fold": if (foldBtn.hidden) { ctx.info?.("This board has no bend lines to fold."); return true; } if (preview) setPreview(false); setFold(fold.t > 0 ? 0 : 1, true); return true;
        case "view3d-collisions": setCollisions(!coll.on); return true;
        case "view3d-step-preview": setPreview(!preview).catch(e => { preview = null; hud.textContent = "STEP preview failed: " + e.message; }); return true;
      }
      if (BLOCKED.test(a)) { ctx.info?.("Press 2 to return to the 2D layout for that command."); return true; }
      return false;
    }
    function refresh() {
      if (v.closed) return;
      if (ctx.alive && !ctx.alive() || !stage.isConnected) { close(); return; }
      if (rendererPending && visible()) onRestored();
      rebuild();
      if (visible()) syncSelection();
    }
    function close() {
      if (v.closed) return;
      saveCamera();
      v.closed = true;
      stopDrawing();
      previewPending = null; previewController?.abort();
      ro?.disconnect(); offPower?.(); offTheme?.(); offShortcuts?.();
      globalThis.removeEventListener?.("blur", cancelInput);
      if (!offPower) document.removeEventListener?.("visibilitychange", visibilityChanged);
      globalThis.removeEventListener?.("atrium-theme", onTheme);
      globalThis.removeEventListener?.("atrium-kicad-models-change", modelsChanged);
      canvas.removeEventListener("webglcontextlost", onLost); canvas.removeEventListener("webglcontextrestored", onRestored);
      const had = R.live(); R.dispose(); v.freed = {buffers: had, live: R.live()};
      if (scene) for (const b of scene.batches) b.gl = null;
      scene = null;
      const wasFocused = root.contains(document.activeElement);
      if (coveredCanvas) {
        coveredCanvas.removeEventListener("focus", forwardFocus);
        if (coveredTabIndex == null) coveredCanvas.removeAttribute("tabindex"); else coveredCanvas.setAttribute("tabindex", coveredTabIndex);
        if (coveredAria == null) coveredCanvas.removeAttribute("aria-hidden"); else coveredCanvas.setAttribute("aria-hidden", coveredAria);
      }
      root.remove(); viewers.delete(stage);
      if (built.doc) { const d = built.doc; clearTimeout(dropTimers.get(d)); dropTimers.set(d, setTimeout(() => { if (![...viewers.values()].some(x => x.doc?.() === d)) cache.delete(d); dropTimers.delete(d); }, 60000)); }
      if (wasFocused) coveredCanvas?.focus({preventScroll: true});
    }
    function stats() {
      return {webgl: R.version, samples: R.samples, gpuBytes: R.bytes(), buffers: R.live(), triangles: scene?.triangles || 0, batches: scene?.batches.length || 0,
        instances: scene ? scene.batches.reduce((n, b) => n + b.instances.length, 0) : 0, parts: scene?.parts.length || 0,
        draws: lastStats.draws, frameMs: lastStats.ms, buildMs, openMs: v.openMs || 0, renderer: R.renderer(),
        bodyBuildMs: built.mesh?.ms ?? null, layerBuildMs: built.mesh?.layers ? built.mesh.layerMs : null};
    }

    // ---- open
    // A full online check can take a frame while its requested board detail is still in flight.
    // Hold only idle jobs through the first complete draw. Slow external loads have a short upper bound.
    if (visible()) releaseOpening = ctx.holdIdle?.(250);
    rebuild();
    if (v.closed) return v;
    if (visible()) syncSelection();
    renderNow();
    v.openMs = now() - t0;
    Object.assign(v, {command, refresh, close, stats, renderNow, invalidate, screenshot, doc: () => built.doc, visible, wantLayers, progress, pending: pendingText,
      // Test and automation hooks.
      renderPending: () => !!(rafId || rebuildTimer || journalTimer || refreshQueue.has(built.doc)),
      camera: (c, instant = true) => { if (c) goTo({...cam, ...c}, instant); return cam; }, scene: () => scene, options: () => opt, setOption: setOpt,
      setClip: (axis, p) => { setClip(axis); if (clip && p != null) clip.pos = p; invalidate(); }, pickAt, toggleMeasure, measureClick, hover: (x, y) => { pointer = [x, y]; updateHover(); return hover; },
      clickSelect, togglePop, fold: setFold, foldState: () => fold.t, refold, recolor: () => { colorsDirty = true; invalidate(); },
      collisions: on => on == null ? {on: coll.on, findings: coll.findings, ids: [...coll.ids], text: coll.text} : setCollisions(!!on), stepPreview: on => on == null ? preview : setPreview(!!on)});
    // Every placed component, whether its body is drawn yet or its STEP model is still on its way.
    const parts = new Set((built.mesh?.model.parts || []).filter(p => p.id !== built.doc?.id).map(p => p.id)).size;
    ctx.info?.("3D layout mode · " + parts + " component" + (parts === 1 ? "" : "s") + " · Drag to orbit · Shift-drag or trackpad scroll to pan · Mouse wheel or pinch to zoom");
    if (visible()) canvas.focus({preventScroll: true});
    return v;
  }

  // No usable WebGL: explain and offer the STEP export instead.
  function fallback(v) {
    v.closed = false; v.fallback = true;
    const box = el("div", "v3d-fallback ui-popover"); box.setAttribute("role", "alert");
    const exp = button("Export 3D STEP…", "File → Export 3D STEP…", () => {
      if (typeof CustomEvent === "function") globalThis.dispatchEvent(new CustomEvent("atrium-command", {detail: "step"}));
    }, "ui-button"); exp.dataset.variant = "primary";
    const back = button("Back to 2D", "Back to 2D layout", () => { v.close(); if (typeof CustomEvent === "function") globalThis.dispatchEvent(new CustomEvent("atrium-command", {detail: "view-2d"})); }, "ui-button");
    globalThis.AtriumNavCommon?.shortcutTitle(back, "Back to 2D layout", globalThis.AtriumKeymap?.hintKey?.("view-2d", "pcb"));
    box.append(el("h2", null, "3D view needs WebGL"), el("p", null, "This system has neither WebGL 2 nor WebGL 1 with instancing and 32-bit indices, so the 3D view cannot run here. Export the board as STEP and open it in an MCAD viewer instead."), el("div", "v3d-actions"));
    box.lastChild.append(back, exp);
    v.root.querySelector(".v3d-hud")?.remove();
    v.root.append(box);
    Object.assign(v, {command: a => a === "escape" ? (v.close(), true) : false, refresh() {}, stats: () => ({webgl: 0}),
      close() { if (v.closed) return; v.closed = true; v.root.remove(); viewers.delete(v.stage); }, renderNow() {}});
    v.ctx.info?.("3D view is unavailable: WebGL is not supported here. Use File → Export 3D STEP… instead.");
    exp.focus();
  }

  // ---------------------------------------------------------------- module API
  function open(ctx) {
    if (!ctx?.stage) throw Error("Atrium3D.open needs a stage element.");
    if (!globalThis.AtriumSTEP) { ctx.info?.("3D needs the STEP geometry module."); return null; }
    const have = viewers.get(ctx.stage);
    if (have && !have.closed) { have.command?.("view-3d"); return have; }
    ensureCSS();
    const v = createViewer(ctx);
    if (!v.closed) viewers.set(ctx.stage, v);
    return v;
  }
  function isOpen(stage) {
    if (stage === undefined) { for (const v of viewers.values()) if (!v.closed) return true; return false; }
    const v = stage ? viewers.get(stage) : null; return !!(v && !v.closed);
  }
  function close(stage) {
    if (stage === undefined) { for (const v of [...viewers.values()]) v.close(); return; }
    viewers.get(stage)?.close();
  }
  function command(action, stage) {
    const v = stage === undefined ? [...viewers.values()][0] : viewers.get(stage);
    return !!(v && !v.closed && v.command(action));
  }
  function refresh() { for (const v of [...viewers.values()]) v.refresh(); }
  function stats(stage) { const v = stage === undefined ? [...viewers.values()][0] : viewers.get(stage); return v ? v.stats() : null; }
  return Object.freeze({open, isOpen, close, command, refresh, stats, viewers,
    math: Object.freeze({mul, invert, frame, matrices, ray, project, rayBox, rayTri, boxOf,
      cameraFor, cameraFrom2D, orbit, pan, zoomAt, flipped, lerpCam, ease, TOP, BOTTOM, HOME}),
    buildScene, pick, outerCaps, createRenderer, meshFor, loadBodyMeshes, MASKS, DEFAULTS, reducedMotion});
})();
