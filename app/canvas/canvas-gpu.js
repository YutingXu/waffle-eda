"use strict";
// AtriumCanvasGPU: the WebGL2 board renderer of the editor's board views (lazy; docs/design/gpu-renderer.md).
// Preferences › Display › Renderer chooses it (canvas-gpu-pref.js decides: Automatic uses it where WebGL2 is
// hardware-backed). The 2D renderer in canvas.js stays the fallback and draws print, export, previews and
// thumbnails; any WebGL2 failure falls back to it.
//
//   Two canvases. A WebGL2 canvas sits under the 2D canvas (same size, pointer-events off). It draws the
//     workspace, the line grid, the board area and edge, the origin marker and board-shape handles, poured
//     copper (with live pour tile patches), tracks, free pads and vias (pad and via stacks, blind and buried
//     ring colours), custom pads, footprint pads and line art, filled graphics and moving connection lines.
//     The 2D engine rasterizes text, pad captions, keepouts and dimensions in their actual copper or
//     artwork pass. Visible layers with translucent overlaps use the same ordered drawing primitives.
//     The GPU composites those textures between its layer draws. Settled connection lines, selection
//     controls and tool previews use the transparent top canvas.
//   Geometry. Layer buffers retain track capsules, pad/via lands and drills, footprint shapes and
//     filled triangles. The camera uses uniforms. Zoomed frames skip groups of off-screen instances.
//     Pours use the same display rings and viewport priorities as 2D, with stencil holes, live tile
//     patches and the repour reveal.
//   Edits. The view reconciles the undo journal or its snapshots, then coalesces changes before paint.
//     Objects overwrite their original slots. Inserting geometry before existing objects or growing a
//     primitive reorders its affected buffer. Selection updates instance state. Letters that change in
//     an otherwise stable view can upload just the changed rectangle.
//   Robustness. Lost contexts are restored on a fresh canvas and re-uploaded (the 2D path draws meanwhile); boards over the
//     GPU memory cap, too many views and any error fall back to 2D, with the reason in status().
globalThis.AtriumCanvasGPU = (() => {
  const G = globalThis, PCB = G.AtriumPCBAppearance;
  const now = () => G.performance?.now?.() ?? Date.now();
  const rad = a => (a || 0) * Math.PI / 180;
  // GPU memory a view may use (instances, pours, the union texture), and how many views may hold a context.
  const CAP_MB = 768, MAX_VIEWS = 6, MAX_LOSSES = 4;
  const TRACK_CHORD_ERROR = .002; // mm of sagitta in GPU centerlines
  const POUR_ALTERNATE_BYTES = 16 * 1048576;
  // Fault injection for renderer tests (globalThis.__atriumGpuFault; reset() after setting it): each
  // name breaks one thing on purpose, so the pixel test can show it catches that kind of regression.
  const fault = n => G.__atriumGpuFault === n;
  let force = null, failed = false, failReason = "", mode = "journal", nextScene = 0;
  const views = new Map(), preparing = new Map();
  let appearanceVersion = 0;
  PCB.onChange?.(() => appearanceVersion++);
  const visible = () => G.AtriumPower?.visible?.() ?? G.document?.visibilityState !== "hidden";
  const canPrepaintWide = I => I.canvas?.isConnected && !G.AtriumPower?.efficient?.();
  const decision = (probe = false) => { try { return G.AtriumCanvasGPUPref?.decision?.(probe) || null; } catch { return null; } };
  const wanted = (choice = decision()) => !failed && (force ?? choice?.use === true);
  const repaint = I => {
    if (!visible()) return;
    if (I?.repaint) I.repaint();
    else G.AtriumNavHost?.redraw?.(true);
  };
  function cancelPreparation(I) {
    preparing.get(I)?.cancel();
    preparing.delete(I);
  }
  function cancelSettle(st, continuing = false) {
    if (!continuing) releaseCanvas(st, "stripLarge");
    if (st.idle) clearTimeout(st.idle);
    st.idle = 0; st.settling = false;
    cancelSlices(st, "textJob");
  }
  // An idle job of text slices (textSlices) gives back its unfinished textures.
  function cancelSlices(st, name) {
    const job = st[name];
    if (!job) return;
    st[name] = null; job.cancel?.();
    if (job.T !== st.text && job.T !== st.wide?.text) for (const b of job.T.bands || []) st.gl.deleteTexture(b.tex);
  }
  // The preference changed (canvas-gpu-pref.js calls this): hide every view the GPU no longer draws.
  function refresh(preferenceChanged = false) {
    if (preferenceChanged) { failed = false; failReason = ""; }
    if (!visible()) return;
    if (!wanted()) {
      for (const I of preparing.keys()) cancelPreparation(I);
      const explicit2D = force == null && decision()?.mode === "2d";
      for (const I of views.keys()) explicit2D ? destroy(I) : hide(I);
    }
    repaint();
  }
  let shown = visible();
  G.AtriumPower?.onChange?.(s => {
    if (s.visible && s.efficient) for (const st of views.values()) cancelWide(st);
    if (s.visible === shown) return;
    shown = s.visible;
    if (shown) refresh();
    else {
      for (const I of preparing.keys()) cancelPreparation(I);
      for (const st of views.values()) { cancelSettle(st); cancelWide(st); cancelDriverMemoryProbe(st); }
    }
  });

  // ------------------------------------------------------------------ colours
  const rgbCache = new Map();
  let parser = null;
  function rgb(c) {
    let v = rgbCache.get(c);
    if (v) return v;
    const s = String(c || "").trim();
    let m, r = 0, g = 0, b = 0;
    if ((m = /^#([0-9a-f]{3,8})$/i.exec(s))) {
      let h = m[1]; if (h.length <= 4) h = [...h].map(x => x + x).join("");
      r = parseInt(h.slice(0, 2), 16) / 255; g = parseInt(h.slice(2, 4), 16) / 255; b = parseInt(h.slice(4, 6), 16) / 255;
    } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); r = p[0] / 255; g = p[1] / 255; b = p[2] / 255;
    } else {
      try {
        parser ??= (typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : G.document.createElement("canvas")).getContext("2d");
        parser.fillStyle = "#000"; parser.fillStyle = s; const t = parser.fillStyle;
        if (t !== s && /^(#|rgb)/.test(t)) { v = rgb(t); rgbCache.set(c, v); return v; }
      } catch {}
    }
    v = [r, g, b];
    if (rgbCache.size > 512) rgbCache.clear();
    rgbCache.set(c, v);
    return v;
  }

  // ------------------------------------------------------------------ shaders
  const HEAD = "#version 300 es\nprecision highp float;\nprecision highp int;\n";
  // u_cam = (cx, cy, device px per mm, x sign), u_res = device size: world to clip space.
  const CLIP = "uniform vec4 u_cam;uniform vec2 u_res;uniform float u_scale;\n" +
    "vec4 clip(vec2 w){vec2 d=vec2(u_cam.w*(w.x-u_cam.x),w.y-u_cam.y)*u_cam.z+u_res*.5;return vec4(d.x/u_res.x*2.-1.,1.-d.y/u_res.y*2.,0.,1.);}\n";
  const KIND = "uniform vec4 u_kinds;float kindAlpha(float k){int i=int(k+.5);return i==1?u_kinds.y:i==2?u_kinds.z:i==3?u_kinds.w:u_kinds.x;}\n";
  // i_st = (state, net colour index): state -1 hidden, 0 normal, 1 selected or lit; index 0 = no net colour.
  const SRC = {
    seg: [HEAD + CLIP + `
layout(location=0) in vec4 i_seg; layout(location=1) in vec4 i_w; layout(location=2) in vec2 i_st;
uniform float u_minmul, u_tintmul;
out vec2 v_uv; flat out float v_len, v_hw, v_st, v_kind, v_butt, v_tint, v_axis;
void main(){
  vec2 a=i_seg.xy, d=i_seg.zw-a; float len=length(d);
  vec2 t=len>0.?d/len:vec2(1.,0.), n=vec2(-t.y,t.x);
  float mm=u_minmul*(i_st.y>.5?u_tintmul:1.);
  float hw=.5*max(i_w.x,i_w.y*mm/u_scale), m=1.5/u_cam.z, e=hw+m;
  bool far=(gl_VertexID&1)==1; float side=(gl_VertexID&2)==2?1.:-1.;
  float along=i_w.w>.5?(far?len+m:-m):(far?len+e:-e);
  v_uv=vec2(along,side*e); v_len=len; v_hw=hw; v_st=i_st.x; v_kind=i_w.z; v_butt=i_w.w; v_tint=i_st.y;
  v_axis=max(abs(t.x),abs(t.y));
  gl_Position=i_st.x<-.5?vec4(2.,2.,2.,1.):clip(a+t*along+n*side*e);
}`, HEAD + KIND + `
in vec2 v_uv; flat in float v_len, v_hw, v_st, v_kind, v_butt, v_tint, v_axis;
uniform vec4 u_cam; uniform vec3 u_color, u_sel; uniform float u_alpha, u_onlyLit, u_tintOn; uniform sampler2D u_tints;
out vec4 o;
// Area of a pixel on one side of a line. Projecting the square onto the normal
// sums two uniform intervals, giving a flat centre and a quadratic tail.
float halfPlane(float x,float a,float b){
  float z=abs(x), edge=a+b;
  if(z>=edge)return x<0.?0.:1.;
  float t=edge-z;
  float tail=z<=a-b?.5-z/(2.*a):t*t/(8.*a*b);
  return x<0.?tail:1.-tail;
}
void main(){
  if(u_onlyLit>.5&&v_st<.5)discard;
  float px=1./u_cam.z, c;
  if(v_butt>.5){
    c=clamp(.5-max(-v_uv.x,v_uv.x-v_len)/px,0.,1.)*clamp(.5-(abs(v_uv.y)-v_hw)/px,0.,1.);
  }else if(v_kind==1.&&v_hw<=.50001*px&&v_uv.x>.75*px&&v_uv.x<v_len-.75*px){
    // At one device pixel use the area of the square between the track's
    // edges. The SDF ramp alone adds ink on the diagonals of narrow tracks.
    float a=.5*v_axis, b=.5*sqrt(max(0.,1.-v_axis*v_axis));
    float d=abs(v_uv.y)/px, w=v_hw/px;
    c=halfPlane(w-d,a,b)-halfPlane(-w-d,a,b);
  }else{
    float x=clamp(v_uv.x,0.,v_len);
    c=clamp(.5-(length(vec2(v_uv.x-x,v_uv.y))-v_hw)/px,0.,1.);
  }
  float a=c*u_alpha*kindAlpha(v_kind); if(a<=0.)discard;
  vec3 col=v_tint>.5&&u_tintOn>.5?texelFetch(u_tints,ivec2(int(v_tint+.5),0),0).rgb:u_color;
  o=vec4((v_st>.5&&u_onlyLit<.5?u_sel:col)*a,a);
}`],
    // Blob: x, y, half w, half h | angle, shape, shape parameter, kind | drill radius, hole kind (1 via, 2 pad), hairline, npth.
    // Shapes: 0 ellipse, 1 rectangle, 2 rounded rectangle, 3 octagon, 4 ring, 5 hole only, 6 rectangle outline.
    // Shapes 7–9 are the capped, filled and backdrilled via marks, with a CSS-pixel minimum drill diameter.
    blob: [HEAD + CLIP + `
layout(location=0) in vec4 i_a; layout(location=1) in vec4 i_b; layout(location=2) in vec4 i_c; layout(location=3) in vec2 i_st;
out vec2 v_p; flat out vec4 v_b; flat out vec4 v_c; flat out vec2 v_h; flat out float v_st;
void main(){
  vec2 s=vec2((gl_VertexID&1)==1?1.:-1.,(gl_VertexID&2)==2?1.:-1.);
  float m=1.5/u_cam.z+(i_c.w>.5?.4/u_scale:0.);
  vec2 h=max(i_a.zw,vec2(i_c.x))+m, lp=s*h; float ca=cos(i_b.x), sa=sin(i_b.x);
  v_p=lp; v_b=i_b; v_c=i_c; v_h=i_a.zw; v_st=i_st.x;
  gl_Position=i_st.x<-.5?vec4(2.,2.,2.,1.):clip(i_a.xy+vec2(lp.x*ca-lp.y*sa,lp.x*sa+lp.y*ca));
}`, HEAD + KIND + `
in vec2 v_p; flat in vec4 v_b; flat in vec4 v_c; flat in vec2 v_h; flat in float v_st;
uniform vec4 u_cam; uniform float u_scale, u_alpha, u_blind, u_viaOn; uniform vec3 u_color, u_via, u_sel, u_hole, u_padHole, u_drillEdge, u_holeA, u_holeB;
out vec4 o;
float box(vec2 p,vec2 r){vec2 q=abs(p)-r;return length(max(q,0.))+min(max(q.x,q.y),0.);}
float sdf(vec2 p,vec2 r,int shape,float k){
  if(shape==0){vec2 q=p/r;float L=length(q);float g=length(p/(r*r));return g<1e-9?-min(r.x,r.y):(L-1.)*L/g;}
  if(shape==2)return box(p,r-k)-k;
  if(shape==3)return max(box(p,r),(abs(p.x)+abs(p.y)-(r.x+r.y-k))*.70710678);
  if(shape==4)return abs(length(p)-k)-max(r.x-k,v_c.z*.45/u_scale);
  if(shape==6)return abs(box(p,r-k))-k;
  return box(p,r);
}
void main(){
  float px=1./u_cam.z; int shape=int(v_b.y+.5);
  if(shape>=7){
    if(2.*v_h.x*u_scale<v_c.z)discard;
    vec3 ink=shape==7?vec3(181.,138.,76.)/255.:shape==8?vec3(110.,115.,122.)/255.:vec3(224.,108.,117.)/255.;
    float radius=v_h.x, distance=length(v_p)-radius;
    if(shape==9){
      float h=.5*max(v_b.z,v_c.y/u_scale);
      distance=abs(length(v_p)-max(0.,radius-h))-h;
    }
    float alpha=clamp(.5-distance/px,0.,1.)*u_alpha*kindAlpha(v_b.w);
    o=vec4(ink*alpha,alpha);return;
  }
  float aL=v_c.w>.5||shape==5?0.:clamp(.5-sdf(v_p,v_h,shape,v_b.z)/px,0.,1.);
  // Keep the coverage of native legacy silk dots, whose zero-width GPU edge
  // contributed only within the fill's antialias band.
  if(shape==0&&v_b.z>.5)aL+=(1.-aL)*clamp(.5-abs(length(v_p)-v_h.x)/px,0.,1.);
  // A via's ring takes the via ink (PCB.viaInk); a blind or buried one 8 px across splits it into its
  // span's two copper colours, the second on the local +y half (canvas.js drawPad).
  bool via=u_viaOn>.5&&v_b.w>1.5&&v_b.w<2.5;
  vec3 land=via?u_via:u_color;
  if(via&&u_blind>.5&&min(v_h.x,v_h.y)*2.*u_scale>=8.)land=mix(u_holeA,u_holeB,clamp(.5+v_p.y/px,0.,1.));
  vec4 c=vec4((v_st>.5?u_sel:land)*aL,aL);
  if(v_c.x>0.){
    float r=length(v_p), aH=clamp(.5-(r-v_c.x)/px,0.,1.);
    vec3 hc=v_c.y>1.5?u_padHole:u_hole;
    c=vec4(hc*aH,aH)+c*(1.-aH);
    if(v_c.w>.5){float aE=clamp(.5-(abs(r-v_c.x)-.4/u_scale)/px,0.,1.);c=vec4(u_drillEdge*aE,aE)+c*(1.-aE);}
  }
  c*=u_alpha*kindAlpha(v_b.w); if(c.a<=0.)discard; o=c;
}`],
    tri: [HEAD + CLIP + `
layout(location=0) in vec4 a_p; layout(location=1) in vec2 a_st;
flat out float v_k, v_st, v_kind;
void main(){v_k=a_p.z;v_kind=a_p.w;v_st=a_st.x;gl_Position=a_st.x<-.5?vec4(2.,2.,2.,1.):clip(a_p.xy);}`, HEAD + KIND + `
flat in float v_k, v_st, v_kind; uniform vec3 u_color, u_sel, u_board; uniform float u_alpha; out vec4 o;
void main(){float a=u_alpha*kindAlpha(v_kind);o=vec4((v_k>.5?u_board:v_st>.5?u_sel:u_color)*a,a);}`],
    fan: [HEAD + CLIP + `
layout(location=0) in vec2 a_p; void main(){gl_Position=clip(a_p);}`, HEAD + `
uniform vec4 u_rgba; out vec4 o; void main(){o=u_rgba;}`],
    // A texture over the whole target: the union texture composited with an alpha.
    // u_xf = (k, tx, ty): the texture as drawn for an earlier camera, moved to this one (device px, top-left).
    // u_wrap: a panned text band (scrollText): moved by whole pixels, its texels addressed modulo its size.
    copy: [HEAD + `void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);gl_Position=vec4(p,0.,1.);}`, HEAD + `
uniform sampler2D u_tex; uniform float u_alpha, u_straight, u_wrap; uniform vec3 u_xf; uniform vec2 u_size; uniform vec4 u_maskInk; out vec4 o;
void main(){
  vec2 d=vec2(gl_FragCoord.x,u_size.y-gl_FragCoord.y), s=(d-u_xf.yz)/u_xf.x, t=vec2(s.x/u_size.x,1.-s.y/u_size.y);
  vec4 c;
  if(u_wrap>.5){ivec2 z=ivec2(u_size),q=ivec2(mod(floor(s),u_size));c=texelFetch(u_tex,ivec2(q.x,z.y-1-q.y),0);}
  else{if(t.x<0.||t.y<0.||t.x>1.||t.y>1.)discard;c=texture(u_tex,t);}if(u_maskInk.a>.5)c.rgb=u_maskInk.rgb;if(u_straight>.5)c.rgb*=c.a;o=c*u_alpha;
}`],
    // One opaque, one-device-pixel quad per line, already rounded in Canvas coordinates.
    grid: [HEAD + `
layout(location=0) in vec3 i_line;
uniform vec2 u_res;
flat out int v_pass;
void main(){
  vec2 q=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));
  vec2 d=i_line.y>.5?vec2(i_line.x+q.x,q.y*u_res.y):vec2(q.x*u_res.x,i_line.x+q.y);
  gl_Position=vec4(d.x/u_res.x*2.-1.,1.-d.y/u_res.y*2.,0.,1.);
  v_pass=int(i_line.z);
}`, HEAD + `
flat in int v_pass;
uniform vec3 u_fine,u_coarse,u_fineOdd,u_coarseOdd;
out vec4 o;
void main(){o=vec4(v_pass==0?u_fineOdd:v_pass==1?u_coarseOdd:v_pass==2?u_fine:u_coarse,1.);}`]
  };
  function program(gl, [vs, fs]) {
    const p = gl.createProgram(), shaders = [];
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const shader = gl.createShader(type);
        shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost())
          throw Error("GPU shader: " + gl.getShaderInfoLog(shader));
        gl.attachShader(p, shader);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw Error("GPU program: " + gl.getProgramInfoLog(p));
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
      return {p, u, frame: -1, offset: 0, width: 0, height: 0};
    } catch (error) {
      gl.deleteProgram(p);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  // ------------------------------------------------------------------ instance buffers
  // kind: "seg" (8 floats an instance), "blob" (12), "tri" (4 a vertex). own[slot] is the object the slot
  // draws (null: dead), net[slot] its net number, st[2 slot] its state and net colour index.
  // tint: 1 items (tracks and polygons take net colours), 2 connection lines (all take them).
  const STRIDE = {seg: 8, blob: 12, tri: 4};
  const PAGE = 384; // multiple of three: triangle pages never split a primitive
  function buffer(kind, tint = 0) {
    const cap = 64;
    return {kind, tint, stride: STRIDE[kind], cap, n: 0, dead: 0, f: new Float32Array(cap * STRIDE[kind]), st: new Float32Array(cap * 2),
      own: new Array(cap).fill(null), net: new Int32Array(cap), lo: Infinity, hi: -1, slo: 0, shi: -1, gl: null, gst: null, vao: null, glCap: 0};
  }
  function push(b, vals, owner, net) {
    if (b.n === b.cap) {
      const cap = b.cap * 2, f = new Float32Array(cap * b.stride), st = new Float32Array(cap * 2), nn = new Int32Array(cap);
      f.set(b.f); st.set(b.st); nn.set(b.net); b.f = f; b.st = st; b.net = nn; b.own.length = cap; b.cap = cap;
    }
    return writeSlot(b, b.n++, vals, owner, net);
  }
  function writeSlot(b, s, vals, owner, net) {
    b.f.set(vals, s * b.stride); b.st[2 * s] = 0; b.st[2 * s + 1] = 0; b.own[s] = owner; b.net[s] = net;
    if (s < b.lo) b.lo = s; if (s > b.hi) b.hi = s; mark(b, s);
    if (b.pages) b.pages[Math.floor(s / PAGE)] = undefined;
    return s;
  }
  // The state slots to upload (a range; the whole buffer is never re-sent for a few changed slots).
  function mark(b, s) { if (b.shi < b.slo) { b.slo = s; b.shi = s; } else { if (s < b.slo) b.slo = s; if (s > b.shi) b.shi = s; } }
  function clear(b) { b.n = 0; b.dead = 0; b.lo = Infinity; b.hi = -1; b.slo = 0; b.shi = -1; if (b.pages) b.pages.length = 0; }
  function pageBounds(b, first, boxes) {
    const box = [Infinity, Infinity, -Infinity, -Infinity], end = Math.min(first + PAGE, b.n);
    for (let s = first; s < end; s++) {
      const q = boxes.get(b.own[s]); if (!q) continue;
      box[0] = Math.min(box[0], q[0]); box[1] = Math.min(box[1], q[1]);
      box[2] = Math.max(box[2], q[2]); box[3] = Math.max(box[3], q[3]);
    }
    return box;
  }
  // Instanced WebGL2 draws start at slot zero. Moving the attribute offsets selects a contiguous
  // group of retained instances without uploading or copying them when the camera moves.
  function drawSlots(gl, b, first, count) {
    if (b.kind === "tri") { gl.drawArrays(gl.TRIANGLES, first, count); return; }
    if ((b.first || 0) !== first) {
      const attrs = b.kind === "seg" ? 2 : 3;
      gl.bindBuffer(gl.ARRAY_BUFFER, b.gl);
      for (let a = 0; a < attrs; a++) gl.vertexAttribPointer(a, 4, gl.FLOAT, false, b.stride * 4, (first * b.stride + 4 * a) * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.gst); gl.vertexAttribPointer(attrs, 2, gl.FLOAT, false, 8, first * 8);
      b.first = first;
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }
  function upload(st, b) {
    const gl = st.gl;
    if (!b.gl) {
      b.gl = gl.createBuffer(); b.gst = gl.createBuffer(); b.vao = gl.createVertexArray();
      gl.bindVertexArray(b.vao); gl.bindBuffer(gl.ARRAY_BUFFER, b.gl);
      const at = (loc, size, off, div) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, b.stride * 4, off * 4); gl.vertexAttribDivisor(loc, div); };
      if (b.kind === "seg") { at(0, 4, 0, 1); at(1, 4, 4, 1); }
      else if (b.kind === "blob") { at(0, 4, 0, 1); at(1, 4, 4, 1); at(2, 4, 8, 1); }
      else at(0, 4, 0, 0);
      const loc = b.kind === "seg" ? 2 : b.kind === "blob" ? 3 : 1;
      gl.bindBuffer(gl.ARRAY_BUFFER, b.gst); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 8, 0); gl.vertexAttribDivisor(loc, b.kind === "tri" ? 0 : 1);
      gl.bindVertexArray(null);
    }
    let bytes = 0;
    if (b.glCap < b.cap) {
      st.checkMemory = true;
      gl.bindBuffer(gl.ARRAY_BUFFER, b.gl); gl.bufferData(gl.ARRAY_BUFFER, b.f, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.gst); gl.bufferData(gl.ARRAY_BUFFER, b.st, gl.DYNAMIC_DRAW);
      b.glCap = b.cap; bytes += b.f.byteLength + b.st.byteLength;
    } else {
      if (b.hi >= b.lo) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.gl);
        gl.bufferSubData(gl.ARRAY_BUFFER, b.lo * b.stride * 4, b.f, b.lo * b.stride, (b.hi - b.lo + 1) * b.stride);
        bytes += (b.hi - b.lo + 1) * b.stride * 4;
      }
      const s1 = Math.min(b.shi, b.n - 1);
      if (s1 >= b.slo) { gl.bindBuffer(gl.ARRAY_BUFFER, b.gst); gl.bufferSubData(gl.ARRAY_BUFFER, b.slo * 8, b.st, b.slo * 2, (s1 - b.slo + 1) * 2); bytes += (s1 - b.slo + 1) * 8; }
    }
    b.lo = Infinity; b.hi = -1; b.slo = 0; b.shi = -1;
    return bytes;
  }
  function free(gl, b) { if (b.gl) { gl.deleteBuffer(b.gl); gl.deleteBuffer(b.gst); gl.deleteVertexArray(b.vao); b.gl = null; b.glCap = 0; } }

  // ------------------------------------------------------------------ scene: objects to instances
  const ITEMS = ["tri", "seg", "blob", "viaMarks"], PARTS = ["ptri", "pseg", "pblob"];
  // Objects the 2D canvas keeps (text, keepouts, dimensions).
  const twoD = i => i.kind === "label" || i.kind === "netlabel" || i.kind === "part" || i.dimension || (i.keepout === true && i.points);
  const marked = i => i.kind === "via" && (i.ipc4761 || i.backdrill);
  const {boardLayer, layerRank} = PCB;
  const EDGE = Object.freeze({id: null});
  function stacked(p) { return PCB.hasPadRows(p) || p.kind === "via" && !!p.stackMode && p.stackMode !== "simple"; }
  const committedGeometry = c => mode === "journal" ? (c.panel ? c.panel.geometry : G.AtriumNavHost?.boardGeometry?.(c.doc)) : null;
  const sourceOwner = (c,id) => c.panel?.records.get(id)?.owner ||
    {documentId:c.panel?.root.id??c.doc.id,instancePath:[],kind:"item",id};
  const projectedId = (c,owner) => c.panel ? G.AtriumPanel.projectedItem(c.panel,owner) :
    owner.kind==="item" && owner.documentId===c.doc.id && !owner.instancePath.length ? owner.id : undefined;
  function scene(c, geometry) {
    return {id: ++nextScene, cache: c, rev: c.rev, lib: c.lib, defs: c.defs, geometry, geometryRevision: geometry?.revision,
      geometryProvider: G.AtriumResolvedGeometry, layers: new Map(), recs: new Map(), nets: new Map([["", 0]]), netNames: [""],
      prints: mode === "prints" ? new Map(c.prints) : null, edge: buffer("seg"), air: buffer("seg", 2), airRes: null,
      outline: null, docSig: null, stKey: null, stSel: null, fresh: [], two: null, byId: c.byId, built: 0, active: "Top", dep: new Map(), awaitingMarks: null, maxPad: 0,
      textRev: c.rev, padRev: c.rev, stackDisplay: G.AtriumViaStack?.display, stackEpoch:0, textItems: new Set(), reorder: new Set(), pending: null};
  }
  // A layer bucket; Multi objects with a layer span (blind and buried vias) get a bucket per span, so their
  // visibility and dim ink follow the span (PCB.onLayer with the object) and their ring shows both colours.
  function L(S, layer, item) {
    const span = layer === "Multi" && item && (item.fromLayer || item.toLayer) ? layer + "\u0001" + (item.fromLayer || "") + "\u0001" + (item.toLayer || "") : layer;
    let l = S.layers.get(span);
    if (!l) {
      const rep = span === layer ? null : {fromLayer: item.fromLayer, toLayer: item.toLayer};
      l = {layer, rep, blind: !!rep && PCB.partialSpan(rep),
        tri: buffer("tri"), seg: buffer("seg", 1), blob: buffer("blob"), viaMarks: buffer("blob"), ptri: buffer("tri"), pseg: buffer("seg"), pblob: buffer("blob")};
      for (const name of [...ITEMS, ...PARTS]) l[name].geometry = true;
      S.layers.set(span, l);
    }
    return l;
  }
  const netOf = (S, n) => { if (!n) return 0; let v = S.nets.get(n); if (v == null) { v = S.nets.size; S.nets.set(n, v); S.netNames.push(n); } return v; };
  function* bufs(S) { for (const l of S.layers.values()) { for (const k of ITEMS) yield l[k]; for (const k of PARTS) yield l[k]; } yield S.edge; yield S.air; }

  // One object's instances; returns the slots it took ([buffer, first, count] triples).
  function emit(S, i, previous, geometry = S.geometry) {
    const out = [], active = S.active;
    let range = 0, used = 0;
    const put = (b, vals, net, owner = i) => {
      const old = previous?.[range];
      let s;
      if (old && old[0] === b) {
        s = writeSlot(b, old[1] + used, vals, owner, net); b.dead--;
        if (++used === old[2]) { range++; used = 0; }
      } else {
        s = push(b, vals, owner, net);
        if (previous) S.reorder.add(b);
      }
      const last = out[out.length - 1];
      if (last && last[0] === b && last[1] + last[2] === s) last[2]++;
      else out.push([b, s, 1]);
    };
    const segs = (b, pts, closed, w, mpx, kind, net, tf) => {
      for (let k = 1; k < pts.length + (closed ? 1 : 0); k++) {
        const p = tf(pts[k - 1]), q = tf(pts[k % pts.length]);
        put(b, [p[0], p[1], q[0], q[1], w, mpx, kind, 0], net);
      }
    };
    const fill = (b, pts, board, kind, net, tf) => {
      for (const triangle of G.Atrium.triangulateRing(pts, undefined, "paint")) for (const p of triangle) {
        const q = tf(p); put(b, [q[0], q[1], board ? 1 : 0, kind], net);
      }
    };
    // drawPad: land (shape), then the drill in the via-hole or pad-hole colour, then a non-plated hole's edge.
    const pad = (l, parts, p0, x, y, local, angle, kind, net, tf, mirror = false) => {
      const g = PCB.padGeometry(p0, active, l.layer);
      if (!g) return;
      const {w, h, shape, min:m} = g;
      let drill = g.drill > 0 ? g.drill / 2 : 0;
      const npth = g.holeOnly ? 1 : 0;
      const holeKind = p0.kind === "via" ? 1 : 2;
      if(g.x!==p0.x || g.y!==p0.y){
        if(drill)put(parts ? l.pblob : l.blob,[...tf([x,y]),drill,drill,angle,5,0,kind,drill,holeKind,0,0],net);
        drill=0;x+=g.x-p0.x;y+=g.y-p0.y;
      }
      const turn=rad(g.angle-(p0.angle||0));local+=turn;angle+=mirror?-turn:turn;
      if (!npth && m > S.maxPad) S.maxPad = m;
      if (shape === "custom" && g.poly?.length > 2) {
        const a = Math.cos(local), s = Math.sin(local), at = q => tf([x + q[0] * a - q[1] * s, y + q[0] * s + q[1] * a]);
        if (!npth) fill(parts ? l.ptri : l.tri, PCB.padPolygon(g), false, kind, net, at);
        if (drill || npth) put(parts ? l.pblob : l.blob, [...tf([x, y]), w / 2, h / 2, angle, 5, 0, kind, drill, holeKind, 0, npth], net);
        return;
      }
      const code = shape === "circle" || shape === "ellipse" ? 0 : shape === "octagon" ? 3 : shape === "roundrect" || shape === "obround" ? 2 : 1;
      put(parts ? l.pblob : l.blob, [...tf([x, y]), w / 2, h / 2, angle, code, code === 2 ? g.r : g.t, kind, drill, holeKind, 0, npth], net);
    };
    const id = p => p;
    let dep = false;
    if (i.kind === "part") {
      const fp = PCB.readDefinition(S.defs,i.def,S.cache.doc)?.footprint;
      if (!fp) return out;
      const {angle:a,at:tf,mirror} = PCB.footprintPlacement(i);
      for (const group of PCB.footprintLayers(i, fp)) {
        const l = L(S, group.layer);
        for (const s of group.shapes) {
          if (s.kind === "text" || s.cutout || s.keepout) continue;
          // Native style-only overlay outlines use the beta GPU hairline.
          // The ordinary 2D pen also drives the vector print output.
          const legacySilk = s.style === "silk" && !s.layer && s.width == null && (s.closed || s.fill);
          const net = netOf(S, s.net), w = legacySilk ? (s.fill ? null : 0) : PCB.shapeStrokeWidth(s);
          if (s.kind === "circle") {
            const c = tf([s.x, s.y]);
            if (s.fill) put(l.pblob, [c[0], c[1], s.r, s.r, 0, 0, legacySilk ? 1 : 0, 0, 0, 0, 0, 0], net);
            if (w !== null) put(l.pblob, [c[0], c[1], s.r + w / 2, s.r + w / 2, 0, 4, s.r, 0, 0, 0, w === 0 && !legacySilk ? 1 : 0, 0], net);
          } else if (s.points?.length) {
            if (s.fill) fill(l.ptri, s.points, s.style === "package", 0, net, tf);
            if (w !== null) segs(l.pseg, s.points, s.closed, w, .9, 0, net, tf);
          }
        }
        for (const p of group.pads) {
          if (stacked(p)) dep = true;
          const local=rad(p.angle);
          pad(l, true, p, p.x, p.y, local, a + (mirror ? -local : local), 3, netOf(S, PCB.padNet(p,i)), tf, mirror);
        }
      }
    } else if (twoD(i)) {
      return out;
    } else if (i.kind === "track" && geometry) {
      const owner = geometry.owner(sourceOwner(S.cache,i.id));
      let path, samples;
      for (const {key, ink, net} of owner?.features || []) {
        if (ink.kind !== "stroke") continue;
        const track = key.role === "track", {seg} = L(S, key.layer), n = netOf(S, net);
        const width = ink.width * (fault("trackWidth") && track ? .9 : 1);
        for (const edge of ink.centerline) {
          if (edge.kind === "line") put(seg, [...edge.a, ...edge.b, width, 1, +track, 0], n);
          else {
            if (path !== edge) { path = edge; samples = G.AtriumGeometryCurves.flatten([edge], TRACK_CHORD_ERROR); }
            segs(seg, samples, false, width, 1, +track, n, id);
          }
        }
      }
    } else if (i.points?.length) {
      const layer = boardLayer(i), l = L(S, layer), net = netOf(S, i.net), w = PCB.boardStrokeWidth(i), track = i.kind === "track";
      const points = track ? G.AtriumGeometryCurves.pathPoints(i, TRACK_CHORD_ERROR) : i.points;
      const stroke = (b, width, kind, n) =>
        segs(b, points, points === i.points && (i.kind === "polygon" || i.closed), width, 1, kind, n, id);
      if (i.fill) fill(l.tri, i.points, false, 0, net, id);
      if (w !== null) stroke(l.seg, w * (fault("trackWidth") && track ? .9 : 1), +track, net);
      for (const opening of PCB.traceOpenings(i, layer)) stroke(L(S, opening.layer).seg, opening.width, 0, 0);
    } else if (i.kind === "via" || i.kind === "pad") {
      if (fault("smallVias") && i.kind === "via" && (i.diameter || 0) < .7) return out;
      if (stacked(i)) dep = true;
      const layer = L(S, boardLayer(i), i), net = netOf(S, i.net);
      pad(layer, false, i, i.x, i.y, rad(i.angle), rad(i.angle), i.kind === "via" ? 2 : 3, net, id);
      if (marked(i)) {
        const geometry = G.AtriumViaStack?.markGeometry;
        if (!geometry) (S.awaitingMarks ||= new Map()).set(i.id, i);
        const mark = geometry?.(i);
        if (mark) {
          const r = mark.diameter / 2;
          if (mark.fill) put(layer.viaMarks, [i.x, i.y, r, r, 0, mark.fill === "#b58a4c" ? 7 : 8, 0, 2, 0, 0, mark.minDrillPx, 0], net);
          if (mark.ring) put(layer.viaMarks, [i.x, i.y, r, r, 0, 9, mark.ringWidth, 2, 0, mark.minRingPx, mark.minDrillPx, 0], net);
        }
      }
    }
    if (dep) S.dep.set(i.id, i);
    return out;
  }
  function kill(S, id) {
    const r = S.recs.get(id);
    S.dep.delete(id); S.awaitingMarks?.delete(id);
    if (!r) return;
    for (const [b, s, n] of r) { for (let k = s; k < s + n; k++) { b.own[k] = null; b.st[2 * k] = -1; } b.dead += n; mark(b, s); mark(b, s + n - 1); }
    S.recs.delete(id);
  }
  function add(S, i, previous, geometry) { const r = emit(S, i, previous, geometry); if (r.length) { S.recs.set(i.id, r); for (const x of r) S.fresh.push(x); } return r; }
  function replace(S, i, insertedBefore, geometry) {
    const previous = S.recs.get(i.id); kill(S, i.id);
    const next = add(S, i, previous, geometry);
    if (insertedBefore && !previous) for (const [b] of next) S.reorder.add(b);
  }
  // Only a new or expanded object inserted before other geometry needs its layer buffer reordered.
  // A move or property change with the same slots writes those instances back in place.
  function reorder(S) {
    if (!S.reorder.size) return;
    const order = new Map(S.cache.all.map((item, index) => [item, index]));
    for (const b of S.reorder) {
      const slots = [];
      for (let s = 0; s < b.n; s++) if (b.own[s]) slots.push(s);
      slots.sort((a, z) => order.get(b.own[a]) - order.get(b.own[z]));
      const owners = b.own, values = b.f, nets = b.net;
      b.own = new Array(b.cap); b.f = new Float32Array(values.length); b.net = new Int32Array(nets.length);
      clear(b);
      let last = null, range;
      for (const src of slots) {
        const i = owners[src], s = b.n++;
        writeSlot(b, s, values.subarray(src * b.stride, (src + 1) * b.stride), i, nets[src]);
        if (i === last) range[2]++;
        else {
          const recs = S.recs.get(i.id).filter(r => r[0] !== b);
          recs.push(range = [b, s, 1]); S.recs.set(i.id, recs); last = i;
        }
      }
    }
    S.reorder.clear(); S.stKey = null; S.fresh.length = 0;
  }
  // Several input events can arrive before the next paint or while a split is inactive.
  function mergeBounds(a, b) {
    if (!a || !b) return a || b;
    return [Math.min(a[0],b[0]), Math.min(a[1],b[1]), Math.max(a[2],b[2]), Math.max(a[3],b[3])];
  }
  function damage(I, c, delta) {
    const st = views.get(I), S = st?.scene?.cache === c ? st.scene : st?.parked.get(c);
    const over = st?.over;
    if (over?.doc === c.doc && over.kind !== "viewport") {
      over.shrink = (over.to === delta.from ? over.shrink : 0) - (delta.sizeDelta || 0);
      over.to = delta.to;
    }
    if (!S) return;
    let p = S.pending;
    if (!p || p.to !== delta.from) p = S.pending = {from: delta.from, changed: new Map(), removed: new Map(), appendOnly: true, poursChanged: false, known: true, itemsKnown: true, box: null};
    for (const r of delta.removed) { p.changed.delete(r.id); if (!p.removed.has(r.id)) p.removed.set(r.id, r); }
    for (const i of delta.changed) p.changed.set(i.id, i);
    p.to = delta.to; p.appendOnly &&= delta.appendOnly; p.poursChanged ||= delta.poursChanged;
    p.known &&= delta.known; p.itemsKnown &&= delta.itemsKnown ?? delta.known;
    p.box = mergeBounds(p.box, delta.box);
  }

  function freeScene(st, S) {
    if (!S) return;
    for (const b of bufs(S)) free(st.gl, b);
    if (S.outline) { const o = S.outline; st.gl.deleteVertexArray(o.vao); st.gl.deleteBuffer(o.vb); st.gl.deleteBuffer(o.ib); S.outline = null; }
  }
  function build(st, c, active, transient, geometry = transient ? null : committedGeometry(c)) {
    const t = now();
    freeScene(st, st.scene);
    const S = scene(c, geometry);
    S.active = active; S.transient = transient;
    for (const i of c.all) { add(S, i); if (twoD(i)) S.textItems.add(i); }
    S.built = now() - t;
    st.scene = S; st.stats.builds++; st.stats.buildMs = S.built; st.checkMemory = true;
    return S;
  }
  // The objects an edit changed: canvas.js's snapshots (mode "prints") or the undo journal. A document
  // switch parks this scene and takes back a parked one (canvas-fast.js parks canvas.js's caches the same way).
  function update(st, c, active, transient = false) {
    let S = st.scene;
    // The spatial cache may rebuild on a definition or board metadata edit.
    // Keep the GPU slots if the same item array still has a committed lineage.
    const rebound = S?.geometry && S.cache !== c && S.cache.doc === c.doc && S.cache.items === c.items;
    if (S && S.cache !== c && !rebound) {
      const back = st.parked.get(c);
      st.parked.delete(c);
      if (!st.lean && S.cache.doc !== c.doc) st.parked.set(S.cache, S); else freeScene(st, S);
      for (const [old, scene] of st.parked) if (old.doc === c.doc) { freeScene(st, scene); st.parked.delete(old); }
      while (st.parked.size > 2) { const [k, v] = st.parked.entries().next().value; st.parked.delete(k); freeScene(st, v); }
      st.scene = S = back || null;
    }
    if (!S || S.lib !== c.lib && !rebound) return build(st, c, active, transient);
    const stackDisplay=G.AtriumViaStack?.display, stackChanged=S.stackDisplay!==stackDisplay;
    if (S.awaitingMarks?.size && G.AtriumViaStack?.markGeometry) {
      // The board can start drawing before the idle-loaded via stack module.
      const pending = S.awaitingMarks;
      S.awaitingMarks = null;
      for (const item of pending.values()) if (c.byId.get(item.id) === item) replace(S, item);
    }
    const providerChanged = S.geometryProvider !== G.AtriumResolvedGeometry ||
      !!c.panel && c.panel.revision!==S.geometryRevision;
    if (S.rev === c.rev && S.active === active && !stackChanged && !providerChanged && S.transient === transient) return S;
    const t = now();
    let n = 0, ink = null;
    if (!transient && (S.rev !== c.rev || providerChanged || S.transient)) {
      const geometry = committedGeometry(c);
      if (!!geometry !== !!S.geometry) return build(st, c, active, transient, geometry);
      const revision = geometry?.revision;
      ink = revision===S.geometryRevision ? null : c.panel ? G.AtriumPanel.projectedChanges(c.panel,S.geometryRevision) :
        geometry.changes(S.geometryRevision);
      if (ink?.kind === "cold") return build(st, c, active, transient, geometry);
      S.geometry = geometry; S.geometryRevision = revision; S.geometryProvider = G.AtriumResolvedGeometry;
    }
    S.transient = transient;
    if (S.rev !== c.rev || ink) {
      const p = S.pending?.from === S.rev && S.pending.to === c.rev ? S.pending : null;
      const delta = p || c.delta;
      const contiguous = delta?.from === S.rev;
      S.pending = null;
      if (!contiguous && !(ink && (rebound || S.rev === c.rev))) return build(st, c, active, transient);
      let changed;
      if (mode === "prints") {
        changed = [];
        for (const [i, p] of c.prints) if (S.prints.get(i) !== p) { S.prints.set(i, p); changed.push(i); }
      } else {
        changed = contiguous ? p ? p.changed.values() : delta.changed : [];
        if (ink) {
          // The journal still accounts for screen-only content. Add the physical
          // owners from the committed view, including edits to their definitions.
          const items = new Set(changed);
          for (const owner of ink.owners) {
            const id=projectedId(c,owner);
            if(id==null)continue;
            const item=c.byId.get(id);
            if(item)items.add(item);else kill(S,id);
          }
          changed = items;
        }
      }
      const oldRev = S.rev;
      S.rev = c.rev; S.cache = c; S.lib = c.lib; S.defs = c.defs; S.byId = c.byId; S.viewItems = null;
      const box = ink ? ink.bounds.reduce(mergeBounds, delta?.box) : delta?.box;
      S.damage = {from: oldRev, to: c.rev, known: contiguous && delta.known,
        itemsKnown: contiguous && (delta.itemsKnown ?? delta.known), poursChanged: !!delta?.poursChanged, box, layers: ink?.layers};
      if (delta?.poursChanged) S.textRev = c.rev;
      for (const {id, item} of contiguous ? p ? p.removed.values() : delta.removed : []) {
        kill(S, id); S.prints?.delete(item);
        if (S.textItems.delete(item)) { S.textRev = c.rev; S.two = null; }
        if (item.kind === "via" || item.kind === "pad") S.padRev = c.rev;
        n++;
      }
      let effective = S.geometry;
      if (transient && effective) {
        changed = Array.from(changed);
        const edits = c.panel ? [] : changed.filter(i=>i.kind==="track").map(value=>({kind:"item",value,owner:sourceOwner(c,value.id)}));
        if(c.panel)effective=null;
        if (edits.length) {
          try { effective = G.AtriumResolvedGeometry.preview(effective,edits); }
          catch (error) { if (error.code !== "STALE_GEOMETRY") throw error; effective = null; }
        }
      }
      for (const i of changed) {
        const before = S.textItems.has(i), after = !!twoD(i);
        if (before || after) S.textRev = c.rev;
        if (before !== after) { if (after) S.textItems.add(i); else S.textItems.delete(i); S.two = null; }
        if (i.kind === "pad" || i.kind === "via" || i.kind === "part") S.padRev = c.rev;
        if (c.boxes.has(i)) replace(S, i, !delta?.appendOnly, effective); n++;
      }
    }
    // Pad and via stacks show the active layer's land. The first scene can
    // predate the idle-loaded via stack resolver.
    if (S.active !== active || stackChanged) {
      S.active=active;S.stackDisplay=stackDisplay;
      if(stackChanged)S.stackEpoch++;
      for (const i of [...S.dep.values()]) { replace(S, i); n++; }
    }
    reorder(S);
    let dead = 0, total = 0;
    for (const b of bufs(S)) { dead += b.dead; total += b.n; }
    if (dead > 4096 && dead * 2 > total) return build(st, c, active, transient);
    st.stats.updates++; st.stats.updateMs = now() - t; st.stats.updated = n;
    return S;
  }
  // Per-slot state and net colour: -1 hidden (dead, or hidden by the router's preview), 1 selected or on the
  // highlighted net, 0 otherwise; the colour index of the net's colour (Nets panel, F5) for tracks, polygons
  // and connection lines.
  // Objects absent from this frame: the router's preview hides the copper it replaces, and a
  // collaborator's edit that is still animating (opts.hide: item objects, collab-object-motion.js)
  // stays off the board until its overlay lands. Both are ids here.
  const goneCache = new WeakMap();
  function goneIds(opts) {
    if (!opts.hide?.size) return opts.routePreview?.hidden;
    let ids = goneCache.get(opts);
    if (!ids) goneCache.set(opts, ids = [...(opts.routePreview?.hidden || []), ...[...opts.hide].map(i => i.id)]);
    return ids;
  }
  function states(S, opts, tint) {
    const ids = opts.selectedIds, hidden = goneIds(opts);
    const rest = (opts.highlight || "") + "|" + (hidden?.length ? hidden.join(",") : "") + "|" + tint.key;
    const chosen = new Set(ids || []); if (opts.selected != null) chosen.add(opts.selected);
    // A selection change (a click) recomputes only the slots of the objects whose selection changed; the
    // highlight, the router's hidden objects or the net colours changing recompute every slot.
    let ranges = null;
    if (rest === S.stKey && S.stSel && chosen.size <= 64) {
      const changed = [...chosen].filter(x => !S.stSel.has(x)).concat([...S.stSel].filter(x => !chosen.has(x)));
      if (!changed.length && !S.fresh.length) return;
      ranges = S.fresh.slice();
      for (const id of changed) for (const r of S.recs.get(id) || []) ranges.push(r);
      // Connection lines and the edge carry no ids.
    }
    S.stKey = rest; S.stSel = chosen.size <= 64 ? chosen : null;
    const hi = opts.highlight ? S.nets.get(opts.highlight) ?? -2 : -2, sel = opts.selected, gone = hidden?.length ? new Set(hidden) : null;
    const tn = tint.byNet, names = S.netNames;
    for (const [b, s0, n0] of ranges || [...bufs(S)].map(b => [b, 0, b.n])) {
      const own = b.own, st = b.st, net = b.net, tb = tn && b.tint;
      for (let s = s0; s < s0 + n0; s++) {
        const o = own[s];
        const v = !o ? -1 : o.id == null ? (net[s] === hi ? 1 : 0) : gone?.has(o.id) ? -1 : (o.id === sel || ids?.has(o.id) || net[s] === hi) ? 1 : 0;
        const t = tb && o && net[s] && (tb === 2 || o.kind === "track" || o.kind === "polygon") ? tn.get(names[net[s]]) || 0 : 0;
        if (st[2 * s] !== v || st[2 * s + 1] !== t) { st[2 * s] = v; st[2 * s + 1] = t; mark(b, s); }
      }
    }
    S.fresh.length = 0;
  }

  // ------------------------------------------------------------------ pours, outline, connection lines
  // Every ring as a fan from its first vertex: (n - 2) triangles a ring, one index buffer a region.
  function fanOf(gl, rings) {
    let verts = 0, tris = 0;
    for (const r of rings) { const n = r.length >> 1; verts += n; if (n >= 3) tris += n - 2; }
    const v = new Float32Array((verts + 4) * 2), ix = new Uint32Array(tris * 3);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    let base = 0, k = 0;
    for (const r of rings) {
      const n = r.length >> 1; v.set(r, base * 2);
      for (let j = 1; j + 1 < n; j++) { ix[k++] = base; ix[k++] = base + j; ix[k++] = base + j + 1; }
      for (let j = base * 2; j < (base + n) * 2; j += 2) {
        const x = v[j], y = v[j + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
      base += n;
    }
    // Strictly enclose the indexed vertices, including at Float32 rounding and raster sample boundaries.
    const margin = Math.max(.25, Math.abs(left) * 1e-6, Math.abs(top) * 1e-6, Math.abs(right) * 1e-6, Math.abs(bottom) * 1e-6);
    v.set([left-margin, top-margin, right+margin, top-margin, left-margin, bottom+margin, right+margin, bottom+margin], verts * 2);
    const vao = gl.createVertexArray(), vb = gl.createBuffer(), ib = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ix, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {vao, vb, ib, count: k, cover: verts, bytes: v.byteLength + ix.byteLength};
  }
  const freeFan = (gl, f) => { if (f) { gl.deleteVertexArray(f.vao); gl.deleteBuffer(f.vb); gl.deleteBuffer(f.ib); } };
  function freePourFan(st, fan) {
    if (!fan) return;
    freeFan(st.gl, fan);
    st.stats.pourBytes -= fan.bytes;
  }
  function takePourAlternate(st, region) {
    const alternate = st.pourAlternates.get(region);
    if (!alternate) return null;
    st.pourAlternates.delete(region);
    st.stats.pourCacheBytes -= alternate.fan.bytes;
    return alternate;
  }
  function trimPourAlternates(st, limit) {
    while (st.stats.pourCacheBytes > limit) {
      const oldest = st.pourAlternates.keys().next().value;
      freePourFan(st, takePourAlternate(st, oldest).fan);
    }
  }
  function cachePourAlternate(st, region, entry) {
    freePourFan(st, takePourAlternate(st, region)?.fan);
    if (!entry.fan) return;
    if (entry.fan.bytes > POUR_ALTERNATE_BYTES) {
      freePourFan(st, entry.fan);
      return;
    }
    st.pourAlternates.set(region, {level:entry.level, fan:entry.fan});
    st.stats.pourCacheBytes += entry.fan.bytes;
    trimPourAlternates(st, POUR_ALTERNATE_BYTES);
  }
  function dropPour(st, region, entry) {
    freePourFan(st, entry.fan);
    freePourFan(st, takePourAlternate(st, region)?.fan);
    st.pours.delete(region);
  }
  // A live pour patch's rings: the tiles it shows and their neighbours (polygon-pour.js patchRegion).
  function patchRings(pt) {
    const g = pt.grid, near = new Set(), out = [];
    for (const t of pt.shown) { const c = t % g.cols, r = (t - c) / g.cols; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const cc = c + dc, rr = r + dr; if (cc >= 0 && rr >= 0 && cc < g.cols && rr < g.rows) near.add(rr * g.cols + cc); } }
    for (const t of near) for (const f of pt.tiles.get(t) || []) out.push(f);
    return out;
  }
  // k: device pixels per mm. A large region fills the 2D path's display LOD rings at this scale
  // (pcb-pours.js lodRingsAt; the stored rings until that level is built), so both renderers draw the
  // same edges. Keep the previous level for a reversal around the threshold.
  function pourFan(st, region, k) {
    const entry = st.pours.get(region);
    const lod = region.patch ? null : G.AtriumPCBPours.lodRingsAt?.(region, k) || null, L = lod ? lod.level : -1;
    const same = entry && entry.data === region.data && entry.count === region.count && entry.patch === region.patch;
    if (same && entry.level === L) return entry.fan;
    if (entry) {
      if (same && !region.patch && !fault("pourLodReuse")) {
        const alternate = st.pourAlternates.get(region);
        if (alternate?.level === L) {
          takePourAlternate(st, region);
          cachePourAlternate(st, region, entry);
          st.pours.set(region, {...entry, ...alternate});
          st.stats.pourCacheHits++;
          return alternate.fan;
        }
        cachePourAlternate(st, region, entry);
      } else dropPour(st, region, entry);
    }
    const t = now();
    let rings; try { rings = region.patch ? patchRings(region.patch) : lod ? lod.rings : G.AtriumPCBPours.contours(region); } catch { rings = null; }
    const f = rings?.length ? fanOf(st.gl, rings) : null;
    st.pours.set(region, {fan: f, level: L, data: region.data, count: region.count, patch: region.patch});
    if (f) {
      st.stats.pourBytes += f.bytes; st.stats.pourMs += now() - t;
      st.stats.pourUploads++; st.stats.pourUploadBytes += f.bytes; st.checkMemory = true;
    }
    return f;
  }
  // Regions no longer on the board (a repour replaced them) give their buffers back.
  function sweepPours(st, list, revision) {
    if (st.pourList === list && st.pourRevision === revision) return;
    st.pourList = list; st.pourRevision = revision;
    const keep = new Set(list || []);
    for (const [r, entry] of st.pours) if (!keep.has(r)) dropPour(st, r, entry);
  }
  const holeEdges = new WeakMap();
  function smallHoleEdges(region, scale) {
    if (!(region.count > 1 && region.data)) return false;
    let e = holeEdges.get(region);
    if (!e || e.data !== region.data || e.count !== region.count) {
      const rings = G.AtriumPCBPours.contours(region);
      let shortest = Infinity;
      for (let n = 1; n < Math.min(rings.length, 9); n++) {
        const xy = rings[n], step = 2 * Math.max(1, Math.floor(xy.length / 32));
        for (let j = 0; j < xy.length; j += step) {
          const k = (j + 2) % xy.length, d = Math.hypot(xy[j] - xy[k], xy[j+1] - xy[k+1]);
          if (d > 1e-6) shortest = Math.min(shortest, d);
        }
      }
      holeEdges.set(region, e = {data: region.data, count: region.count, shortest});
    }
    return e.shortest * scale < 1;
  }
  function freeCoverage(st) {
    if (!st.coverage) return;
    for (const band of st.coverage.layers.values()) if (band.tex) st.gl.deleteTexture(band.tex);
    st.coverage = null;
  }
  function texture(gl, w, h, alpha=false) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    if (alpha) gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, w, h, 0, gl.ALPHA, gl.UNSIGNED_BYTE, null);
    else gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  function bandTexture(st, band, w, h) {
    if (!band.tex) { band.tex = texture(st.gl,w,h); st.checkMemory = true; }
    return band.tex;
  }
  // In WKWebView a small damaged area uploaded directly from the canvas measured about as slow
  // as a full layer. Read only the changed rectangle there. WebKitGTK also benefits from cropping,
  // and uploads a full single-channel mask faster directly from the canvas. Chromium uses its
  // canvas-source upload path throughout.
  const ua = G.navigator?.userAgent || "";
  const READBACK = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\//.test(ua);
  const gtkMask = READBACK && /^Linux\b/.test(G.navigator?.platform || "") && !/Android/.test(ua);
  function uploadCanvas(gl, tex, canvas, sx, sy, sw, sh, format=gl.RGBA, timing) {
    const w = canvas.width, h = canvas.height, bottom = h-sy-sh, partial = sw !== w || sh !== h;
    gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const directMask = gtkMask && !partial && format === gl.ALPHA;
    const g = READBACK && !directMask ? canvas.getContext?.("2d") : null;
    if (g) {
      if (format === gl.ALPHA) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const readbackStart = timing ? now() : 0;
      const source = g.getImageData(sx, sy, sw, sh);
      if (timing) timing.readback += now() - readbackStart;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, bottom, sw, sh, format, gl.UNSIGNED_BYTE, source);
      if (format === gl.ALPHA) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      return;
    }
    if (partial) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, w); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, sx); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, bottom);
    }
    if (format === gl.ALPHA) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, bottom, sw, sh, format, gl.UNSIGNED_BYTE, canvas);
    if (format === gl.ALPHA) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (partial) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  // Collect the device-pixel bounds of the paths the PCB text painter actually draws.
  // Null means a fresh/empty texture, undefined means the previous contents are unknown.
  function bandRectangle() {
    let box = null;
    const include = (ctx, x0, y0, x1, y1) => {
      if (box === undefined) return;
      if (!ctx?.getTransform) { box = undefined; return; }
      const {a,b,c,d,e,f} = ctx.getTransform();
      const x = a * x0 + c * y0 + e, y = b * x0 + d * y0 + f;
      const xu = a * (x1 - x0), xv = c * (y1 - y0);
      const yu = b * (x1 - x0), yv = d * (y1 - y0);
      const next = [x + Math.min(0,xu) + Math.min(0,xv), y + Math.min(0,yu) + Math.min(0,yv),
        x + Math.max(0,xu) + Math.max(0,xv), y + Math.max(0,yu) + Math.max(0,yv)];
      box = next.every(Number.isFinite) ? mergeBounds(box, next) : undefined;
    };
    function rect(w,h) {
      if (!box) return box;
      const r = [Math.max(0,Math.floor(box[0])-2), Math.max(0,Math.floor(box[1])-2),
        Math.min(w,Math.ceil(box[2])+2), Math.min(h,Math.ceil(box[3])+2)];
      return r[0] < r[2] && r[1] < r[3] ? r : null;
    }
    // The caption painter supplies the real font, alignment, baseline and transform from fillText.
    const glyph = (ctx, text, x, y) => {
      if (box === undefined) return;
      const m = ctx.measureText?.(text);
      if (!(m && m.actualBoundingBoxLeft + m.actualBoundingBoxRight > 0 && m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0)) {
        box = undefined; return;
      }
      include(ctx, x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent, x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent);
    };
    return {include, rect, glyph};
  }
  function damagePixels(I, box, dpr, margin, w, h) {
    const p = I.worldToScreen([box[0],box[1]]), q = I.worldToScreen([box[2],box[3]]);
    const x = Math.max(0, Math.floor(Math.min(p[0],q[0])*dpr - margin));
    const y = Math.max(0, Math.floor(Math.min(p[1],q[1])*dpr - margin));
    return [x, y, Math.min(w, Math.ceil(Math.max(p[0],q[0])*dpr + margin))-x,
      Math.min(h, Math.ceil(Math.max(p[1],q[1])*dpr + margin))-y];
  }
  function coverageDamage(before, after) {
    let box = null;
    for (let n=0; n<Math.max(before.length,after.length); n++) {
      const a = before[n], b = after[n];
      if (a === b || a && b && a.data === b.data && a.count === b.count && a.net === b.net &&
          (a.bounds === b.bounds || a.bounds && b.bounds && a.bounds.every((v,i) => v === b.bounds[i]))) continue;
      // Unknown extents require a full repaint. Null means there was no damage.
      if ((a && !a.bounds) || (b && !b.bounds)) return undefined;
      box = mergeBounds(box, mergeBounds(a?.bounds, b?.bounds));
    }
    return box;
  }
  const coverageRegions = new WeakMap();
  function coverageRegion(r) {
    const prior = coverageRegions.get(r);
    const sameGeometry = prior && prior.data === r.data && prior.count === r.count;
    if (sameGeometry && prior.net === r.net) return prior;
    let bounds = sameGeometry ? prior.bounds : null;
    if (!sameGeometry) {
      // Stored bounds describe the outer ring. An imported even-odd path
      // can have other contours outside it. Bound the actual fill once.
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      try {
        for (const xy of G.AtriumPCBPours.contours(r)) for (let i = 0; i < xy.length; i += 2) {
          b[0] = Math.min(b[0], xy[i]); b[1] = Math.min(b[1], xy[i+1]);
          b[2] = Math.max(b[2], xy[i]); b[3] = Math.max(b[3], xy[i+1]);
        }
      } catch { b.fill(NaN); }
      if (b.every(Number.isFinite)) bounds = b;
    }
    // Bands keep these records for comparisons across edits, including in-place changes.
    const entry = {data: r.data, count: r.count, net: r.net, bounds};
    coverageRegions.set(r, entry);
    return entry;
  }
  function coveragePixels(I, group, dpr, w, h, firstOnly) {
    let pixels = null;
    for (const {bounds} of group) {
      if (!bounds) return [0, 0, w, h];
      // Clip each region before joining it. The padded artwork viewport can
      // admit disjoint pours whose combined bounds cross an empty viewport.
      const rect = damagePixels(I, bounds, dpr, 2, w, h);
      if (!(rect[2] > 0 && rect[3] > 0)) continue;
      rect[2] += rect[0]; rect[3] += rect[1];
      // A full-canvas upload only needs to know whether any copper reaches the view.
      if (firstOnly) return rect;
      if (!pixels) pixels = rect;
      else {
        pixels[0] = Math.min(pixels[0],rect[0]); pixels[1] = Math.min(pixels[1],rect[1]);
        pixels[2] = Math.max(pixels[2],rect[2]); pixels[3] = Math.max(pixels[3],rect[3]);
      }
      if (pixels[0] === 0 && pixels[1] === 0 && pixels[2] === w && pixels[3] === h) break;
    }
    return pixels;
  }
  // Keep the layer claimed by coverage without submitting a texture or stencil fans.
  const emptyCoverageBand = Object.freeze({tex:null});
  function trimOffscreenCoverage(I, st, doc, used, cap) {
    if (used <= cap) return used;
    const cover = st.coverage, regions = doc.pcbDrawing?.pours;
    if (!cover || !Array.isArray(regions)) return used;
    const {layers,w,h} = cover, dormant = new Set();
    for (const [layer, band] of layers) if (band.tex && band.offscreen) dormant.add(layer);
    if (!dormant.size) return used;
    const dpr = I.cam()[6];
    // The camera can have returned before coverage has reactivated a band.
    for (const region of regions) {
      const layer = region?.layer;
      if (dormant.has(layer) && (!region.bounds || coveragePixels(I,[coverageRegion(region)],dpr,w,h,true))) {
        dormant.delete(layer);
        if (!dormant.size) return used;
      }
    }
    for (const layer of dormant) {
      const band = layers.get(layer);
      st.gl.deleteTexture(band.tex);
      layers.set(layer,emptyCoverageBand);
      used -= w*h*(band.ink ? 1 : 4);
      if (used <= cap) break;
    }
    return used;
  }
  function coverageFits(I, st, doc, bytes) {
    const cap = capBytes();
    return trimOffscreenCoverage(I,st,doc,bytesOf(st) + backingBytes(st) + bytes,cap) <= cap;
  }
  function pourLodKey(scale, dpr) {
    const lod = G.AtriumPCBPours.lod, k = scale*dpr;
    // The unrotated Canvas painter uses the transform determinant for device scale.
    return lod?.keyAt?.(Math.sqrt(k*k)) ?? lod?.version;
  }
  // Stencil coverage can quantize narrow clearance curves. Exact camera paints, including moving
  // fallbacks, use the same coverage as the 2D path for subpixel hole edges. Retained frames and
  // live tiles can use the fans; ordinary edits reuse these coverage textures.
  function pourCoverage(I, st, doc, defs, opts, cam, V, list, text, c, timing) {
    if (!list) {
      if (st.coverage && (st.coverage.doc !== doc || !doc.pcbDrawing?.pours?.length)) freeCoverage(st);
      return null;
    }
    if (list !== doc.pcbDrawing?.pours || opts.transientGeometry || G.AtriumPourAnim?.active?.(doc)) return null;
    const [,,scale,,,,dpr] = cam, gl = st.gl, w = st.canvas.width, h = st.canvas.height;
    const key = [appearanceVersion, ...cam, w, h, opts.highlight, opts.layer, opts.layerMode, ...(opts.hidden || []),
      ...(text?.exact || []), pourLodKey(scale,dpr)].join("|");
    let cover = st.coverage;
    if (cover?.list === list && cover.sig === c.pourSig && cover.key === key) return cover.layers;
    if (cover && (w !== cover.w || h !== cover.h)) { freeCoverage(st); cover = null; }
    if (!cover) cover = st.coverage = {layers: new Map(), w, h};
    const active = new Set(), candidates = new Map(), view = V.viewport;
    for (const r of list) {
      const b = r?.bounds;
      if (!b || text?.pours && text.exact.has(r.layer) || !PCB.visible(r.layer, r, opts) ||
          b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]) continue;
      let group = candidates.get(r.layer); if (!group) candidates.set(r.layer, group = []);
      group.push(r);
      if (!active.has(r.layer) && smallHoleEdges(r,scale*dpr)) active.add(r.layer);
    }
    for (const [layer, band] of cover.layers) if (!active.has(layer)) {
      if (band.tex) gl.deleteTexture(band.tex);
      cover.layers.delete(layer);
    }
    for (const layer of active) {
      const group = candidates.get(layer);
      const inkFor = r => PCB.ink(layer,r,opts,!!opts.highlight && opts.highlight === r.net);
      let ink = st.alphaTextures === false ? null : inkFor(group[0]);
      for (let n = 1; ink && n < group.length; n++) if (inkFor(group[n]) !== ink) ink = null;
      let band = cover.layers.get(layer);
      if (band?.tex && !!band.ink !== !!ink) { gl.deleteTexture(band.tex); cover.layers.delete(layer); band = null; }
      const needsTexture = !band?.tex;
      const next = group.map(coverageRegion);
      const sameView = !needsTexture && band.key === key, dirty = sameView ? coverageDamage(band.regions,next) : null;
      if (band?.ink) band.ink = ink;
      if (sameView && dirty === null) { band.offscreen = false; continue; }
      const pixels = coveragePixels(I,next,dpr,w,h,!READBACK);
      if (!pixels) {
        // Keep the last painted camera and geometry. Reversing this pan can
        // show the same texture without clearing, painting or uploading it.
        if (needsTexture) cover.layers.set(layer,emptyCoverageBand);
        else band.offscreen = true;
        continue;
      }
      if (needsTexture) {
        if (band) cover.layers.delete(layer);
        if (!coverageFits(I,st,doc,w*h*(ink?1:4))) continue;
        band = {tex: texture(gl,w,h,!!ink), ink};
        if (ink && st.alphaTextures == null) {
          const error = gl.getError();
          if (error === gl.OUT_OF_MEMORY) {
            gl.deleteTexture(band.tex);
            st.driverOutOfMemory = true;
            return null;
          }
          st.alphaTextures = error === gl.NO_ERROR;
          if (!st.alphaTextures) {
            gl.deleteTexture(band.tex);
            if (!coverageFits(I,st,doc,w*h*4)) continue;
            band = {tex:texture(gl,w,h),ink:null};
          }
        }
        cover.layers.set(layer,band); st.checkMemory = true;
      }
      band.offscreen = false; band.key = key; band.regions = next;
      let sx=0, sy=0, sw=w, sh=h, visibleRegions=group;
      if (dirty) {
        [sx,sy,sw,sh] = damagePixels(I,dirty,dpr,2,w,h);
        if (sw<=0 || sh<=0) continue;
        const pad = 3/(scale*dpr);
        visibleRegions = group.filter((r,i) => {
          const b = next[i].bounds;
          return !b || b[0]<=dirty[2]+pad && b[2]>=dirty[0]-pad && b[1]<=dirty[3]+pad && b[3]>=dirty[1]-pad;
        });
      }
      if (READBACK) {
        const both = mergeBounds(band.pixels, pixels);
        band.pixels = sameView ? both : pixels;
        if (!sameView) {
          // Clear the previous camera's ink in the retained texture as well.
          sx = both[0]; sy = both[1]; sw = both[2] - sx; sh = both[3] - sy;
        }
      }
      const paintStart = timing ? now() : 0, g = I.ctx;
      g.setTransform(1,0,0,1,0,0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      // The sliced settle path also snapshots this canvas between draws.
      if (READBACK && !st.textJob) g.clearRect(sx,sy,sw,sh); else g.clearRect(0,0,w,h);
      I.boardTransform();
      I.drawBoard(g, [], doc, defs, scale, V.o2, visibleRegions, view, null);
      const uploadStart = timing ? now() : 0;
      uploadCanvas(gl,band.tex,I.canvas,sx,sy,sw,sh,band.ink?gl.ALPHA:gl.RGBA,timing);
      if (timing) {
        timing.paint += uploadStart - paintStart;
        timing.upload += now() - uploadStart;
      }
      st.stats.coverageUpload += sw*sh*(band.ink?1:4);
    }
    cover.key = key; cover.list = list; cover.sig = c.pourSig; cover.doc = doc;
    return cover.layers;
  }
  function outline(st, doc, c) {
    const S = st.scene;
    if (S.outline && S.docSig === c.docSig) return S.outline;
    freeFan(st.gl, S.outline);
    const B = G.AtriumBoardShape, profile = doc.boardShape?.cutoutRegions && B?.screenProfile(doc);
    const holes = profile?.cutoutRegions ? B.profileContours(profile).slice(1).map(c => B.flattenContour(c)) : B?.holes(doc);
    const rings = [doc.outline, ...(holes || [])].filter(r => r?.length >= 3);
    S.outline = fanOf(st.gl, rings.map(r => Float64Array.from(r.flat())));
    S.docSig = c.docSig;
    const e = S.edge; clear(e);
    for (const r of rings) for (let k = 0; k < r.length; k++) { const p = r[k], q = r[(k + 1) % r.length]; push(e, [p[0], p[1], q[0], q[1], 0, 1.25, 0, 0], EDGE, 0); }
    if (e.glCap) e.glCap = 0;
    return S.outline;
  }
  function airwires(S, result, tint) {
    if (S.airRes === result && S.airTint === tint.key) return;
    S.airRes = result; S.airTint = tint.key; S.airGroups = null;
    const b = S.air; clear(b); b.glCap = 0;
    const wires = result?.airwires || [], colours = tint.byNet;
    const append = w => push(b, [w.from[0], w.from[1], w.to[0], w.to[1], 0, 1, 0, 1], EDGE, netOf(S, w.net));
    if (colours && !fault("wireTintOrder")) {
      const groups = new Map(), ranges = new Map();
      for (const w of wires) {
        const colour = colours.get(w.net);
        if (!colour) { append(w); continue; }
        if (!groups.has(colour)) groups.set(colour, []);
        groups.get(colour).push(w);
      }
      const plain = b.n;
      for (const [colour, group] of groups) {
        const first = b.n;
        for (const w of group) append(w);
        ranges.set(colour, {first, end: b.n});
      }
      S.airGroups = {plain, ranges};
    } else for (const w of wires) append(w);
    S.stKey = null;
  }
  function* airwireRanges(I, S, colours) {
    const {plain, ranges} = S.airGroups;
    if (plain) yield {first: 0, end: plain};
    if (ranges.size <= 1) { yield* ranges.values(); return; }
    // Canvas paints tint groups in the order their first wire enters the viewport. The
    // retained ranges can be submitted in that order without re-uploading when the camera moves.
    const [x0, y0, x1, y1] = I.artworkViewport(), seen = new Set();
    for (const {from: a, to: b, net} of S.airRes.airwires) {
      const c = colours.get(net);
      if (!c || seen.has(c)) continue;
      if (Math.min(a[0], b[0]) > x1 || Math.max(a[0], b[0]) < x0 || Math.min(a[1], b[1]) > y1 || Math.max(a[1], b[1]) < y0) continue;
      seen.add(c);
      yield ranges.get(c);
      if (seen.size === ranges.size) break;
    }
  }
  // Net colours (opts.netColors: net -> colour) as a palette texture; byNet maps a net to its palette index.
  function tints(st, opts) {
    const m = opts.netColors, T = st.tint;
    if (!m?.size) { T.key = ""; T.byNet = null; T.map = null; return T; }
    if (T.map === m && T.size === m.size) return T;
    const key = [...m].map(([n, c]) => n + "=" + c).join(";");
    T.map = m; T.size = m.size;
    if (key === T.key) return T;
    const gl = st.gl, colours = [], byNet = new Map(), at = new Map();
    for (const [n, c] of m) { let k = at.get(c); if (k == null) { if (colours.length >= 4095) continue; colours.push(c); k = colours.length; at.set(c, k); } byNet.set(n, k); }
    const px = new Uint8Array((colours.length + 1) * 4);
    colours.forEach((c, k) => { const v = rgb(c); px.set(fault("netColor") ? [v[2] * 255, v[0] * 255, v[1] * 255, 255] : [v[0] * 255, v[1] * 255, v[2] * 255, 255], (k + 1) * 4); });
    if (!T.tex) T.tex = gl.createTexture();
    if (px.byteLength > (T.bytes || 0)) st.checkMemory = true;
    T.bytes = px.byteLength;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, colours.length + 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    T.key = key; T.byNet = byNet;
    return T;
  }

  // ------------------------------------------------------------------ per view
  function pause(I) {
    cancelPreparation(I);
    const st = views.get(I);
    if (!st) return;
    cancelSettle(st); cancelDriverMemoryProbe(st); cancelWide(st);
  }
  function hide(I, st = views.get(I)) {
    if (!st) return;
    cancelSettle(st); cancelDriverMemoryProbe(st);
    if (!st.shown) return;
    st.canvas.style.display = "none";
    I.canvas.style.position = st.position;
    releaseOverlayCopy(st); releaseCanvas(st, "overlayWorld"); freeWide(st); releaseCanvas(st, "wideCanvas");
    st.exact = null;
    st.shown = false;
  }
  function destroy(I) {
    cancelPreparation(I);
    const st = views.get(I);
    if (!st) return;
    views.delete(I);
    hide(I, st);
    freeViewport(st);
    freeBoard(st);
    const gl = st.gl;
    for (const p of Object.values(st.prog || {})) gl.deleteProgram(p.p);
    if (st.empty) gl.deleteVertexArray(st.empty);
    st.canvas.remove();
    G.AtriumCanvas.resizeBacking(st.canvas,1,1);
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch {}
  }
  // Programs and per-context objects; again after a lost context is restored (everything is re-uploaded).
  function init(st) {
    const gl = st.gl, t = now();
    const [maxW, maxH] = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const maxSurface = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    st.maxW = Math.min(maxW,maxSurface); st.maxH = Math.min(maxH,maxSurface);
    st.prog = {};
    for (const [key, source] of Object.entries(SRC)) st.prog[key] = program(gl, source);
    st.empty = gl.createVertexArray(); st.grid = null;
    st.scene = null; st.parked = new Map(); st.pours = new Map(); st.pourAlternates = new Map(); st.pourList = null;
    st.union = null; st.rects = null; st.text = {key: null}; st.wide = null; st.coverage = null; st.alphaTextures = null;
    st.tint = {key: "", byNet: null, tex: null, map: null};
    st.ui = {ring: buffer("blob"), line: buffer("seg"), hFill: buffer("blob"), hOn: buffer("blob"), hLine: buffer("blob"), selOut: buffer("blob"), selIn: buffer("blob")};
    st.uiKey = null; st.backingValid = false; st.checkMemory = true; st.over = st.memoryRetry = null;
    st.driverOutOfMemory = false; st.driverMemoryPending = false; st.driverMemoryProbe = null; st.driverMemoryEpoch = 0; st.commandEpoch = 0;
    st.stats.setupMs = now() - t; st.stats.pourBytes = 0; st.stats.pourCacheBytes = 0;
  }
  // A WebGL2 canvas of its own under the view's 2D canvas, or null.
  function glCanvas(doc, powerPreference, strict) {
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvas.className = "atrium-gpu-board"; canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:absolute;pointer-events:none;display:none";
    const gl = canvas.getContext("webgl2", {alpha: false, antialias: true, stencil: true, depth: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
      powerPreference, failIfMajorPerformanceCaveat: strict});
    return gl ? {canvas, gl} : null;
  }
  // Context loss. A restored context comes back on a fresh canvas: after a GPU process restart
  // (memory pressure, a driver reset) Chrome never composites the canvas whose context was restored
  // again, so the view showed the overlays over an empty board. Every 2D surface the GPU process held
  // (the view's board copies, zoom layers, text bands) lost its pixels with it: canvas.js drops them
  // (I.surfacesLost) and the next frame is drawn in full.
  function listen(I, st) {
    const canvas = st.canvas;
    canvas.addEventListener("webglcontextlost", e => {
      if (views.get(I) !== st || st.canvas !== canvas) return;
      e.preventDefault(); st.lost = true; st.losses++; hide(I);
      if (st.losses > MAX_LOSSES) { st.off = "the WebGL context was lost " + st.losses + " times"; }
      I.surfacesLost?.(); G.AtriumCanvasFast?.invalidate(I);
      repaint(I);
    });
    canvas.addEventListener("webglcontextrestored", () => {
      if (views.get(I) !== st || st.canvas !== canvas || st.off) return;
      st.lost = false;
      st.restoring = true; // A new canvas, programs and buffers are made only when this view renders again.
      repaint(I);
    });
  }
  function replaceCanvas(I, st) {
    const old = st.canvas, made = glCanvas(old.ownerDocument, st.powerPreference, st.strict);
    if (!made) throw Error("no WebGL2 context");
    try { st.gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch {}
    old.replaceWith(made.canvas); G.AtriumCanvas.resizeBacking(old,1,1);
    st.canvas = made.canvas; st.gl = made.gl; st.shown = false; st.place = "";
    listen(I, st);
  }
  function state(I, choice) {
    let st = views.get(I);
    if (st) {
      if (st.lost || st.off) return null;
      if (st.restoring) {
        try { replaceCanvas(I, st); init(st); st.stats.restored++; }
        catch (e) { st.off = "restoring the WebGL context failed: " + (e?.message || e); return null; }
        st.restoring = false;
      }
      return st;
    }
    const doc = G.document, host = I.canvas?.parentNode;
    if (!doc || !host || typeof G.WebGL2RenderingContext !== "function") { failed = true; failReason = "WebGL2 is not available"; return null; }
    // Views whose canvas left the page (a closed split pane) give their context back first.
    for (const V of [...views.keys()]) if (!V.canvas?.isConnected) destroy(V);
    if (views.size >= MAX_VIEWS) return null;
    // Automatic asks for a hardware context; Renderer: GPU (or a forced session) takes whatever WebGL2 there is.
    const strict = force !== true && choice?.mode !== "gpu";
    const powerPreference = choice?.powerPreference || "low-power";
    const made = glCanvas(doc, powerPreference, strict);
    if (!made) { failed = true; failReason = "no hardware-accelerated WebGL2 context"; return null; }
    const {canvas, gl} = made;
    host.insertBefore(canvas, I.canvas);
    st = {gl, canvas, powerPreference, strict, position: I.canvas.style.position, shown: false, place: "", lost: false, losses: 0, off: "", lean: false, checkMemory: false,
      stats: {builds: 0, buildMs: 0, updates: 0, updateMs: 0, updated: 0, pourBytes: 0, pourMs: 0, pourUploads: 0, pourUploadBytes: 0,
        pourCacheBytes: 0, pourCacheHits: 0, gridBufferAllocations: 0, driverFenceSubmissions: 0,
        driverMemoryChecks: 0, driverMemoryCheckMs: 0, setupMs: 0, last: null, restored: 0,
        textSliceRows: 0, wideSliceRows: 0, textSliceWorkMs: 0, wideSliceWorkMs: 0,
        acc: {n: 0, update: 0, gl: 0, overlay: 0, board: 0, text: 0, textHits: 0, gesture: 0}}};
    listen(I, st);
    views.set(I, st);
    try { init(st); }
    catch (e) {
      failed = true; failReason = "the GPU renderer could not start: " + (e?.message || e);
      destroy(I); return null;
    }
    return st;
  }
  function place(I, st, width, height) {
    const c = I.canvas, g = st.canvas;
    if (g.width !== c.width || g.height !== c.height) {
      freeViewport(st);
      G.AtriumCanvas.resizeBacking(g,c.width,c.height);
      st.backingValid = false;
      st.checkMemory = true;
    }
    if (!st.backingValid) {
      if (st.gl.drawingBufferWidth !== c.width || st.gl.drawingBufferHeight !== c.height) return false;
      st.backingValid = true;
    }
    const key = c.width + "x" + c.height + "/" + width + "x" + height + "/" + c.offsetLeft + "," + c.offsetTop;
    if (st.place !== key) {
      st.place = key;
      g.style.left = c.offsetLeft + "px"; g.style.top = c.offsetTop + "px"; g.style.width = width + "px"; g.style.height = height + "px";
    }
    if (!st.shown) { g.style.display = "block"; I.canvas.style.position = "relative"; st.shown = true; }
    return true;
  }
  const capBytes = () => (G.__atriumGpuCapMB || CAP_MB) * 1048576;
  // The default backing alone takes at least RGBA. Driver copies, multisampling,
  // and stencil backing may take more than this application estimate.
  const backingBytes = st => st.canvas.width * st.canvas.height * 4;
  const bufferBytes = b => b.glCap * (b.stride + 2) * 4;
  function bytesOf(st) {
    let n = st.stats.pourBytes + (st.grid?.bytes || 0) + (st.rects?.bytes || 0) + (st.tint?.bytes || 0) +
      (st.union ? st.union.w * st.union.h * 4 : 0);
    const texts = [st.text, st.wide?.text, st.textJob?.T, st.wideText?.T];
    for (const [i, T] of texts.entries()) if (T?.bands?.length && texts.indexOf(T) === i) for (const band of T.bands) if (band.tex) n += T.w * T.h * 4;
    if (st.coverage) for (const band of st.coverage.layers.values()) if (band.tex) n += st.coverage.w * st.coverage.h * (band.ink ? 1 : 4);
    for (const b of Object.values(st.ui || {})) n += bufferBytes(b);
    for (const S of [st.scene, ...st.parked.values()]) if (S) {
      for (const b of bufs(S)) n += bufferBytes(b);
      n += S.outline?.bytes || 0;
    }
    return n;
  }
  function freeViewport(st) {
    cancelSettle(st); freeWide(st);
    for (const band of st.text?.bands || []) st.gl.deleteTexture(band.tex);
    st.text = {key: null};
    freeCoverage(st);
    if (st.union) { st.gl.deleteTexture(st.union.tex); st.gl.deleteFramebuffer(st.union.fb); st.union = null; }
    for (const key of ["overlayCopy", "overlayWorld", "wideCanvas", "sliceCopy", "stripWide", "stripTall", "stripLarge"]) releaseCanvas(st,key);
    st.emptyStrip = null;
    st.exact = st.overlayV = st.ovAt = null;
  }
  function freeBoard(st) {
    const gl = st.gl;
    freeScene(st, st.scene); st.scene = null;
    for (const S of st.parked?.values() || []) freeScene(st, S);
    st.parked?.clear();
    for (const [region, entry] of st.pours || []) dropPour(st, region, entry);
    if (st.pourAlternates) trimPourAlternates(st,0);
    st.pourList = null;
    freeFan(gl,st.rects); st.rects = null;
    for (const b of Object.values(st.ui || {})) free(gl,b);
    st.uiKey = null;
    if (st.grid) { gl.deleteVertexArray(st.grid.vao); gl.deleteBuffer(st.grid.buffer); st.grid = null; }
    if (st.tint?.tex) gl.deleteTexture(st.tint.tex);
    st.tint = {key: "", byNet: null, tex: null, map: null};
  }
  const memoryLimit = (n, cap) => "this board needs " + Math.ceil(n / 1048576) + " MB of GPU memory (limit " + Math.round(cap / 1048576) + " MB)";
  const sameMemoryView = (over, doc, cap, w, h) => over?.doc === doc && over.cap === cap && over.w === w && over.h === h;
  function rejectMemory(I, st, doc, reason, kind = "cap") {
    hide(I);
    st.driverOutOfMemory = false; st.driverMemoryPending = false;
    const cap = capBytes(), {width:w, height:h} = I.canvas, c = I.cache;
    const prior = sameMemoryView(st.memoryRetry, doc, cap, w, h) ? st.memoryRetry : null;
    const delay = Math.min(8000, (prior?.delay || 250) * 2);
    st.over = {doc, cap, w, h, kind, reason, rev:c?.rev, to:c?.rev, items:c?.all?.length || 0,
      shrink:0, delay, retryAt:now() + delay, triedShrink:prior?.triedShrink};
    st.memoryRetry = null;
    freeViewport(st);
    freeBoard(st);
    G.AtriumCanvas.resizeBacking(st.canvas,1,1);
    st.backingValid = false;
    return false;
  }
  function retryMemory(st, c, cap, w, h, time, transient) {
    const over = st.over;
    if (!over) return true;
    const same = sameMemoryView(over, c.doc, cap, w, h);
    if (same) {
      if (transient || over.kind === "viewport") return false;
      const shrank = over.items - c.all.length >= Math.max(1, over.items / 8) ||
        c.rev === over.to && over.shrink >= 32;
      // One prompt retry for a clear drop in geometry. Snapshot lengths are
      // a cheap hint, so other changes can still retry after a failed estimate.
      if (time < over.retryAt) {
        if (!shrank || over.triedShrink) return false;
        over.triedShrink = true;
      } else if (over.kind === "cap" && over.rev === c.rev && !shrank) return false;
    }
    // A later render supplies demand for this retry. Never queue work while blocked.
    st.memoryRetry = same ? over : null;
    st.over = null; st.checkMemory = true;
    return true;
  }
  // Retained alternates and parked scenes give way before a live board falls back to 2D.
  function memory(I, st, doc) {
    if (st.driverOutOfMemory) return rejectMemory(I, st, doc, "the GPU ran out of memory", "driver");
    if (!st.checkMemory) return true;
    const cap = capBytes(), backing = backingBytes(st);
    st.checkedCap = cap;
    let n = trimOffscreenCoverage(I,st,doc,bytesOf(st) + backing,cap);
    if (n > cap && st.stats.pourCacheBytes) {
      trimPourAlternates(st, Math.max(0, st.stats.pourCacheBytes - (n - cap)));
      n = bytesOf(st) + backing;
    }
    if (n > cap && st.wide) { freeWide(st); n = bytesOf(st) + backing; }
    if (n > cap && st.parked.size) {
      for (const S of st.parked.values()) freeScene(st, S);
      st.parked.clear(); st.lean = true; n = bytesOf(st) + backing;
    }
    st.checkMemory = false;
    if (n <= cap) { st.driverMemoryPending = true; st.driverMemoryEpoch++; return true; }
    return rejectMemory(I, st, doc, memoryLimit(n,cap));
  }
  function cancelDriverMemoryProbe(st) {
    const probe = st.driverMemoryProbe;
    if (!probe) return;
    st.driverMemoryProbe = null;
    probe.cancel?.();
    if (probe.fence) st.gl.deleteSync(probe.fence);
  }
  // A driver error query can wait for all queued WebGL commands. Keep one
  // in-flight fence, and seal newer work only after the renderer has gone quiet.
  function queueDriverMemoryProbe(I, st, doc) {
    if (!st.driverMemoryPending || !st.shown || st.lost || !visible()) return;
    const active = st.driverMemoryProbe;
    if (active?.doc === doc) { active.lastDraw = now(); return; }
    cancelDriverMemoryProbe(st);
    const gl = st.gl, idle = G.AtriumIdle;
    const probe = st.driverMemoryProbe = {doc, cancel:null, fence:null, lastDraw:now(), command:-1, memory:-1};
    const quietMs = 32; // Avoid the short idle slots between successive animation frames.
    function queue() {
      const id = idle ? idle.idle(poll, {timeout:100}) : setTimeout(poll,0);
      probe.cancel = idle ? () => idle.cancel(id) : () => clearTimeout(id);
    }
    function later(ms) {
      const id = setTimeout(queue, ms);
      probe.cancel = () => clearTimeout(id);
    }
    function nextFrame() {
      // Fence polling is observation, not a frame of editor work in WebKit's idle shim.
      const id = idle ? idle.sampleFrame(queue) : G.requestAnimationFrame(queue);
      probe.cancel = idle ? () => idle.cancelSample(id) : () => G.cancelAnimationFrame(id);
    }
    function unavailable() {
      if (gl.isContextLost()) { cancelDriverMemoryProbe(st); return; }
      rejectMemory(I, st, doc, "the GPU could not complete its memory check", "driver");
      repaint(I);
    }
    function poll(deadline) {
      probe.cancel = null;
      if (st.driverMemoryProbe !== probe) return;
      if (views.get(I) !== st || !st.shown || !visible() || st.lost ||
          I.cache?.doc !== doc || gl.isContextLost()) {
        cancelDriverMemoryProbe(st);
        return;
      }
      // A slice may still submit commands. If it is cancelled, close its memory accounting here.
      if (st.checkMemory && (st.textJob || st.wideText)) { later(quietMs); return; }
      if (st.checkMemory && !memory(I, st, doc)) { repaint(I); return; }
      if (probe.fence) {
        const status = gl.clientWaitSync(probe.fence,0,0);
        const current = probe.command === st.commandEpoch && probe.memory === st.driverMemoryEpoch;
        if (status === gl.TIMEOUT_EXPIRED) { if (current) nextFrame(); else later(quietMs); return; }
        if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) { unavailable(); return; }
        if (current) { checkErrors(); return; }
        gl.deleteSync(probe.fence); probe.fence = null;
      }
      const wait = quietMs - (now() - probe.lastDraw);
      if (wait > 0 || deadline?.didTimeout) { later(deadline?.didTimeout ? quietMs : wait); return; }
      probe.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
      if (!probe.fence) { unavailable(); return; }
      probe.command = st.commandEpoch; probe.memory = st.driverMemoryEpoch;
      gl.flush(); st.stats.driverFenceSubmissions++;
      nextFrame();
    }
    function checkErrors() {
      const start = now();
      let oom = false;
      try {
        // WebGL keeps one flag per error kind. Drain the finite set so an
        // earlier benign error cannot conceal a later allocation failure.
        for (let i = 0; i < 8; i++) {
          const error = gl.getError();
          if (error === gl.OUT_OF_MEMORY) { oom = true; break; }
          if (error === gl.NO_ERROR || error === gl.CONTEXT_LOST_WEBGL) break;
        }
      } catch {}
      st.stats.driverMemoryChecks++;
      st.stats.driverMemoryCheckMs += now() - start;
      st.driverMemoryPending = false;
      cancelDriverMemoryProbe(st);
      if (oom) { rejectMemory(I, st, doc, "the GPU ran out of memory", "driver"); repaint(I); }
      else st.memoryRetry = null;
    }
    queue();
  }

  // ------------------------------------------------------------------ drawing
  // Tied layers use the reference painter's insertion order when available.
  // The retained buckets and layer controls determine the common geometry and band order.
  // S.layers only adds buckets during a scene's lifetime, so size tracks its membership.
  function layerPlan(st, opts, flipped) {
    const S = st.scene, active = opts.layer || "Top", mode = opts.layerMode, hidden = opts.hidden;
    const old = S.layerPlan;
    if (old && old.size === S.layers.size && old.active === active && old.mode === mode && old.flipped === flipped &&
        old.hidden.length === (hidden?.size || 0) && old.hidden.every(layer => hidden.has(layer))) return old;
    const ranks = new Map(), seen = new Map(), buckets = new Map(), rankOptions = {layer: active, layerMode: mode};
    const rank = layer => {
      if (!ranks.has(layer)) ranks.set(layer, layerRank(layer, rankOptions, flipped));
      return ranks.get(layer);
    };
    let tied = false;
    for (const [key, l] of S.layers) {
      const r = rank(l.layer);
      if (seen.has(r) && seen.get(r) !== l.layer) tied = true;
      seen.set(r, l.layer);
      if (PCB.visible(l.layer, l.rep, opts)) buckets.set(key, l);
    }
    return S.layerPlan = {size: S.layers.size, active, mode, flipped, hidden: [...(hidden || [])], rank, tied, buckets};
  }
  const passOrder = (plan, order, layer) => order?.get(layer) ?? plan.rank(layer);
  function orderedPasses(st, plan, order) {
    if (!plan.passes || plan.order !== order) {
      plan.order = order;
      plan.passes = [...plan.buckets].map(([key, l]) => ({key, layer: l.layer, l, order: passOrder(plan, order, l.layer)}))
        .sort((a, b) => a.order - b.order);
      plan.bandOrders = null;
      plan.pourPasses = null;
      st.stats.layerPassBuilds = (st.stats.layerPassBuilds || 0) + 1;
    }
    return plan.passes;
  }
  function drawPasses(st, plan, order, pours) {
    const base = orderedPasses(st, plan, order), extra = [];
    for (const layer of pours.keys()) if (!plan.buckets.has(layer)) extra.push(layer);
    if (!extra.length) return base;
    if (plan.pourPasses && extra.length === plan.extra.length && extra.every((layer, i) => layer === plan.extra[i]))
      return plan.pourPasses;
    // Geometry wins insertion-order ties with a pour-only layer. Distinct via
    // spans are separate buckets, even when they share the physical Multi rank.
    const added = extra.map(layer => ({key: layer, layer, l: null, order: passOrder(plan, order, layer)}));
    plan.extra = extra;
    plan.pourPasses = [...base, ...added].sort((a, b) => a.order - b.order);
    st.stats.layerPourPassBuilds = (st.stats.layerPourPassBuilds || 0) + 1;
    return plan.pourPasses;
  }
  function bandOrders(st, plan, order, doc, opts, pourSig, liveLayers, liveSignature) {
    const passes = orderedPasses(st, plan, order);
    if (!plan.bandOrders || plan.pourSig !== pourSig || plan.liveSignature !== liveSignature) {
      // Stored pour layers reserve band boundaries even when the current camera
      // clips them. A visible preview can add another physical layer before commit.
      const ranks = new Set(passes.map(pass => pass.order));
      for (const r of doc.pcbDrawing?.pours || []) if (r?.layer && PCB.visible(r.layer, null, opts))
        ranks.add(passOrder(plan, order, r.layer));
      if (liveLayers) for (const layer of liveLayers) ranks.add(passOrder(plan, order, layer));
      plan.bandOrders = [...ranks].sort((a, b) => a - b);
      plan.pourSig = pourSig;
      plan.liveSignature = liveSignature;
      st.stats.layerBandBuilds = (st.stats.layerBandBuilds || 0) + 1;
    }
    return plan.bandOrders;
  }
  // The layers drawBoard paints text-layer objects on: their own layer for labels, keepouts and dimensions; for parts,
  // the footprint layers with text, the overlay (designator) and the source labels' layers.
  function textLayers(doc, defs, items) {
    const out = new Set();
    for (const i of items) {
      if (i.kind !== "part") { out.add(boardLayer(i)); continue; }
      const def = PCB.readDefinition(defs,i.def,doc);
      if (!def?.footprint) continue;
      for (const g of PCB.footprintLayers(i, def.footprint)) if (g.shapes.some(x => x.kind === "text")) out.add(g.layer);
      for (const layer of PCB.partTextLayers(doc,i,def)) out.add(layer);
    }
    return out;
  }
  function draw(I, st, doc, defs, opts, cam, c, text, list, coverage, settledWires) {
    const [cx, cy, scale, flipped, width, height, dpr] = cam, gl = st.gl, S = st.scene, P = st.prog, sys = PCB.system;
    const kinds = PCB.opacity, layerAlpha = PCB.layerAlpha || (() => 1);
    const W = st.canvas.width, H = st.canvas.height, k = scale * dpr;
    const dx = (width / 2 + 8) / scale, dy = (height / 2 + 8) / scale;
    const x0 = cx - dx, x1 = cx + dx, y0 = cy - dy, y1 = cy + dy, B = c.bounds;
    const zoomed = B && (x0 > B[0] || y0 > B[1] || x1 < B[2] || y1 < B[3]);
    let skipped = 0, submitted = 0;
    const geometry = (b, start = 0, end = b.n) => {
      gl.bindVertexArray(b.vao);
      if (!zoomed || !b.geometry || b.n < PAGE * 3) { drawSlots(gl, b, start, end - start); submitted += end - start; return; }
      const pages = b.pages || (b.pages = []);
      let first = -1;
      for (let s = Math.floor(start / PAGE) * PAGE; s < end; s += PAGE) {
        const from = Math.max(start, s);
        const j = s / PAGE, q = pages[j] || (pages[j] = pageBounds(b, s, c.boxes));
        if (q[2] >= x0 && q[3] >= y0 && q[0] <= x1 && q[1] <= y1) { if (first < 0) first = from; }
        else {
          skipped += Math.min(s + PAGE, end) - from;
          if (first >= 0) { drawSlots(gl, b, first, from - first); submitted += from - first; first = -1; }
        }
      }
      if (first >= 0) { drawSlots(gl, b, first, end - first); submitted += end - first; }
    };
    let bytes = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const ws = rgb(sys.workspace);
    gl.clearColor(ws[0], ws[1], ws[2], 1); gl.clearStencil(0); gl.stencilMask(0xff); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    // CSS grid tracks can be fractional even at DPR 1. The 2D transform centres the drawing in their
    // actual CSS extent, whereas a WebGL viewport has an integer number of physical pixels.
    const cameraX = cx + (W - width * dpr) / (2 * k) * (flipped ? -1 : 1);
    const cameraY = cy + (H - height * dpr) / (2 * k);
    let cur = null, ox = 0;
    const v3 = (loc, c) => { const v = rgb(c); gl.uniform3f(loc, v[0], v[1], v[2]); };
    const use = p => {
      if (cur === p) return p.u;
      cur = p; gl.useProgram(p.p);
      const u = p.u;
      // A linked program keeps its uniforms when another program takes a layer pass.
      if (u.u_cam && (p.frame !== st.commandEpoch || p.offset !== ox)) {
        gl.uniform4f(u.u_cam, cameraX + ox, cameraY, k, flipped ? -1 : 1);
        p.offset = ox;
      }
      if (p.frame !== st.commandEpoch) {
        if (p.width !== W || p.height !== H) {
          if (u.u_res) gl.uniform2f(u.u_res, W, H);
          if (u.u_size) gl.uniform2f(u.u_size, W, H);
          p.width = W; p.height = H;
        }
        if (p.frame < 0) {
          if (u.u_tints) gl.uniform1i(u.u_tints, 1);
          if (u.u_tex) gl.uniform1i(u.u_tex, 0);
        }
        if (u.u_scale) gl.uniform1f(u.u_scale, scale);
        if (u.u_sel) v3(u.u_sel, sys.selection);
        if (u.u_kinds) gl.uniform4f(u.u_kinds, 1, kinds.track, kinds.via, kinds.pad);
        if (u.u_board) v3(u.u_board, sys.board);
        if (u.u_hole) {
          const holes = fault("holes");
          v3(u.u_hole, holes ? sys.padHole : sys.hole);
          v3(u.u_padHole, holes ? sys.hole : sys.padHole);
          v3(u.u_drillEdge, sys.drillEdge);
        }
        p.frame = st.commandEpoch;
      }
      return u;
    };
    let sp = (doc.grid || 0) * scale; const showGrid = opts.grid !== false && sp > 0 && Number.isFinite(sp); if (showGrid) while (sp < 12) sp *= 2;
    const grid = (fine, coarse, bg) => {
      const u = use(P.grid), origin = I.worldToScreen([0, 0]);
      const fade = Math.min(1, (sp - 12) / 12), key = [...origin, width, height, dpr, sp].join(",");
      const Gd = st.grid ||= {vao:gl.createVertexArray(), buffer:gl.createBuffer(), key:null, count:0, bytes:0};
      gl.bindVertexArray(Gd.vao);
      if (Gd.key !== key) {
        const lines = [], each = G.AtriumCanvas.eachGridLine;
        for (const pass of fade < .5 ? [0,1,2,3] : [0,2,1,3]) {
          if (pass < 2 && fade <= 0) continue;
          each(origin[0], width, sp, dpr, pass, x => lines.push(x, 1, pass));
          each(origin[1], height, sp, dpr, pass, y => lines.push(y, 0, pass));
        }
        const data = new Float32Array(lines);
        gl.bindBuffer(gl.ARRAY_BUFFER, Gd.buffer);
        if (!Gd.bytes || data.byteLength > Gd.bytes) {
          // At the minimum grid pitch, a viewport owns at most this many lines.
          // Zoom changes their positions and count without resizing the GPU buffer.
          Gd.bytes = Math.max(data.byteLength, (Math.ceil(width / 12) + Math.ceil(height / 12) + 2) * 12);
          gl.bufferData(gl.ARRAY_BUFFER, Gd.bytes, gl.DYNAMIC_DRAW);
          st.stats.gridBufferAllocations++;
          gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0); gl.vertexAttribDivisor(0, 1);
          st.checkMemory = true;
        }
        if (data.length) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
        Gd.key = key; Gd.count = data.length / 3; bytes += data.byteLength;
      }
      v3(u.u_fine, fine); v3(u.u_coarse, coarse); v3(u.u_fineOdd, G.AtriumCanvas.tint(fine, bg, fade)); v3(u.u_coarseOdd, G.AtriumCanvas.tint(coarse, bg, fade));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Gd.count);
    };
    // Stencil-then-cover even-odd fill of a fan set (bit 1); keep leaves the bit set (the board clip). clip:
    // 1 only inside the live-pour clip rectangles (stencil bit 2), -1 only outside them.
    let fanStencil = false, fanColor, fanAlpha;
    const beginFans = () => {
      if (fanStencil) return;
      fanStencil = true;
      gl.enable(gl.STENCIL_TEST); gl.stencilMask(1);
    };
    const finishFans = () => {
      if (!fanStencil) return;
      fanStencil = false;
      gl.disable(gl.STENCIL_TEST); gl.stencilMask(0xff);
    };
    const fanFill = (f, color, alpha, keep = false, clip = 0) => {
      if (!f.count) return;
      const u = use(P.fan);
      gl.bindVertexArray(f.vao);
      beginFans();
      gl.colorMask(false, false, false, false);
      gl.stencilFunc(clip ? gl.EQUAL : gl.ALWAYS, clip > 0 ? 2 : 0, clip ? 2 : 1); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.drawElements(gl.TRIANGLES, f.count, gl.UNSIGNED_INT, 0);
      gl.colorMask(true, true, true, true); gl.stencilFunc(gl.EQUAL, 1, 1); gl.stencilOp(gl.KEEP, gl.KEEP, keep ? gl.KEEP : gl.ZERO);
      if (color !== fanColor || alpha !== fanAlpha) {
        gl.uniform4f(u.u_rgba, color[0] * alpha, color[1] * alpha, color[2] * alpha, alpha);
        fanColor = color; fanAlpha = alpha;
      }
      // The parity pass already defines which samples can take color. A four-vertex cover
      // shades each accepted sample once and retains the existing stencil clear/keep rule.
      gl.drawArrays(gl.TRIANGLE_STRIP, f.cover, 4);
    };
    if (showGrid) grid(sys.workspaceGrid, sys.workspaceGridCoarse, sys.workspace);
    const substrate = doc.outline?.length >= 3 && !opts.hidden?.has("Board");
    if (substrate) {
      const f = outline(st, doc, c), b = rgb(sys.board);
      fanFill(f, b, 1, showGrid);
      if (showGrid) {
        beginFans(); gl.stencilFunc(gl.EQUAL, 1, 1); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        grid(sys.boardGrid, sys.boardGridCoarse, sys.board);
      }
      finishFans();
      if (showGrid) gl.clear(gl.STENCIL_BUFFER_BIT);
    }
    const tint = tints(st, opts), moving = settledWires === undefined;
    const showWires = opts.showUnrouted && !opts.transientGeometry;
    if (showWires) airwires(S, moving ? I.airwireConnectivity(doc, defs) : settledWires, tint);
    states(S, opts, tint);
    const segs = (b, color, alpha, o = {}) => {
      const first = o.first ?? 0, end = o.end ?? b.n;
      if (end <= first) return;
      bytes += upload(st, b);
      const u = use(P.seg);
      v3(u.u_color, color); gl.uniform1f(u.u_alpha, alpha);
      gl.uniform1f(u.u_onlyLit, o.onlyLit || 0); gl.uniform1f(u.u_minmul, o.minmul || 1); gl.uniform1f(u.u_tintmul, o.tintmul || 1);
      gl.uniform1f(u.u_tintOn, tint.byNet && o.tint ? 1 : 0);
      if (tint.byNet && o.tint) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tint.tex); gl.activeTexture(gl.TEXTURE0); }
      geometry(b, first, end);
    };
    const blobs = (b, color, alpha, l) => {
      if (!b.n) return;
      bytes += upload(st, b);
      const u = use(P.blob);
      v3(u.u_color, color); gl.uniform1f(u.u_alpha, alpha);
      const blind = l?.blind && (opts.layerMode !== "dim" || PCB.onLayer(l.layer, opts.layer || "Top", l.rep));
      gl.uniform1f(u.u_blind, blind && !fault("holes") ? 1 : 0);
      gl.uniform1f(u.u_viaOn, l ? 1 : 0); if (l) v3(u.u_via, PCB.viaInk(l.rep || {}, opts, false));
      if (blind) { v3(u.u_holeA, PCB.color(l.rep.fromLayer)); v3(u.u_holeB, PCB.color(l.rep.toLayer)); }
      geometry(b);
    };
    const tris = (b, color, alpha) => {
      if (!b.n) return;
      bytes += upload(st, b);
      const u = use(P.tri);
      v3(u.u_color, color); gl.uniform1f(u.u_alpha, alpha);
      geometry(b);
    };
    // Segments under an opacity below 1: their union (MAX blending into a texture) composited once, so a
    // track's joints are not blended twice (a Canvas stroke covers each pixel once).
    const unionSegs = (b, color, alpha, o) => {
      if (!b.n) return;
      let U = st.union;
      if (!U || U.w !== W || U.h !== H) {
        if (U) { gl.deleteTexture(U.tex); gl.deleteFramebuffer(U.fb); }
        const tex = gl.createTexture(), fb = gl.createFramebuffer();
        gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        st.union = U = {tex, fb, w: W, h: H}; st.checkMemory = true;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, U.fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
      segs(b, color, 1, o);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const u = use(P.copy);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, U.tex); gl.uniform1f(u.u_alpha, alpha); gl.uniform1f(u.u_straight, 0);
      gl.uniform4f(u.u_maskInk,0,0,0,0);
      gl.uniform3f(u.u_xf, 1, 0, 0); gl.uniform1f(u.u_wrap, 0);
      gl.bindVertexArray(st.empty); gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    if (substrate) segs(S.edge, sys.edge, 1);
    ui(I, st, opts, cam, doc, segs, blobs);
    // Poured copper, as canvas.js decides to show it.
    const corner = [(flipped ? width / 2 : -width / 2) / scale + cx, -height / 2 / scale + cy], far = [(flipped ? -width / 2 : width / 2) / scale + cx, height / 2 / scale + cy];
    const view = [Math.min(corner[0], far[0]), Math.min(corner[1], far[1]), Math.max(corner[0], far[0]), Math.max(corner[1], far[1])];
    const live = G.AtriumPolygonPour, pours = new Map();
    sweepPours(st, list || doc.pcbDrawing?.pours, c.rev);
    // Live pour tile patches (polygon-pour.js paintPatch): a patch region draws inside its clip rectangles, the
    // stored regions of the patched pour outside them.
    const patches = new Map();
    if (list) for (const r of list) { const pt = r?.patch; if (pt && pt.rects && live?.tiles?.patches?.get(pt.id) === pt) patches.set(pt.id, pt); }
    if (list) for (const r of list) {
      const b = r?.bounds;
      if (!b || b.length !== 4 || !PCB.visible(r.layer, r, opts) || b[0] > view[2] || b[1] > view[3] || b[2] < view[0] || b[3] < view[1]) continue;
      let l = pours.get(r.layer);
      if (!l) {
        if (!PCB.visible(r.layer, null, opts)) continue;
        pours.set(r.layer, l = []);
      }
      l.push(r);
    }
    const rects = pt => {
      const v = new Float32Array(pt.rects.length * 8), ix = new Uint32Array(pt.rects.length * 6);
      const sx = x => (Math.round(((flipped ? cx - x : x - cx) * scale + width / 2) * dpr) / dpr - width / 2) / scale * (flipped ? -1 : 1) + cx;
      const sy = y => (Math.round(((y - cy) * scale + height / 2) * dpr) / dpr - height / 2) / scale + cy;
      pt.rects.forEach((q, j) => { const x0 = sx(q[0]), x1 = sx(q[2]), y0 = sy(q[1]), y1 = sy(q[3]); v.set([x0, y0, x1, y0, x1, y1, x0, y1], j * 8); ix.set([j * 4, j * 4 + 1, j * 4 + 2, j * 4, j * 4 + 2, j * 4 + 3], j * 6); });
      let R = st.rects;
      if (!R) { R = st.rects = {vao: gl.createVertexArray(), vb: gl.createBuffer(), ib: gl.createBuffer(), count: 0}; gl.bindVertexArray(R.vao); gl.bindBuffer(gl.ARRAY_BUFFER, R.vb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.ib); gl.bindVertexArray(null); }
      gl.bindVertexArray(R.vao); gl.bindBuffer(gl.ARRAY_BUFFER, R.vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STREAM_DRAW); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ix, gl.STREAM_DRAW);
      const size = v.byteLength + ix.byteLength;
      if (size > (R.bytes || 0)) st.checkMemory = true;
      R.bytes = size; R.count = ix.length;
      return R;
    };
    const clipRects = (pt, on) => {
      finishFans();
      const R = rects(pt);
      use(P.fan);
      gl.enable(gl.STENCIL_TEST); gl.colorMask(false, false, false, false); gl.stencilMask(2);
      gl.stencilFunc(gl.ALWAYS, on ? 2 : 0, 2); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.bindVertexArray(R.vao); gl.drawElements(gl.TRIANGLES, R.count, gl.UNSIGNED_INT, 0);
      gl.colorMask(true, true, true, true); gl.disable(gl.STENCIL_TEST); gl.stencilMask(0xff);
    };
    const pourFill = (r, color, alpha) => {
      const f = pourFan(st, r, k);
      if (!f) return;
      const pt = fault("pourPatch") ? null : r.patch ? (patches.get(r.patch.id) === r.patch ? r.patch : null) : r.polygon != null ? patches.get(r.polygon) : null;
      if (!pt) { if (!r.patch) fanFill(f, color, alpha); return; }
      clipRects(pt, true);
      if (r.patch) fanFill(f, color, alpha * pt.alpha, false, 1);
      else {
        fanFill(f, color, alpha, false, -1);
        if (pt.alpha < 1) fanFill(f, color, alpha * (1 - pt.alpha), false, 1);
      }
      clipRects(pt, false);
    };
    // Layer passes in canvas.js's order (PCB.order, bottom layers above top ones on a flipped board).
    const active = opts.layer || "Top", lm = opts.layerMode;
    const plan = layerPlan(st, opts, flipped);
    let passes = drawPasses(st, plan, S.order, pours);
    if (fault("order")) {
      passes = passes.slice();
      const k2 = passes.findIndex(p => p.layer === "Bottom");
      if (k2 >= 0) passes.push(...passes.splice(k2, 1));
    }
    // The text layer goes under the first pass at through-hole order (Multi) or above.
    // In Board Planning the layer also holds the region tints, which canvas.js paints over every layer: it goes last.
    // Text bands (textLayer) go under the first pass at their band's order or above, the rest after the last pass.
    const bands = text?.bands || [];
    let bandAt = 0;
    const textUpTo = o => { while (bandAt < bands.length && bands[bandAt].next <= o) textPass(bands[bandAt++]); };
    const textPass = band => {
      if (!band.tex || band.offscreen) return;
      const u = use(P.copy);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, band.tex); gl.uniform1f(u.u_alpha, 1); gl.uniform1f(u.u_straight, 1);
      if (band.ink) { const v = rgb(band.ink); gl.uniform4f(u.u_maskInk,v[0],v[1],v[2],1); }
      else gl.uniform4f(u.u_maskInk,0,0,0,0);
      const xf = text?.xf || [1, 0, 0]; gl.uniform3f(u.u_xf, xf[0], xf[1], xf[2]); gl.uniform1f(u.u_wrap, text?.wrap ? 1 : 0);
      gl.bindVertexArray(st.empty); gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    // Draw each selected track's edit handles after its segments. Later artwork on the
    // same layer covers the handles, just as in drawItem on the 2D canvas.
    const handleAt = new Map();
    if (opts.selected != null || opts.selectedIds?.size) {
      const byId = S.byId || (S.byId = new Map(S.cache.all.map(i => [i.id, i])));
      for (const id of new Set([...(opts.selectedIds || []), ...(opts.selected != null ? [opts.selected] : [])])) {
        const i = byId.get(id);
        if (!i || twoD(i) || !i.points || i.kind === "graphic" || !PCB.visible(boardLayer(i), i, opts)) continue;
        const l = boardLayer(i); let a = handleAt.get(l); if (!a) handleAt.set(l, a = []); a.push(i);
      }
    }
    const handles = (list, base) => {
      if (!list) return;
      const U = st.ui, px = 1 / scale; clear(U.selOut); clear(U.selIn);
      for (const i of list) for (const p of i.points) {
        push(U.selOut, [p[0], p[1], 3.5 * px, 3.5 * px, 0, 1, 0, 1, 0, 0, 0, 0], EDGE, 0);
        push(U.selIn, [p[0], p[1], 2.5 * px, 2.5 * px, 0, 1, 0, 1, 0, 0, 0, 0], EDGE, 0);
      }
      blobs(U.selOut, sys.board, base); blobs(U.selIn, sys.selection, base);
    };
    passes.forEach(({key, layer, l, order}) => {
      const rs = pours.get(key);
      textUpTo(order);
      if (fault("offset")) { ox = layer === "Top" ? 1 / k : 0; cur = null; }
      const base = layerAlpha(layer), ink = PCB.ink(layer, l?.rep || null, opts, false);
      const bandPours = text?.pours && text.exact.has(layer);
      if (coverage?.has(layer)) textPass(coverage.get(layer));
      else if (!bandPours) for (const r of rs || []) {
        const v = rgb(PCB.ink(r.layer, r, opts, !!opts.highlight && opts.highlight === r.net));
        // A Repour All reveal (pour-anim.js): the region's alpha, and its sweep as scissor columns.
        const A = G.AtriumPourAnim?.gpu?.(r, cam, W);
        if (A === false) continue;
        if (A) { gl.enable(gl.SCISSOR_TEST); gl.scissor(A.x0, 0, A.x1 - A.x0, H); }
        pourFill(r, v, base * kinds.pour * (A ? A.alpha : 1));
        if (A) gl.disable(gl.SCISSOR_TEST);
      }
      finishFans();
      if (text?.exact?.has(layer)) return;
      const chosen = handleAt.get(layer);
      if (!l) { handles(chosen, base); return; }
      // Net colours only where the 2D view shows them: not on dimmed layers.
      const tintOn = !(lm === "dim" && !PCB.onLayer(layer, active, l.rep));
      tris(l.tri, ink, base);
      if (base * Math.min(1, kinds.track) < 1) {
        unionSegs(l.seg, ink, base, {tint: tintOn});
        handles(chosen, base);
      } else if (chosen) {
        const stops = chosen.map(item => {
          let end = l.seg.n;
          for (const [buffer, first, count] of S.recs.get(item.id) || []) if (buffer === l.seg) end = first + count;
          return {item, end};
        }).sort((a, b) => a.end - b.end);
        let first = 0;
        for (const stop of stops) {
          segs(l.seg, ink, base, {tint: tintOn, first, end: stop.end});
          handles([stop.item], base);
          first = stop.end;
        }
        segs(l.seg, ink, base, {tint: tintOn, first});
      } else segs(l.seg, ink, base, {tint: tintOn});
      blobs(l.blob, ink, base, l);
      if (opts.viaMarks !== false) blobs(l.viaMarks, ink, base);
      tris(l.ptri, ink, base);
      if (base < 1) unionSegs(l.pseg, ink, base, {}); else segs(l.pseg, ink, base);
      blobs(l.pblob, ink, base, l);
    });
    textUpTo(Infinity);
    if (showWires && moving) {
      const hl = !!opts.highlight;
      const wireOpts = {onlyLit: hl ? 1 : 0, minmul: hl ? 1.5 : 1, tintmul: hl ? 4 / 3 : 1.5, tint: true};
      if (S.airGroups) for (const range of airwireRanges(I, S, tint.byNet)) segs(S.air, sys.connection, 1, {...wireOpts, ...range});
      else segs(S.air, sys.connection, 1, wireOpts);
    } else if (showWires && S.air.n) {
      // Prepare the retained geometry before input starts. Only the overlay paints
      // the lines now, and the first moving frame can reuse these instances.
      bytes += upload(st, S.air);
    }
    gl.bindVertexArray(null);
    st.stats.frameUpload = bytes;
    st.stats.submitted = submitted; st.stats.culled = skipped;
  }
  // Screen-space marks drawn on the GPU between the board edge and the copper, as canvas.js paints them: the
  // origin marker (a 5 px circle and a cross) and the board-shape edit handles (squares on vertices, circles on
  // edge midpoints).
  function ui(I, st, opts, cam, doc, segs, blobs) {
    const U = st.ui, sys = PCB.system;
    const handles = opts.boardHandles, activeH = opts.boardHandleActive;
    // The marks are in world space for this camera: with the same camera and origin (a window
    // uncovered, a redraw with nothing changed) the uploaded instances draw again as they are.
    const key = handles?.length ? null : [...cam, opts.origin !== false, ...(doc.origin || [0, 0])].join(",");
    if (key === null || key !== st.uiKey) {
      st.uiKey = key;
      marks(I, U, opts, cam, doc, handles, activeH);
    }
    blobs(U.ring, sys.origin, 1); segs(U.line, sys.origin, 1);
    blobs(U.hFill, sys.workspace, 1); blobs(U.hOn, sys.selection, 1); blobs(U.hLine, sys.selection, 1);
  }
  function marks(I, U, opts, cam, doc, handles, activeH) {
    const [cx, cy, scale, flipped, width, height] = cam;
    const toWorld = (x, y) => [(flipped ? width / 2 - x : x - width / 2) / scale + cx, (y - height / 2) / scale + cy];
    const px = 1 / scale;
    for (const b of [U.ring, U.line, U.hFill, U.hOn, U.hLine]) clear(b);
    if (opts.origin !== false) {
      const [x, y] = I.worldToScreen(doc.origin || [0, 0]);
      if (!(x < -12 || y < -12 || x > width + 12 || y > height + 12)) {
        const X = Math.round(x), Y = Math.round(y), c = toWorld(X + .5, Y + .5);
        push(U.ring, [c[0], c[1], 5.5 * px, 5.5 * px, 0, 4, 5 * px, 0, 0, 0, 0, 0], EDGE, 0);
        const a = toWorld(X - 9, Y + .5), b = toWorld(X + 10, Y + .5), d = toWorld(X + .5, Y - 9), e = toWorld(X + .5, Y + 10);
        push(U.line, [a[0], a[1], b[0], b[1], 0, 1, 0, 0], EDGE, 0); push(U.line, [d[0], d[1], e[0], e[1], 0, 1, 0, 0], EDGE, 0);
      }
    }
    if (handles?.length) for (const h of handles) {
      const [x, y] = I.worldToScreen(h.at);
      if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue;
      const on = !!activeH && h.type === activeH.type && h.ref.contour === activeH.ref.contour && h.ref.index === activeH.ref.index;
      const X = Math.round(x), Y = Math.round(y);
      if (h.type === "vertex") {
        const c = toWorld(X, Y);
        push(on ? U.hOn : U.hFill, [c[0], c[1], 3.5 * px, 3.5 * px, 0, 1, 0, 0, 0, 0, 0, 0], EDGE, 0);
        push(U.hLine, [c[0], c[1], 4 * px, 4 * px, 0, 6, .5 * px, 0, 0, 0, 0, 0], EDGE, 0);
      } else {
        const c = toWorld(X + .5, Y + .5);
        push(on ? U.hOn : U.hFill, [c[0], c[1], 3 * px, 3 * px, 0, 0, 0, 0, 0, 0, 0, 0], EDGE, 0);
        push(U.hLine, [c[0], c[1], 3.5 * px, 3.5 * px, 0, 4, 3 * px, 0, 0, 0, 0, 0], EDGE, 0);
      }
    }
  }

  // What the 2D layers draw in this frame: the viewport, the objects canvas.js's drawBoard keeps (parts for their
  // text and selection boxes, labels, keepouts, dimensions) and, once pads are large enough for their numbers,
  // every object in view. A view of the whole board takes the scene's list instead of a query.
  function scope(I, st, doc, defs, opts, cam, list, retainQuery = true) {
    const [cx, cy, scale, flipped, width, height] = cam;
    const e = 7 / scale, x0 = (flipped ? width / 2 : -width / 2) / scale + cx, x1 = (flipped ? -width / 2 : width / 2) / scale + cx;
    const viewport = [Math.min(x0, x1) - e, -height / 2 / scale + cy - e, Math.max(x0, x1) + e, height / 2 / scale + cy + e];
    const S = st.scene, c = S.cache, B = c.bounds;
    const whole = B && viewport[0] <= B[0] && viewport[1] <= B[1] && viewport[2] >= B[2] && viewport[3] >= B[3];
    const padDetails = S.maxPad * scale > PCB.padCaptionMinPx && typeof I.padText === "function" && !fault("padText");
    let items, all = null;
    if (whole && !padDetails) {
      if (!S.two) S.two = c.all.filter(twoD);
      items = S.two;
    } else {
      // Stationary tool frames share the same ordered geometry. Apply current hidden ids below.
      const rev = c.rev, keep = retainQuery && rev != null && G.AtriumSpatial;
      const prior = keep && S.viewItems;
      if (prior && prior.rev === rev && viewport.every((edge, i) => edge === prior.viewport[i])) {
        ({all, items} = prior);
      } else {
        all = I.query(doc, defs, viewport);
        items = all.filter(twoD);
        if (keep) S.viewItems = {rev, viewport, all, items};
      }
    }
    const rawItems = G.AtriumSpatial ? all || c.all : doc.items, rev = c.rev;
    if (goneIds(opts)?.length) { const gone = new Set(goneIds(opts)); items = items.filter(i => !gone.has(i.id)); if (all) all = all.filter(i => !gone.has(i.id)); }
    // A layer painted above everything (the active layer in dim and single-layer modes, or an active
    // non-copper layer): its text goes on the top 2D layer, all other text in the text layer under it.
    const active = opts.layer || "Top", top = PCB.order(active, active, opts.layerMode) >= 200;
    const o2 = flipped ? {...opts, flipped: true} : opts;
    const plan = layerPlan(st, opts, flipped);
    const tied = I.paintOrder && plan.tied, stored = doc.pcbDrawing?.pours, preview = list && list !== stored;
    const key = tied ? [c.rev, ...cam, active, opts.layerMode, ...(opts.hidden || []), opts.highlight || "", opts.selected,
      ...(opts.selectedIds || []), ...(goneIds(opts) || [])].join("|") : null;
    const orderChanged = tied && (key !== S.orderKey || S.orderPours !== list);
    let pourLayers = null;
    if (list?.length && (orderChanged || preview)) {
      for (const r of list) {
        const b = r?.bounds;
        if (!Array.isArray(b) || b.length !== 4 || !PCB.visible(r.layer, r, opts) ||
            b[0] > viewport[2] || b[1] > viewport[3] || b[2] < viewport[0] || b[3] < viewport[1]) continue;
        (pourLayers ||= new Set()).add(r.layer);
      }
    }
    if (orderChanged) {
      // The reference painter visits visible pours before its board items.
      // Their layer sequence can change a tie even for an existing bucket.
      const contribution = pourLayers ? JSON.stringify([...pourLayers].sort((a, b) => plan.rank(a) - plan.rank(b))) : "";
      if (key !== S.orderKey || contribution !== S.orderPourSignature) {
        const exact = I.paintOrder(doc, defs, o2, all || c.all, viewport, list);
        const names = [...new Set([...exact, ...[...S.layers.values()].map(l => l.layer)])].sort((a, b) => plan.rank(a) - plan.rank(b));
        if (S.order?.size !== names.length || names.some((layer, i) => S.order.get(layer) !== i))
          S.order = new Map(names.map((l, i) => [l, i]));
        S.orderKey = key; S.orderPourSignature = contribution; S.orderSignature = names.join(",");
      }
      S.orderPours = list;
    } else if (!tied) {
      S.order = null; S.orderKey = null; S.orderPours = null; S.orderSignature = "";
    }
    let liveLayers = null;
    if (preview && pourLayers) {
      const storedLayers = new Set();
      for (const r of stored || []) storedLayers.add(r?.layer);
      for (const layer of pourLayers) if (layer && !plan.buckets.has(layer) && !storedLayers.has(layer) && PCB.visible(layer, null, opts))
        (liveLayers ||= new Set()).add(layer);
    }
    const liveSignature = liveLayers ? JSON.stringify([...liveLayers].sort()) : "";
    return {viewport, items, all, rawItems, rev, padDetails, top, active, o2, liveLayers, liveSignature};
  }
  function inkTouches(boxes, viewport, item, bounds) {
    const b = bounds || boxes.get(item);
    return !b || b[0] <= viewport[2] && b[1] <= viewport[3] && b[2] >= viewport[0] && b[3] >= viewport[1];
  }
  // The text layer: drawBoard of those objects into its own canvas, composited by the GPU in layer order (under
  // through-hole copper and a layer painted above everything; connection lines over it), as the 2D path orders
  // them. Redrawn and uploaded only when its key changes (camera, edits, view options, colours), so pointer
  // and tool frames reuse it as it is.
  // area: [x, y, w, h] device pixels: paint and upload only that part of T's bands (an idle slice of the
  // text for a new camera, textSlices), never answering from T's key.
  function textLayer(I, st, doc, defs, opts, cam, V, pours, T = st.text, area = null, timing) {
    const [cx, cy, scale, flipped, width, height, dpr] = cam, gl = st.gl, S = st.scene, W = st.canvas.width, H = st.canvas.height;
    let sig = "";
    for (const k in PCB.system) sig += PCB.system[k];
    for (const l of ["Silk", "Bottom silk", "Top", "Bottom", "Mechanical", "Keepout", ...S.layers.keys()]) sig += PCB.color(l);
    const planning = !!(G.AtriumStackup?.isPlanning?.() && G.AtriumRigidFlex);
    // Canvas composites one stroked or filled object at a time. Keep that order for translucent
    // layers and when net-coloured tracks can overlap a filled graphic on the same copper layer.
    const netColours = opts.netColors?.size && !fault("netColor");
    const exact = new Set();
    for (const l of S.layers.values()) if (PCB.visible(l.layer, l.rep, opts) &&
      (PCB.layerAlpha(l.layer) < 1 || PCB.opacity.track < 1 && l.seg.n ||
      netColours && PCB.index(l.layer) >= 0 && l.seg.n && l.tri.n ||
      (PCB.opacity.pad < 1 || PCB.opacity.via < 1) && (l.blob.n || l.pblob.n))) exact.add(l.layer);
    let details = null;
    if (V.padDetails && V.all) {
      const key = [S.rev, S.stackEpoch, ...cam, V.active, opts.layerMode, opts.netNames, ...(opts.hidden || []), ...(goneIds(opts) || [])].join("|");
      if (S.padDetailsKey !== key) {
        S.padDetailsKey = key; S.padDetails = padDetails(V.all, defs, scale, V.o2, doc);
        const occlusionStart = timing ? now() : 0;
        S.coveredDetails = coveredPadDetails(I, doc, defs, S.padDetails);
        if (timing) timing.occlusion += now() - occlusionStart;
      }
      details = S.padDetails;
      for (const layer of S.coveredDetails) exact.add(layer);
    }
    // Static pours under translucent tracks share their ordered layer's coverage. A tile patch or
    // animated reveal keeps its own GPU pass so it can move without refreshing these textures.
    const bandPours = exact.size && PCB.opacity.track > 0 && PCB.opacity.track < 1 && !opts.transientGeometry &&
      pours === doc.pcbDrawing?.pours && !G.AtriumPourAnim?.active?.(doc) ? pours : null;
    const selection = new Set(opts.selectedIds || []);
    if (opts.selected != null) selection.add(opts.selected);
    if (!V.padDetails && !exact.size) for (const id of selection) {
      const item = S.byId.get(id);
      if (!item || !twoD(item)) selection.delete(id);
    }
    // A band carrying copper must repaint when the idle-built display contours become available.
    const rest = [planning, opts.planning?.region, opts.planning?.line ? JSON.stringify(opts.planning.line) : "", V.padDetails, S.cache.docSig, flipped, W, H, width, height, dpr, V.active, V.top, opts.layerMode, opts.hidden?.size ? [...opts.hidden].join("\u0001") : "",
      opts.highlight || "", goneIds(opts)?.join(",") || "", sig, opts.netNames !== false, opts.viaMarks !== false,
      exact.size && opts.netColors?.size ? [...opts.netColors].join(",") : "", [...exact].join(","), S.orderSignature, V.liveSignature,
      !!G.AtriumDesignators, !!G.AtriumPCBText, PCB.opacity.track, PCB.opacity.pad, PCB.opacity.via,
      bandPours ? PCB.opacity.pour : "", bandPours ? pourLodKey(scale,dpr) : "",
      ...Object.entries(PCB.layerOpacity || {}), S.stackEpoch].join("|") + "|" + cx + "," + cy + "," + scale;
    const key = rest + "|" + S.textRev + "|" + (V.padDetails ? S.padRev : "") + "|" + (exact.size ? S.rev : "") + "|" + JSON.stringify([...selection]);
    if (T.scene !== S.id) { T.scene = S.id; T.key = null; }
    // Bands a pan moved (scrollText) hold the view around another camera: drawn afresh.
    const rolled = T.valid && (T.valid[0] || T.valid[1]);
    if (rolled) { T.key = null; T.valid = [0, 0]; }
    st.stats.textUpload = 0;
    if (!area && T.key === key && T.pours === bandPours) { T.rev = S.rev; st.stats.acc.textHits++; return T.empty ? null : T; }
    // Which parts of the key changed (stats().textWhy: benchmarks see why the text layer was redrawn).
    if (T.key) { const a = T.key.split("|"), b = key.split("|"); st.stats.textWhy = b.map((x, k) => x === a[k] ? -1 : k).filter(k => k >= 0).join(","); }
    const t = now();
    // A land's lettering belongs to its copper layer. Later copper, including thermal vias inside a part,
    // covers it in exactly the same position as it does on the 2D board.
    if (exact.size && !V.all) V.all = I.query(doc, defs, V.viewport);
    const lod = exact.size ? I.lodFor(doc, V.all, opts, V.viewport) : null;
    const delta = S.damage;
    // An edit with a known set of changed objects repaints only their boxes. Pours that changed with it
    // (a live drag's tile patches) matter only when the bands carry pours (bandPours).
    const edited = !!delta && T.rev === delta.from && S.rev === delta.to &&
      (delta.known || delta.itemsKnown && (!delta.poursChanged || !bandPours));
    const editedBox = edited ? delta.box : null;
    const local = !area && T.key && !T.empty && T.appearance === rest && T.pours === bandPours && !planning &&
      (T.rev === S.rev || edited && (!exact.size || !lod));
    let damage = editedBox;
    if (local) for (const id of new Set([...selection, ...T.selection])) {
      if (selection.has(id) === T.selection.has(id)) continue;
      const b = S.cache.boxes.get(S.byId.get(id));
      damage = mergeBounds(damage, b);
    }
    T.key = key; T.appearance = rest; T.selection = selection; T.rev = S.rev; T.planning = planning; T.exact = exact; T.pours = bandPours; T.empty = !exact.size && !details?.size && (!V.items.length || V.top && opts.layerMode === "single") && !planning;
    if (T.empty) return null;
    // Drawn on the view's own canvas (cleared again by the top layer after the copy): the browser rasterizes
    // its text exactly as on the 2D path, which a detached canvas does not (glyph coverage differs there).
    T.canvas = I.ctx.canvas; T.ctx = I.ctx;
    // Bands: canvas.js paints a layer's text in that layer's pass, so text goes in one texture per gap between
    // GPU passes (e.g. Bottom overlay text under the Top overlay's line art, Mechanical text under the copper).
    // band.next is the order of the GPU pass it goes under (Infinity: above them all, Board Planning).
    const plan = layerPlan(st, opts, flipped), order = S.order;
    const ord = layer => passOrder(plan, order, layer);
    const gpuOrders = bandOrders(st, plan, order, doc, opts, S.cache.pourSig, V.liveLayers, V.liveSignature);
    const nextOf = l => { const t = ord(l); for (const o of gpuOrders) if (o > t) return o; return Infinity; };
    const textOrders = [...textLayers(doc, defs, V.items)].filter(l => !(V.top && l === V.active));
    const need = [...new Set([...textOrders, ...(details?.keys() || []), ...exact].map(nextOf))].sort((x, y) => x - y);
    // Board Planning's tints (and the pad text under them) go over every layer: a band above all passes.
    if (!need.length || planning && need[need.length - 1] !== Infinity) need.push(Infinity);
    const last = need[need.length - 1], own = new Set(need.slice(0, -1));
    // A band's drawBoard hides every other band's layers; the last band takes any layer the scan missed.
    class Hide extends Set { constructor(base, keep) { super(base); this.keep = keep; } has(l) { return super.has(l) || !this.keep(l); } get size() { return super.size + 1; } }
    const o3 = V.top ? {...V.o2, hidden: new Set([...(opts.hidden || []), V.active])} : V.o2;
    const bands = T.bands || (T.bands = []);
    let sx = 0, sy = 0, sw = W, sh = H, items = V.items, all = V.all, entries = list => list, clipped = false;
    const sameBands = bands.length === need.length && bands.every((b, i) => b.next === need[i]);
    // Nothing the bands draw changed (a pour-only revision, or a selection already shown).
    if (local && !damage && sameBands) return T;
    let areaBox = null;
    if (area) {
      // The slice's world box: device pixels through the view's own transform (flipped X included).
      const o = I.worldToScreen([0, 0]), u = I.worldToScreen([1, 1]), wx = px => (px / dpr - o[0]) / (u[0] - o[0]), wy = py => (py / dpr - o[1]) / (u[1] - o[1]);
      const xa = wx(area[0]), xb = wx(area[0] + area[2]), ya = wy(area[1]), yb = wy(area[1] + area[3]);
      areaBox = [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
    }
    if (local && damage && sameBands || areaBox) {
      const b = areaBox || damage, margin = 8;
      [sx,sy,sw,sh] = areaBox ? area : damagePixels(I,b,dpr,margin*dpr,W,H);
      if (sw <= 0 || sh <= 0) return T;
      const e = (margin + 2) / scale;
      const near = i => { const v = S.cache.boxes.get(i); return !v || (v[2] >= b[0] - e && v[0] <= b[2] + e && v[3] >= b[1] - e && v[1] <= b[3] + e); };
      // Only what reaches the uploaded area is drawn: the layer's text, its ordered copper and pad captions.
      items = V.items.filter(near);
      if (all && exact.size) all = all.filter(near);
      entries = list => list.filter(x => near(x.parent || x.p));
      // WebKit rasterizes the long copper that crosses the area only where it is uploaded. (A clip changes
      // Chromium's antialiasing, so there the layer stays byte for byte what a whole repaint gives.)
      clipped = READBACK;
    }
    while (bands.length > need.length) { gl.deleteTexture(bands.pop().tex); st.checkMemory = true; }
    if (T.w !== W || T.h !== H) { for (const b of bands) gl.deleteTexture(b.tex); bands.length = 0; T.w = W; T.h = H; }
    const g = T.ctx, o = I.worldToScreen([0, 0]);
    const textOptions = {...o3, skipPartBoxes: true, gpu: i => !twoD(i)};
    const freshRows = area && !planning && (st.textJob?.T === T || st.wideText?.T === T);
    let prepared;
    if ((freshRows || !area && !local && need.length > 1) && !exact.size && I.collectBoardLayers &&
        !opts.partBoxesOnly && !opts.recordLayer && !opts.clipLayer) {
      // Each layer still paints in its original band, but all bands share one object scan.
      // Do not retain this viewport's groups in the pan-strip painter.
      const start = now();
      const {ordered, selectedParts} = I.collectBoardLayers(items,doc,defs,scale,textOptions,null,V.viewport,null);
      prepared = new Map(need.map(next => [next,{ordered:[],selectedParts,captions:null}]));
      const forLayer = layer => {
        const next = nextOf(layer);
        return prepared.get(own.has(next) ? next : last);
      };
      for (const pass of ordered) forLayer(pass.layer).ordered.push(pass);
      if (freshRows) {
        for (const [layer, list] of details || []) {
          const captions = entries(list);
          if (captions.length) (forLayer(layer).captions ||= new Map()).set(layer, captions);
        }
        entries = list => list;
      }
      st.stats.acc.board += now() - start;
    }
    // One band's content for its pass (in g's current transform), from these objects: also how a pan draws
    // the strips it uncovers (scrollText), with the objects there.
    function paintBand(g, next, items, all, details, entries, viewport, painted, bounds, layers) {
      const bandBounds = bounds?.include;
      const mine = next === last ? l => !own.has(nextOf(l)) : l => nextOf(l) === next;
      if (exact.size) I.drawBoard(g, all, doc, defs, scale, {...V.o2, skipPartBoxes: true, hidden: new Hide(opts.hidden || [], l => exact.has(l) && mine(l))}, bandPours, viewport, lod, painted, bandBounds);
      for (const [layer, list] of details || []) if (!exact.has(layer) && mine(layer)) {
        const captions = entries(list);
        if (painted) for (const {parent,p} of captions) painted(parent || p);
        paintPadDetails(I, g, captions, layer, scale, V.o2, bounds?.glyph);
      }
      // Each glyph is drawn once in its layer. Component selection rectangles go over all layers.
      const options = exact.size || need.length > 1 ?
        {...textOptions, hidden: new Hide(o3.hidden || [], l => !exact.has(l) && mine(l))} : textOptions;
      I.drawBoard(g, items, doc, defs, scale, options, null, viewport, null, painted, bandBounds, layers);
    }
    // A pan can extend these bands only while they hold just text and pad captions drawn for this camera.
    T.valid = [0, 0];
    T.strip = planning ? null : {paintBand, need: need.slice(), exact, lod: !!lod, cam: cam.slice(), padDetails: V.padDetails, o2: V.o2, gone: goneIds(opts)};
    for (let n = 0; n < need.length; n++) {
      const next = need[n];
      // Linear: a gesture frame samples it moved and scaled; at rest it is sampled at pixel centres.
      const band = bands[n] ||= {tex:null};
      band.next = next;
      const layers = prepared?.get(next), row = freshRows && layers;
      // A fresh slice writes these rows once. Empty rows stay transparent in the new texture.
      if (row && !row.ordered.length && !row.captions) continue;
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      if (clipped) g.clearRect(sx, sy, sw, sh); else g.clearRect(0, 0, W, H);
      if (clipped) { g.save(); g.beginPath(); g.rect(sx, sy, sw, sh); g.clip(); }
      g.setTransform((flipped ? -scale : scale) * dpr, 0, 0, scale * dpr, o[0] * dpr, o[1] * dpr); g.lineJoin = "round"; g.lineCap = "round";
      const t1 = now();
      // In a full WebKit paint, remember whether any of this band’s art can reach the canvas.
      // Keep the ordered band descriptor so a pan can paint into it if ink comes into view.
      let ink = !READBACK || !!area || local || T.planning || !!lod;
      const painted = (item, bounds) => ink ||= inkTouches(S.cache.boxes, V.viewport, item, bounds);
      const bounds = READBACK && !area && !local && !rolled && !T.planning && !lod ? bandRectangle() : null;
      paintBand(g, next, items, all, row ? row.captions : details, entries, V.viewport, ink ? null : painted, bounds, layers);
      st.stats.acc.board += now() - t1;
      // Board Planning mode (key 1): regions as tinted areas, bend lines dashed with labels, under the connection lines.
      // The layer goes over every board layer then, so pad numbers and nets join it, under the tints as in canvas.js.
      if (T.planning && next === Infinity && !fault("planning")) G.AtriumRigidFlex.drawPlanning(g, doc, {scale, dpr, worldToScreen: I.worldToScreen, selected: opts.planning?.region, line: opts.planning?.line}, defs);
      if (clipped) g.restore();
      // Straight (not premultiplied) alpha: the copy shader premultiplies (u_straight).
      if (ink) {
        let x = sx, y = sy, w = sw, h = sh;
        if (READBACK) {
          const current = bounds?.rect(W,H), previous = band.tex ? band.inkRect : null;
          band.inkRect = current;
          if (current !== undefined && previous !== undefined) {
            const both = mergeBounds(current, previous);
            if (both) [x,y,w,h] = [both[0],both[1],both[2]-both[0],both[3]-both[1]];
            else w = h = 0;
          }
        }
        if (w > 0 && h > 0) {
          const tex = bandTexture(st,band,W,H), uploadStart = timing ? now() : 0;
          uploadCanvas(gl,tex,T.canvas,x,y,w,h,gl.RGBA,timing);
          if (timing) timing.upload += now() - uploadStart;
          st.stats.textUpload += w * h * 4;
        }
      } else if (band.tex) {
        gl.deleteTexture(band.tex); band.tex = null;
      }
    }
    st.stats.acc.text += now() - t;
    return T;
  }
  // Mutate one settled connection for the pixel gate, keeping the reference path and
  // the editor's connectivity cache intact.
  function faultWireRaster(I, wires, opts, deviceScale, paint) {
    const saved = I.connectivity;
    const replace = airwires => { I.connectivity = {...saved, index:null, result:{...saved.result, airwires}}; };
    try {
      if (fault("wireGeometry")) {
        const [first, ...rest] = wires;
        const move = ([x,y]) => [x, y + 1/deviceScale];
        replace([{...first, from:move(first.from), to:move(first.to)}, ...rest]);
        paint(opts.netColors);
      } else {
        const tinted = wires.filter(w => opts.netColors?.get(w.net));
        const late = tinted.length && wires.find(w => !opts.netColors.get(w.net) && tinted.some(t =>
          G.AtriumGeometry.segmentDistance(w.from, w.to, t.from, t.to) === 0));
        if (late) replace(wires.filter(w => w !== late));
        paint(opts.netColors);
        if (late) { replace([late]); paint(null); }
      }
    } finally { I.connectivity = saved; }
  }
  // Views share one work budget after each refresh. Exact-camera work takes priority over
  // speculative wide artwork. Each indivisible step may overrun; charge its actual time before
  // starting any successor, and limit work even when the performance clock rounds to zero.
  // Aim for about half the observed refresh interval, up to 8 ms. Very fast displays and
  // sufficiently expensive individual steps can still see work span refreshes.
  const SLICE_MS = 3.5;
  const cameraSlices = new Set(), wideSlices = new Set();
  let cancelSliceFrame = null, runningSliceFrame = false, lastSliceFrame = null;
  function scheduleSliceFrame() {
    if (runningSliceFrame || cancelSliceFrame) return;
    if (!(cameraSlices.size || wideSlices.size)) { lastSliceFrame = null; return; }
    const afterRefresh = at => {
      const budget = lastSliceFrame === null ? 5 : Math.max(5, Math.min(8, (at - lastSliceFrame) / 2));
      lastSliceFrame = at;
      const timer = setTimeout(() => runSliceFrame(budget), 0);
      cancelSliceFrame = () => clearTimeout(timer);
    };
    const idle = G.AtriumIdle;
    const id = idle ? idle.sampleFrame(afterRefresh) : G.requestAnimationFrame(afterRefresh);
    cancelSliceFrame = () => idle ? idle.cancelSample(id) : G.cancelAnimationFrame(id);
  }
  function runSliceFrame(budget) {
    cancelSliceFrame = null;
    runningSliceFrame = true;
    let remaining = budget;
    try {
      while (cameraSlices.size || wideSlices.size) {
        const jobs = cameraSlices.size ? cameraSlices : wideSlices, job = jobs.values().next().value;
        if (remaining < budget && job.estimate > remaining) break;
        jobs.delete(job);
        const start = now();
        job.step();
        remaining -= Math.max(.25, now() - start);
      }
    } finally {
      runningSliceFrame = false;
      scheduleSliceFrame();
    }
  }
  function queueTextSlice(job, own) {
    const jobs = own ? cameraSlices : wideSlices;
    jobs.add(job);
    job.cancel = () => {
      jobs.delete(job);
      if (cameraSlices.size || wideSlices.size) return;
      cancelSliceFrame?.();
      cancelSliceFrame = null;
      scheduleSliceFrame();
    };
    scheduleSliceFrame();
  }
  // The text layer for a camera, painted a slice of rows at a time in steps of about SLICE_MS, into
  // textures of its own (memory: one more set of bands while it runs), so neither the frame that ends a
  // zoom nor anything after it blocks input: that frame scales the layers it has (as a gesture frame does)
  // and this replaces them once every row is drawn. A camera, revision or visibility change abandons it.
  // target: the canvas the slices are drawn on: the view's own (whose pixels each slice puts back: the
  // overlay drawn for this camera) or the wide copy's; cam: the camera to draw for (I.withCamera).
  function textSlices(I, st, doc, defs, opts, list, name, cam, target, done) {
    cancelSlices(st, name);
    const W = st.canvas.width, H = st.canvas.height, rev = st.scene?.rev, at = I.cam().join();
    const job = st[name] = {at, T: {key: null}, y: 0, rows: 16, V: null, step, estimate: 1, cancel: null};
    const own = target === I.ctx.canvas;
    const queue = () => queueTextSlice(job, own);
    function step() {
      job.cancel = null;
      if (st[name] !== job) return;
      if (views.get(I) !== st || st.lost || !st.shown || !visible() || st.scene?.rev !== rev || I.cam().join() !== at || I.cache?.doc !== doc ||
        st.canvas.width !== W || st.canvas.height !== H || !own && !canPrepaintWide(I)) {
        // The scaled frame is not left on screen: the next frame is drawn for whatever changed.
        cancelSlices(st, name); st.stats.sliceAbandoned = (st.stats.sliceAbandoned || 0) + 1;
        if (own && views.get(I) === st && st.shown) repaint(I);
        return;
      }
      // Steps: the objects in view, then the text key and pad captions, then rows of text,
      // then pour coverage for this camera (the view's own text only).
      const t0 = now(), keep = I.ctx, phase = job.phase = (job.phase || 0) + 1, h = phase < 3 ? 0 : Math.min(job.rows, H - job.y);
      if (phase > 1) st.commandEpoch++;
      let T = job.T, foreground;
      try {
        // Only the slice's rows are drawn where the drawing is clipped (WebKit): only they are kept and put back.
        if (own && h) st.sliceCopy = READBACK ? copyRows(target, st.sliceCopy, job.y, h) : copyCanvas(target, st.sliceCopy);
        // The final coverage paint can clear the view despite having no text rows.
        // Save the visible overlay before it runs and reuse that copy when publishing.
        else if (own && job.y >= H && st.exact) foreground = st.sliceCopy = copyCanvas(target, st.sliceCopy);
        I.ctx = target.getContext("2d");
        I.withCamera(cam[0], cam[1], cam[2], () => {
          const c2 = I.cam();
          if (phase === 1) job.V = scope(I, st, doc, defs, opts, c2, list, false);
          else if (job.y < H) T = textLayer(I, st, doc, defs, opts, c2, job.V, list, job.T, [0, job.y, W, h]);
          else if (own) pourCoverage(I, st, doc, defs, opts, c2, job.V, list, job.T, I.sync(doc, defs));
        });
      } catch (e) { cancelSlices(st, name); return; }
      finally {
        I.ctx = keep;
        if (own && h && st.sliceCopy) restorePixels(keep, st.sliceCopy, W, job.y, h);
        if (foreground && (st[name] !== job || st.driverOutOfMemory)) {
          restorePixels(keep, foreground);
          releaseCanvas(st, "sliceCopy");
        }
      }
      if (st[name] !== job) return;
      if (st.driverOutOfMemory) { cancelSlices(st, name); memory(I, st, doc); repaint(I); return; }
      const ms = now() - t0, done1 = job.y >= H;
      job.y += h;
      st.stats.slices = (st.stats.slices || 0) + 1; st.stats.sliceMs = Math.max(st.stats.sliceMs || 0, ms);
      (st.stats.slicePhases ||= {})[Math.min(phase, 3) + (done1 ? 1 : 0)] = Math.max(st.stats.slicePhases[Math.min(phase, 3) + (done1 ? 1 : 0)] || 0, +ms.toFixed(1));
      // Work includes scope, captions and coverage. Rows sum device row heights across jobs.
      st.stats[own ? "textSliceRows" : "wideSliceRows"] += h;
      st.stats[own ? "textSliceWorkMs" : "wideSliceWorkMs"] += ms;
      // Estimate the next raster step from rows just drawn. Scope, setup and coverage have their own costs.
      if (h) job.rows = Math.max(8, Math.min(H, Math.ceil(job.rows * 1.5), Math.round(h * SLICE_MS / Math.max(ms, .25))));
      job.estimate = phase === 1 ? 1 : h && job.y < H ? Math.max(.25, ms * Math.min(job.rows, H - job.y) / h) : SLICE_MS;
      if (T && (job.y < H || own && !done1)) { queue(); return; }
      st[name] = null;
      if (own && !foreground) releaseCanvas(st, "sliceCopy");
      done(T ? job.T : null, job.V, foreground);
      if (!memory(I, st, doc)) repaint(I);
      else queueDriverMemoryProbe(I, st, doc);
    }
    queue();
  }
  // Selections and the active layer's text above the GPU board. Pad captions
  // are composited with the copper in textLayer.
  function overlay(I, st, doc, defs, opts, cam, V, exactWires, frame) {
    overlayWorld(I, st, doc, defs, opts, cam, V);
    if (exactWires) {
      // The editor already has a transparent tool canvas. Rasterize the settled wire path there
      // with the same stroke as Canvas 2D, without uploading another texture to the GPU.
      const viewport = I.artworkViewport();
      const paint = colors => I.drawAirwires(doc, defs, viewport, opts.highlight, false, colors);
      if (fault("wireGeometry") || fault("wireTintOrder")) faultWireRaster(I, exactWires, opts, cam[2]*cam[6], paint);
      else paint(opts.netColors);
    }
    overlayTop(I, doc, defs, opts, null, undefined, V, frame);
  }
  function overlayTop(I, doc, defs, opts, area, strips, V, frame) {
    const before = overlays;
    overlays = true;
    try { I.paintTop(doc, defs, opts, area, true, doc.outline?.length >= 3 && !opts.hidden?.has("Board"), strips, V, frame); }
    finally { overlays = before; }
  }
  // The world-sized part of the overlay (a zoom gesture scales it), kept in st.overlayWorld.
  // strip: a pan's uncovered strip (scrollOverlay; the caller clips and clears it), not kept as the copy.
  function overlayWorld(I, st, doc, defs, opts, cam, V, strip = false, text = st.text) {
    const [, , scale] = cam, ctx = I.ctx, S = st.scene, c = S.cache, sel = opts.selected, ids = opts.selectedIds, viewport = V.viewport;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    if (!strip) { ctx.clearRect(0, 0, I.canvas.width, I.canvas.height); st.overlayV = {top: V.top, active: V.active, o2: V.o2}; }
    I.boardTransform();
    let drew = false;
    // Fault "selection": selected copper drawn again above everything (the experiment's old layering).
    if (fault("selection") && (opts.selected != null || opts.selectedIds?.size)) {
      drew = true;
      const byId = S.byId || (S.byId = new Map(c.all.map(i => [i.id, i]))), list = [...new Set([...(opts.selectedIds || []), opts.selected])].map(id => byId.get(id)).filter(i => i && !twoD(i));
      I.drawBoard(ctx, list, doc, defs, scale, V.o2, null, viewport, null);
    }
    if (V.top && !text?.exact?.has(V.active)) {
      const t = now(); drew = true;
      const gone = V.items ? null : new Set(goneIds(opts));
      const items = V.items || I.query(doc, defs, viewport).filter(i => twoD(i) && !gone.has(i.id));
      I.drawBoard(ctx, items, doc, defs, scale, {...V.o2, layerMode: "single", skipPartBoxes: true, gpu: i => !twoD(i)}, null, viewport, null);
      st.stats.acc.board += now() - t;
    }
    // Selection boxes above the layered geometry. Text and track handles stay with their layers.
    if (sel != null || ids?.size) {
      const byId = S.byId || (S.byId = new Map(c.all.map(i => [i.id, i])));
      const chosen = new Set(ids || []); if (sel != null) chosen.add(sel);
      const parts = [];
      for (const id of chosen) {
        const i = byId.get(id);
        if (i?.kind === "part") { parts.push(i); continue; }
        if (!i || twoD(i) || !PCB.visible(boardLayer(i), i, opts)) continue;
        if (i.kind === "via" || i.kind === "pad") {
          const b = G.Atrium.bounds(G.Atrium.itemPoints(i, null, "pcb")), pad = 2 / scale;
          if (!b) continue;
          drew = true;
          ctx.save(); ctx.globalAlpha *= .7; ctx.strokeStyle = PCB.system.selection; ctx.lineWidth = 1 / scale;
          ctx.beginPath(); ctx.rect(b[0] - pad, b[1] - pad, b[2] - b[0] + pad * 2, b[3] - b[1] + pad * 2); ctx.stroke(); ctx.restore();
        }
      }
      if (parts.length) {
        drew = true;
        I.drawBoard(ctx, parts, doc, defs, scale, {...V.o2, partBoxesOnly: true}, null, viewport, null);
      }
    }
    // A zoom gesture scales this world-sized part; the screen-sized top layer is drawn again for each camera.
    if (strip) return;
    if (drew) st.overlayWorld = copyCanvas(I.ctx.canvas, st.overlayWorld); else releaseCanvas(st, "overlayWorld");
  }
  function stripContext(st, key, w, h) {
    let c = st[key];
    if (!c) { c = st[key] = G.document.createElement("canvas"); c.width = c.height = 1; }
    G.AtriumCanvas.resizeBacking(c,Math.max(c.width,w),Math.max(c.height,h));
    return c.getContext("2d", {willReadFrequently: true});
  }
  // A pan (the exact frame's scale) moves the text bands by whole device pixels (X, Y) and draws only what it
  // uncovers. A band's texels hold the view around the exact camera modulo the band's size (the copy shader's
  // u_wrap), so each frame paints the strips that came into view where the strips that left it were, in a
  // small canvas of its own, and uploads just those (a few rows and columns, against a whole layer per band).
  // T.valid is the top-left, in the exact frame's device pixels, of the window the bands now hold.
  // False when the bands cannot be extended (the caller falls back to the wide copy).
  function scrollText(I, st, doc, defs, opts, T, X, Y) {
    const P = T.strip, gl = st.gl, W = T.w, H = T.h;
    if (!P || !T.bands?.length || T.bands.length !== P.need.length || !W || !H) { st.stats.panRefused = P ? "bands" : "no strip painter"; return false; }
    const [ecx, ecy, scale, flipped, , , dpr] = P.cam, f = flipped ? -1 : 1;
    const [vx, vy] = T.valid, nx = -X, ny = -Y;
    if (nx === vx && ny === vy) return true;
    // The uncovered strips, in the exact frame's device pixels (unwrapped).
    // Transpose the strips so the vertical texture upload retains the corner.
    const ddx = nx - vx, ddy = ny - vy;
    const rects = Math.abs(ddx) >= W || Math.abs(ddy) >= H ? [[nx, ny, W, H]]
      : I.exposedPanStrips(H, W, -ddy, -ddx).map(([y0, x0, y1, x1]) => [nx + x0, ny + y0, x1 - x0, y1 - y0]);
    // Each strip in texels: split where it wraps.
    const mod = (a, n) => ((a % n) + n) % n, pieces = [];
    const split = (a, n, size) => { const t = mod(a, size); return t + n <= size ? [[a, t, n]] : [[a, t, size - t], [a + size - t, 0, n - (size - t)]]; };
    for (const [x, y, w, h] of rects) if (w > 0 && h > 0) for (const [sx, tx, tw] of split(x, w, W)) for (const [sy, ty, th] of split(y, h, H)) pieces.push([sx, sy, tx, ty, tw, th]);
    const k = scale * dpr, o = I.withCamera(ecx, ecy, scale, () => I.worldToScreen([0, 0]));
    // Keep the short sides independent: a diagonal pan can need almost the full width and height
    // in different pieces. Thin pieces hold at most a quarter of a viewport across both backings.
    const wide = [0, 0], tall = [0, 0];
    for (const [, , , , w, h] of pieces) {
      const size = w >= h ? wide : tall;
      size[0] = Math.max(size[0], w); size[1] = Math.max(size[1], h);
    }
    const large = st.stripLarge || Math.max(wide[1], tall[0]) > Math.min(W, H) / 8;
    let horizontal, vertical;
    if (large) {
      // A large jump can need a whole-frame backing. Drop the thin caches before allocating it.
      if (!st.stripLarge) { releaseCanvas(st, "stripWide"); releaseCanvas(st, "stripTall"); }
      horizontal = vertical = stripContext(st, "stripLarge", Math.max(wide[0], tall[0]), Math.max(wide[1], tall[1]));
    } else {
      if (wide[0]) horizontal = stripContext(st, "stripWide", ...wide);
      if (tall[0]) vertical = stripContext(st, "stripTall", ...tall);
    }
    const gone = P.gone?.length ? new Set(P.gone) : null, t = now();
    const all = e => e, boxes = st.scene.cache.boxes;
    let blank = st.emptyStrip;
    for (const [sx, sy, tx, ty, w, h] of pieces) {
      const g = w >= h ? horizontal : vertical;
      // The strip's world box (device px of the exact frame to world), with a margin for glyphs and strokes.
      const wx0 = (sx / dpr - o[0]) / (f * scale), wx1 = ((sx + w) / dpr - o[0]) / (f * scale), m = 8 / scale;
      const box = [Math.min(wx0, wx1) - m, (sy / dpr - o[1]) / scale - m, Math.max(wx0, wx1) + m, ((sy + h) / dpr - o[1]) / scale + m];
      let found = I.query(doc, defs, box);
      if (gone) found = found.filter(i => !gone.has(i.id));
      const items = found.filter(twoD);
      let details = null;
      // Captions that later copper covers on a layer the bands do not order (coveredPadDetails) show above it
      // until the exact frame at rest: a pan never stops to redraw whole bands for them.
      if (P.padDetails) details = padDetails(found, defs, scale, P.o2, doc, P.exact);
      P.need.forEach((next, n) => {
        const band = T.bands[n], bytes = w * h * 4;
        let ink = P.lod;
        if (found.length || T.pours || ink) {
          g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; g.clearRect(0, 0, w, h);
          g.save(); g.beginPath(); g.rect(0, 0, w, h); g.clip();
          g.setTransform(f * k, 0, 0, k, o[0] * dpr - sx, o[1] * dpr - sy); g.lineJoin = "round"; g.lineCap = "round";
          P.paintBand(g, next, items, found, details, all, box,
            ink ? null : (item, bounds) => ink ||= inkTouches(boxes, box, item, bounds));
          g.restore();
        }
        // A never-used band stays unallocated. An existing band can contain old wrapped ink,
        // so clear the entering strip with zero texels instead of reading a blank canvas.
        if (!ink && !band.tex) return;
        if (!ink && (!blank || blank.length < bytes)) {
          blank = new Uint8Array(bytes);
          if (bytes <= 256 * 1024) st.emptyStrip = blank;
        }
        if (READBACK) band.inkRect = undefined;
        gl.bindTexture(gl.TEXTURE_2D, bandTexture(st,band,W,H));
        if (ink) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, tx, H - ty - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, ink ? g.getImageData(0, 0, w, h) : blank);
        if (ink) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        st.stats.textUpload += bytes;
      });
    }
    T.valid = [nx, ny];
    st.stats.acc.text += now() - t;
    return true;
  }
  // The top 2D layer during a pan: its pixels shifted by whole device pixels (the change from the shift it
  // shows, st.ovAt), and only the strips that uncovers painted, with the camera that matches those pixels,
  // as canvas.js pans its 2D board. (X, Y): the shift from the exact frame.
  function scrollOverlay(I, st, doc, defs, opts, E, X, Y, frame) {
    const c = I.canvas, g = I.ctx, W = c.width, H = c.height, dpr = E.dpr, f = E.flipped ? -1 : 1;
    // The canvas shows something else (a zoom frame): all of it is painted for this pan's camera.
    const at = st.ovAt || [X + W, Y + H], dx = X - at[0], dy = Y - at[1];
    st.ovAt = [X, Y];
    if (!dx && !dy) return true;
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "copy";
    if (Math.abs(dx) < W && Math.abs(dy) < H) g.drawImage(c, dx, dy); else g.clearRect(0, 0, W, H);
    g.restore();
    const w = E.width, h = E.height, ax = dx / dpr, ay = dy / dpr;
    // The camera these shifted pixels show.
    const cx = E.cx - X / dpr / (f * E.scale), cy = E.cy - Y / dpr / E.scale, V0 = st.overlayV;
    I.withCamera(cx, cy, E.scale, () => {
      const strips = Math.abs(dx) >= W || Math.abs(dy) >= H ? [[0, 0, w, h]] : I.exposedPanStrips(w, h, ax, ay, opts);
      g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.beginPath();
      for (const a of strips) g.rect(a[0], a[1], a[2] - a[0], a[3] - a[1]);
      g.clip(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
      for (const a of strips) {
        if (V0) {
          const p = I.worldToScreen([0, 0]), sc = E.scale;
          const x0 = (a[0] - p[0]) / (f * sc), x1 = (a[2] - p[0]) / (f * sc), m = 8 / sc;
          const viewport = [Math.min(x0, x1) - m, (a[1] - p[1]) / sc - m, Math.max(x0, x1) + m, (a[3] - p[1]) / sc + m];
          // A selected object's outline can extend beyond the query's viewport. Confine each
          // draw to its own strip so translucent ink is composited only once in repaired pixels.
          if (strips.length > 1) {
            g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.beginPath(); g.rect(a[0], a[1], a[2] - a[0], a[3] - a[1]); g.clip();
          }
          overlayWorld(I, st, doc, defs, opts, [cx, cy, sc], {...V0, viewport}, true);
          if (strips.length > 1) g.restore();
        }
      }
      // The screen-sized layer (net names, DRC markers, tools) once for all the strips.
      const area = strips.reduce((u, a) => [Math.min(u[0], a[0]), Math.min(u[1], a[1]), Math.max(u[2], a[2]), Math.max(u[3], a[3])]);
      I.boardTransform();
      try { overlayTop(I, doc, defs, opts, area, strips, null, frame); } finally { g.restore(); }
    });
    return true;
  }
  // Clip-free reuse of bands from the exact camera or the wider camera built
  // at rest. A band can own a whole ordered copper layer as well as text.
  function covers(E, cx, cy, scale, flipped, width, height, artworkBounds) {
    const k = scale / E.scale, f = flipped ? -1 : 1;
    if (k > 3) return false;
    const tx = width / 2 * (1 - k) + f * (E.cx - cx) * scale, ty = height / 2 * (1 - k) + (E.cy - cy) * scale;
    if (tx <= .5 && ty <= .5 && tx + width * k >= width - .5 && ty + height * k >= height - .5) return true;
    // A raster that already contains the finished artwork may expose more
    // workspace without being replaced by a lower-resolution version.
    const dx = (width / 2 - 8) / E.scale, dy = (height / 2 - 8) / E.scale;
    return artworkBounds && E.cx - dx <= artworkBounds[0] && E.cx + dx >= artworkBounds[2] &&
      E.cy - dy <= artworkBounds[1] && E.cy + dy >= artworkBounds[3];
  }
  function cancelWide(st) {
    if (st.wideJob) { clearTimeout(st.wideJob); st.wideJob = 0; }
    cancelSlices(st, "wideText");
  }
  function freeWide(st) {
    cancelWide(st);
    const w = st.wide;
    st.wide = null;
    if (!w) return;
    for (const b of w.text.bands || []) st.gl.deleteTexture(b.tex);
    if (w.overlay) w.overlay.width = w.overlay.height = 1;
    st.checkMemory = true;
  }
  // After a gesture frame: the frame that ends the move in 140 ms; after that frame, the text for its camera.
  function afterMove(I, st, doc, defs, opts, list, settling, gesture) {
    if (!gesture && !settling) return; // a frame while the text is prepared
    if (!settling) { cancelSettle(st, true); st.idle = setTimeout(() => { st.idle = 0; st.settling = true; repaint(I); }, 140); return; }
    if (st.idle) clearTimeout(st.idle);
    st.idle = 0;
    releaseCanvas(st, "stripLarge");
    const cam = I.cam();
    textSlices(I, st, doc, defs, opts, list, "textJob", cam, I.ctx.canvas, (T, V, foreground) => {
      const old = st.text;
      if (old !== T) for (const b of old.bands || []) st.gl.deleteTexture(b.tex);
      st.text = T || {key: null}; st.checkMemory = true;
      // The layers are this camera's from here: the next gesture starts from them, not the previous exact frame's.
      if (st.exact) {
        const keep = foreground || (st.sliceCopy = copyCanvas(I.canvas, st.sliceCopy));
        try { overlayWorld(I, st, doc, defs, opts, cam, V); }
        finally {
          restorePixels(I.ctx, keep);
          releaseCanvas(st, "sliceCopy");
        }
        st.exact = {...st.exact, cx: cam[0], cy: cam[1], scale: cam[2]}; st.ovAt = null; releaseOverlayCopy(st);
      }
      // The exact frame: its text layer is current now, so it only composites (and draws the top layer).
      repaint(I);
    });
  }
  // The wide copy for the camera (cx, cy, scale), on a canvas of its own, in idle slices (textSlices): glyphs
  // there may differ slightly from the view's, which only a moving frame shows.
  function wideLayers(I, st, doc, defs, opts, list, cx, cy, scale) {
    const E = st.exact, W = I.canvas.width, H = I.canvas.height, forKey = st.text.key, forOverlay = !!st.overlayWorld;
    let c = st.wideCanvas;
    if (!c) {
      c = st.wideCanvas = G.document.createElement("canvas");
      st.wideCanvasPublished = false;
    }
    G.AtriumCanvas.resizeBacking(c,W,H);
    textSlices(I, st, doc, defs, opts, list, "wideText", [cx, cy, scale], c, (T, V) => {
      if (st.exact !== E || st.text.key !== forKey) { if (T) for (const b of T.bands || []) st.gl.deleteTexture(b.tex); return; }
      const old = st.wide, keep = I.ctx, overlayKeep = st.overlayWorld, overlayView = st.overlayV;
      st.wide = null;
      if (old && old.text !== T) for (const b of old.text.bands || []) st.gl.deleteTexture(b.tex);
      try {
        I.ctx = c.getContext("2d");
        st.overlayWorld = old?.overlay || null;
        // The wide overlay belongs to the bands completed by this job.
        I.withCamera(cx, cy, scale, () => overlayWorld(I, st, doc, defs, opts, I.cam(), V, false, T));
        // Retained zoom reads the bands and copied overlay; only exact text paints strips.
        if (T) T.canvas = T.ctx = T.strip = null;
        st.wide = {...E, cx, cy, scale, text: T || {key: null}, overlay: st.overlayWorld, forKey, forOverlay};
      } finally {
        I.ctx = keep; st.overlayWorld = overlayKeep; st.overlayV = overlayView;
      }
      // Give back the initial idle backing once. A later build reuses the regrown canvas,
      // even if GPU pressure has discarded the prior wide textures.
      if (st.wideCanvas === c && !st.wideCanvasPublished) {
        st.wideCanvasPublished = true;
        if (!old && !st.wideText) c.width = 0;
      }
      st.checkMemory = true;
      st.stats.wideBuilds = (st.stats.wideBuilds || 0) + 1;
    });
  }
  // After an exact frame, once the view has been still for 250 ms (never during a drag or gesture).
  function scheduleWide(I, st, doc, defs, opts, list) {
    if (!canPrepaintWide(I)) { cancelWide(st); return; }
    if (st.wideJob) clearTimeout(st.wideJob);
    st.wideJob = 0;
    if (opts.transientGeometry || !(st.text.bands?.length && st.text.key && !st.text.empty || st.overlayWorld)) return;
    const E = st.exact;
    function ready() {
      const w = st.wide;
      return w && w.cx === E.cx && w.cy === E.cy && w.scale === E.scale * .5 && wideFits(st, E, doc, E.rev, list);
    }
    if (ready()) return;
    st.wideJob = setTimeout(() => {
      st.wideJob = 0;
      if (views.get(I) !== st || st.exact !== E || st.lost || !st.shown || !visible() || !canPrepaintWide(I) || ready()) return;
      wideLayers(I, st, doc, defs, opts, list, E.cx, E.cy, E.scale * .5);
    }, 250);
  }
  function wideFits(st, E, doc, rev, list) {
    const w = st.wide;
    return !!w && w.doc === doc && w.rev === rev && w.flipped === E.flipped && w.width === E.width && w.height === E.height && w.dpr === E.dpr &&
      w.forKey === st.text.key && w.forOverlay === !!st.overlayWorld && (!w.text.pours || w.text.pours === list);
  }
  // True while the overlays above a GPU frame are drawn (on the 2D canvas the GPU path also uses as
  // scratch for its text and coverage uploads): drc-markers.js then draws its markers directly.
  let overlays = false;
  // Pad captions belong to their land's pass. Active copper, connection lines
  // and planning tints can cover them in later passes.
  function padDetails(items, defs, scale, opts, doc, orderedLayers) {
    const groups = new Map(), showCaptions = !fault("padText");
    const one = (p, parent, layer) => {
      const g = PCB.padGeometry(p, opts.layer || "Top", layer);
      if (!showCaptions || !PCB.padCaption(p,parent,g,scale,opts)) return;
      if (!groups.has(layer)) groups.set(layer, []);
      groups.get(layer).push({p, parent, g});
    };
    for (const i of items) {
      if (i.kind === "pad" || i.kind === "via") {
        const layer = boardLayer(i);
        if (!orderedLayers?.has(layer) && PCB.visible(layer, i, opts)) one(i, null, layer);
        continue;
      }
      if (i.kind !== "part") continue;
      const fp = PCB.readDefinition(defs,i.def,doc)?.footprint;
      if (!fp) continue;
      for (const g of PCB.footprintLayers(i, fp)) {
        if (orderedLayers?.has(g.layer) || !PCB.visible(g.layer, null, opts)) continue;
        for (const p of g.pads) if (PCB.visible(g.layer, p, opts)) one(p, i, g.layer);
      }
    }
    return groups;
  }
  function padDetailBox(g, parent) {
    const {at: [x,y], angle} = G.AtriumResolvedLand.place(g,parent), quarter = Math.abs(Math.round(angle / 90)) % 2;
    const hw = (quarter ? g.h : g.w) / 2, hh = (quarter ? g.w : g.h) / 2;
    return [x - hw, y - hh, x + hw, y + hh];
  }
  // Later copper on the same layer can cover a caption painted with its land.
  // Ordinary disjoint pads keep the retained GPU pass; overlapping ones use the ordered layer.
  function coveredPadDetails(I, doc, defs, groups) {
    const layers = new Set(), spatial = G.AtriumSpatial, c = I.cache;
    const pendingSpatial = c?.doc === doc && c.preparation && spatial;
    let queries = 0, local;
    let placed, captionCounts;
    const boundsOf = (pad, item) => {
      const [x,y] = PCB.padCenter(pad,item), r = Math.hypot(pad.w || pad.diameter || 0, pad.h || pad.diameter || 0) / 2;
      return [x-r,y-r,x+r,y+r];
    };
    function manyCaptions(item, entries) {
      if (entries.length <= 64) return false;
      captionCounts ??= new WeakMap();
      let count = captionCounts.get(entries);
      if (!count) {
        captionCounts.set(entries,count = new Map());
        for (const {parent} of entries) if (parent) count.set(parent,(count.get(parent) || 0) + 1);
      }
      return count.get(item) > 64;
    }
    // Groups share geometry between placed instances. Index world-space bounds
    // by placement and only for this synchronous occlusion calculation.
    function siblingIndex(item, group) {
      placed ??= new WeakMap();
      let byGroup = placed.get(item);
      if (!byGroup) placed.set(item, byGroup = new Map());
      if (byGroup.has(group)) return byGroup.get(group);
      const rows = [], first = new Map();
      let unbounded = -1;
      for (const [order,pad] of group.pads.entries()) {
        if (!first.has(pad)) first.set(pad,order+1);
        if (pad.padStack || pad.poly) { unbounded = order; continue; }
        const box = boundsOf(pad,item);
        // The legacy overlap predicate still decides malformed bounds.
        if (!box.every(Number.isFinite)) { byGroup.set(group,null); return null; }
        rows.push({order,box});
      }
      const entry = {first, unbounded, grid:spatial.create(rows,row=>row.box,1)};
      byGroup.set(group,entry);
      return entry;
    }
    layerPass: for (const [layer, entries] of groups) for (const {p, parent, g} of entries) {
      const box = padDetailBox(g,parent);
      // Amortize the temporary index only when several actual caption queries were needed.
      if (pendingSpatial && ++queries === 8) {
        // The full pick grid is still under construction. One authoritative query includes
        // later occluders outside the viewport or suppressed by the painter.
        let bounds = null;
        for (const entries of groups.values()) for (const {g,parent} of entries) {
          const rect = padDetailBox(g,parent);
          if (rect.every(Number.isFinite)) bounds = mergeBounds(bounds,rect);
        }
        if (bounds) {
          const items = I.query(doc,defs,bounds), boxes = I.cache.boxes;
          local = spatial.create(items,item => boxes.get(item),4);
        }
      }
      let after = false;
      const items = local && box.every(Number.isFinite) ? local.query(box) : I.query(doc, defs, box);
      for (const i of items) {
        if (i === (parent || p)) after = true;
        if (i.kind !== "part") {
          if (after && !parent && i !== p && boardLayer(i) === layer) { layers.add(layer); continue layerPass; }
          continue;
        }
        if (parent && !after) continue;
        const group = PCB.footprintLayers(i, PCB.readDefinition(defs,i.def,doc)?.footprint).find(g => g.layer === layer);
        if (!group) continue;
        if (i !== parent && group.shapes.length) { layers.add(layer); continue layerPass; }
        const indexed = i === parent && group.pads.length > 64 && spatial.create && manyCaptions(i,entries) &&
          box.every(Number.isFinite) && siblingIndex(i,group);
        if (indexed) {
          const first = indexed.first.get(p) ?? 0;
          if (indexed.unbounded >= first || indexed.grid.query(box).some(row=>row.order >= first)) {
            layers.add(layer); continue layerPass;
          }
          continue;
        }
        const first = i === parent ? group.pads.indexOf(p) + 1 : 0;
        for (let n = first; n < group.pads.length; n++) {
          const pad = group.pads[n];
          if (pad.padStack || pad.poly || spatial.overlaps(box,boundsOf(pad,i))) { layers.add(layer); continue layerPass; }
        }
      }
    }
    return layers;
  }
  function paintPadDetails(I, ctx, entries, layer, scale, opts, glyphBounds) {
    for (const {p, parent, g} of entries) {
      ctx.save();
      I.padText(ctx, p, g, scale, opts, parent, undefined, layer, glyphBounds);
      ctx.restore();
    }
  }

  function releaseCanvas(st, key) {
    if (st[key]) { st[key].width = st[key].height = 1; st[key] = null; }
  }
  function copyCanvas(c, copy) {
    copy ||= c.ownerDocument.createElement("canvas");
    G.AtriumCanvas.resizeBacking(copy,c.width,c.height);
    const g = copy.getContext("2d"); g.globalCompositeOperation = "copy"; g.drawImage(c, 0, 0);
    return copy;
  }
  function restorePixels(g, copy, w, y, h) {
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "copy";
    if (READBACK && h) {
      g.beginPath(); g.rect(0, y, w, h); g.clip();
      g.drawImage(copy, 0, 0, w, h, 0, y, w, h);
    } else g.drawImage(copy, 0, 0);
    g.restore();
  }
  function releaseOverlayCopy(st) { releaseCanvas(st, "overlayCopy"); }
  // Rows y..y+h of a canvas, at the top of a canvas of their own.
  function copyRows(c, copy, y, h) {
    copy ||= c.ownerDocument.createElement("canvas");
    if (copy.width !== c.width) copy.width = c.width;
    if (copy.height < h) copy.height = h;
    const g = copy.getContext("2d"); g.globalCompositeOperation = "copy"; g.drawImage(c, 0, y, c.width, h, 0, 0, c.width, h);
    return copy;
  }
  // Only move the overlay's pixels. The canvas itself receives pointer events and its
  // bounding rectangle is the coordinate system for every editor tool.
  function moveOverlay(I, st, k, tx, ty) {
    const c = I.canvas;
    st.overlayCopy ||= copyCanvas(c);
    const g = I.ctx;
    g.save(); g.setTransform(k, 0, 0, k, tx, ty);
    g.globalAlpha = 1; g.globalCompositeOperation = "copy";
    g.drawImage(st.overlayCopy, 0, 0); g.restore();
  }
  // canvas.js render() hook: true when this frame was drawn here.
  // gesture: canvas.js says only the camera moved since the last frame (pan, wheel or pinch zoom).
  function render(I, doc, defs, opts, gesture, frame) {
    // Editor frames only (the active pane's carry reuseBase, the other split pane's editorPane): print, PDF,
    // diff, previews and thumbnails stay on the 2D renderer.
    if (!visible()) return false;
    if (doc.kind !== "pcb" || !opts || !("reuseBase" in opts || opts.editorPane)) {
      cancelPreparation(I);
      if (views.has(I)) hide(I);
      return false;
    }
    const choice = decision(!failed && force == null);
    if (!wanted(choice)) { cancelPreparation(I); hide(I); return false; }
    // Power and strictness are set when the context is created.
    const current = views.get(I), strict = force !== true && choice?.mode !== "gpu";
    if (current && (current.powerPreference !== (choice?.powerPreference || "low-power") || current.strict !== strict)) destroy(I);
    // Views whose canvas left the page (a closed split pane) give their context and idle job back.
    for (const V of views.keys()) if (V !== I && !V.canvas?.isConnected) destroy(V);
    for (const V of preparing.keys()) if (V !== I && !V.canvas?.isConnected) cancelPreparation(V);
    const queued = preparing.get(I);
    if (queued && queued.doc !== doc) cancelPreparation(I);
    // The 2D renderer keeps drawing until GPU preparation can use a quiet interval.
    // Exact renders (noReuse: tests, benchmarks) build at once.
    if (!views.has(I) && !opts.noReuse) {
      if (!preparing.has(I)) {
        const host = G.AtriumNavHost, idle = G.AtriumIdle;
        const active = () => {
          if (!visible() || !I.canvas?.isConnected || I.cache?.doc !== doc || !wanted()) return false;
          const panes = host?.panes?.();
          return !panes || panes.some(p => p.canvas === I.canvas && p.docId === (I.cache?.panel?.root.id ?? doc.id));
        };
        const queue = () => {
          const id = idle ? idle.idle(prepare) : setTimeout(prepare, 0);
          preparing.set(I, {doc, cancel: idle ? () => idle.cancel(id) : () => clearTimeout(id)});
        };
        const prepare = deadline => {
          preparing.delete(I);
          if (!active()) return;
          const folder = host?.folderProject?.();
          // Do not keep requesting idle callbacks while the native writer runs.
          if (folder?.pendingWrites > 0) {
            const isCurrent = () => active() && host.folderProject() === folder;
            const offSave = folder.on(event => {
              if (event !== "saving" || folder.pendingWrites > 0) return;
              cancelPreparation(I);
              if (isCurrent()) queue();
            });
            const checkPane = () => { if (!isCurrent()) cancelPreparation(I); };
            const offPane = ["document", "panes", "replace"].map(event => host.on?.(event, checkPane));
            preparing.set(I, {doc, cancel() { offSave(); for (const off of offPane) off?.(); }});
            return;
          }
          // A deadline can expire during input. Wait for a real idle interval.
          if (deadline?.didTimeout) { queue(); return; }
          try { const s = state(I, choice); if (s) update(s, I.sync(doc, defs), opts.layer || "Top", !!opts.transientGeometry); } catch {}
          repaint(I);
        };
        queue();
      }
      return false;
    }
    if (preparing.has(I)) cancelPreparation(I);
    const st = state(I, choice);
    if (!st) { hide(I); return false; }
    const recorder = G.AtriumDiagnostics?.performance;
    const stages = recorder?.rendererStages ? recorder : null;
    try {
      const t0 = now(), cam = I.cam(), [, , , , width, height] = cam;
      if (!width || !height) return false;
      st.commandEpoch++;
      st.stats.coverageUpload = 0;
      const c = I.sync(doc, defs), active = opts.layer || "Top";
      const cap = capBytes(), w = I.canvas.width, h = I.canvas.height, backing = w * h * 4, transient = !!opts.transientGeometry;
      if (!retryMemory(st, c, cap, w, h, t0, transient)) return false;
      if (cap !== st.checkedCap) st.checkMemory = true;
      if (w > st.maxW || h > st.maxH) return rejectMemory(I, st, doc, "the viewport exceeds the WebGL backing limit", "viewport");
      if (backing > cap) return rejectMemory(I, st, doc, memoryLimit(backing, cap), "viewport");
      if (!place(I, st, width, height)) return rejectMemory(I, st, doc, "the GPU could not allocate the viewport backing", "driver");
      update(st, c, active, transient);
      if (!memory(I, st, doc)) return false;
      // A camera-only frame can move the retained text bands and world overlay
      // with the live GPU scene when their pixels cover the new camera.
      frame ||= I.pourFrame(doc, defs, opts);
      const E = st.exact, T = st.text, list = frame.pours, [cx, cy, scale, flipped, , , dpr] = cam;
      // A completed wheel glide knows its final camera. Other gestures settle after 140 ms of stillness.
      // Present the retained frame first, then sharpen its text in cancellable slices.
      let settling = (st.settling || gesture === "wheel-end") && !opts.noReuse; st.settling = false;
      if (settling && E && E.cx === cx && E.cy === cy && E.scale === scale && !(T.valid && (T.valid[0] || T.valid[1]))) settling = false;
      // An overlay-only repaint can reuse the pending camera. Artwork or visibility changes need a fresh draw.
      const pending = !gesture && !settling && opts.reuseBase && st.textJob?.at === cam.join() && !opts.noReuse;
      // A moving or settling camera owns these refreshes. Its last completed wide copy is still usable.
      if ((gesture || settling || pending) && (st.wideJob || st.wideText)) cancelWide(st);
      if ((gesture || settling || pending) && E && E.doc === doc && E.rev === c.rev && E.flipped === flipped && E.width === width && E.height === height && E.dpr === dpr && E.pourList === list &&
        (!T.pours || T.pours === list) && !opts.noReuse) {
        st.stats.gestureScale = 1;
        // A pan at the exact frame's scale: its layers moved by whole device pixels, the uncovered strips drawn.
        if (scale === E.scale) {
          const f = flipped ? -1 : 1, X = Math.round(f * (E.cx - cx) * scale * dpr), Y = Math.round((E.cy - cy) * scale * dpr);
          const hasText = T.bands?.length && T.key && !T.empty, t1 = now();
          const textReady = !hasText || scrollText(I, st, doc, defs, opts, T, X, Y);
          const textEnd = stages && hasText && textReady ? now() : t1;
          if (textReady && scrollOverlay(I, st, doc, defs, opts, E, X, Y, frame)) {
            const overlayEnd = stages ? now() : 0;
            draw(I, st, doc, defs, opts, cam, c, hasText ? {bands: T.bands, exact: T.exact, pours: T.pours, xf: [1, X, Y], wrap: true} : null, list);
            const drawEnd = stages ? now() : 0;
            if (!memory(I, st, doc)) return false;
            afterMove(I, st, doc, defs, opts, list, settling, gesture);
            const a = st.stats.acc; a.n++; a.gesture++; a.update += t1 - t0; a.gl += now() - t1;
            if (stages) {
              if (hasText) stages.renderStage("retained-pan-text", textEnd - t1);
              stages.renderStage("retained-pan-overlay", overlayEnd - textEnd);
              stages.renderStage("retained-pan-draw", drawEnd - overlayEnd);
            }
            return true;
          }
        }
        releaseCanvas(st, "stripLarge");
        // The top layer is repainted or moved from its copy below: a later pan starts it afresh.
        st.ovAt = null;
        // Both the exact and wide rasters have finite camera bounds. A panned
        // band is stored modulo the texture size and cannot be scaled this way.
        let L = {...E, text: T, overlay: st.overlayWorld};
        const artworkBounds = !st.overlayWorld && !T.pours && !T.planning && c.bounds;
        if (T.bands?.length && T.key && !T.empty || st.overlayWorld) {
          if (T.valid?.some(Boolean) || !covers(E, cx, cy, scale, flipped, width, height, artworkBounds)) L = null;
          const wide = st.wide;
          // Among complete sources, use the pixel density closest to the
          // live camera. Resampling screen-sized strokes can erase a dash.
          if (wide && (!L || Math.abs(wide.scale - scale) < Math.abs(E.scale - scale)) &&
              wideFits(st, E, doc, c.rev, list) &&
              covers(wide, cx, cy, scale, flipped, width, height, !wide.text.pours && artworkBounds)) L = wide;
        }
        if (L) {
          const k = scale / L.scale, f = flipped ? -1 : 1, LT = L.text;
          st.stats.gestureScale = k;
          const tx = width / 2 * (1 - k) + f * (L.cx - cx) * scale, ty = height / 2 * (1 - k) + (L.cy - cy) * scale;
          const t1 = now();
          draw(I, st, doc, defs, opts, cam, c, LT.bands?.length && LT.key && !LT.empty ? {bands: LT.bands, exact: LT.exact, pours: LT.pours, xf: [k, tx * dpr, ty * dpr]} : null, list);
          const drawEnd = stages ? now() : 0;
          if (!memory(I, st, doc)) return false;
          const overlayStart = stages ? now() : 0;
          if (k === 1 && L.text === T && !E.exactWires) moveOverlay(I, st, k, tx * dpr, ty * dpr);
          else {
            // Repaint the active layer's world overlay before minification
            // makes its screen-width strokes subpixel. Keep the bands intact.
            const g = I.ctx, fresh = L.overlay && st.overlayV?.top && !LT.exact?.has(active) && k * dpr < 1;
            g.save(); g.setTransform(k, 0, 0, k, tx * dpr, ty * dpr); g.globalAlpha = 1; g.globalCompositeOperation = "copy";
            if (L.overlay && !fresh) g.drawImage(L.overlay, 0, 0); else { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, I.canvas.width, I.canvas.height); }
            g.restore();
            if (fresh) overlayWorld(I, st, doc, defs, opts, cam, {...st.overlayV, viewport: I.artworkViewport()}, true, LT);
            I.boardTransform(); overlayTop(I, doc, defs, opts, null, undefined, null, frame);
          }
          const overlayEnd = stages ? now() : 0;
          afterMove(I, st, doc, defs, opts, list, settling, gesture);
          const a = st.stats.acc; a.n++; a.gesture++; a.update += t1 - t0; a.gl += now() - t1;
          if (stages) {
            // When a same-scale strip is abandoned, the general retained path can still copy pixels.
            const sameScale = scale === E.scale;
            stages.renderStage(sameScale ? "retained-copy-draw" : "retained-zoom-draw", drawEnd - t1);
            stages.renderStage(sameScale ? "retained-copy-overlay" : "retained-zoom-overlay", overlayEnd - overlayStart);
          }
          return true;
        }
        // Paint the live viewport when neither source covers it. Otherwise a
        // clipped band suppresses retained GPU artwork outside the old camera.
      }
      cancelSettle(st);
      if (E && E.pourList !== list) cancelSlices(st, "wideText");
      releaseOverlayCopy(st);
      const t1 = now(), V = scope(I, st, doc, defs, opts, cam, list), ta = now();
      const bandPaintBefore = stages ? st.stats.acc.board : 0;
      const textTiming = stages ? {occlusion:0, upload:0, readback:0} : null;
      const text = textLayer(I, st, doc, defs, opts, cam, V, list, st.text, null, textTiming), tb = now();
      const bandPaint = stages ? st.stats.acc.board - bandPaintBefore : 0;
      const coverageTiming = stages ? {paint:0, upload:0, readback:0} : null;
      const coverage = pourCoverage(I, st, doc, defs, opts, cam, V, list, text, c, coverageTiming), tc = now();
      if (!memory(I, st, doc)) return false;
      const showWires = opts.showUnrouted && !opts.transientGeometry;
      const wireStart = stages && showWires ? now() : 0;
      const result = showWires ? I.airwireConnectivity(doc, defs) ?? null : null;
      const exactWires = result?.airwires, hasWires = !!exactWires?.length;
      const drawStart = stages ? now() : 0;
      draw(I, st, doc, defs, opts, cam, c, text, list, coverage, result);
      const drawEnd = stages ? now() : 0;
      if (!memory(I, st, doc)) return false;
      const t2 = now();
      overlay(I, st, doc, defs, opts, cam, V, hasWires ? exactWires : null, frame);
      st.exact = {doc, rev: c.rev, cx: cam[0], cy: cam[1], scale: cam[2], flipped: cam[3], width, height, dpr: cam[6], exactWires:hasWires, pourList:list};
      // The first moving frame replaces the settled wires with WebGL strokes. Starting its
      // overlay afresh keeps the stationary wires out of the scrolling tool pixels.
      st.ovAt = hasWires ? null : [0, 0];
      scheduleWide(I, st, doc, defs, opts, list);
      const t3 = now(), a = st.stats.acc;
      st.stats.last = {update: t1 - t0, gl: t2 - t1, overlay: t3 - t2, scope: ta - t1, text: tb - ta, coverage: tc - tb};
      a.n++; a.update += t1 - t0; a.gl += t2 - t1; a.overlay += t3 - t2;
      if (stages) {
        stages.renderStage("full-scope", ta - t1);
        stages.renderStage("full-text", tb - ta);
        // The existing board painter counter is nested within textLayer here.
        stages.renderStage("full-band-paint", bandPaint);
        stages.renderStage("full-text-caption-occlusion", textTiming.occlusion);
        stages.renderStage("full-text-upload", textTiming.upload);
        stages.renderStage("full-text-readback", textTiming.readback);
        stages.renderStage("full-coverage", tc - tb);
        stages.renderStage("full-coverage-paint", coverageTiming.paint);
        stages.renderStage("full-coverage-upload", coverageTiming.upload);
        stages.renderStage("full-coverage-readback", coverageTiming.readback);
        stages.renderStage("full-airwires", showWires ? drawStart - wireStart : 0);
        stages.renderStage("full-draw", drawEnd - drawStart);
        stages.renderStage("full-overlay", t3 - t2);
      }
      return true;
    } catch (e) {
      if (st.gl.isContextLost()) { hide(I); return false; }
      G.console?.error?.("GPU board renderer off after an error:", e);
      failed = true; failReason = "an error in the GPU renderer: " + (e?.message || e);
      // A partial draw may have left stencil, scissor, or color writes in a temporary state.
      // If the renderer is retried, start with a fresh context and resources.
      destroy(I);
      return false;
    } finally {
      queueDriverMemoryProbe(I, st, doc);
    }
  }
  // What draws the board views and why: {renderer: "gpu" | "2d", reason, device, mode}.
  function status(I) {
    const d = decision() || {mode: "auto", use: false, reason: "", device: ""};
    const st = I ? views.get(I) : [...views.values()].find(s => s.shown) || views.values().next().value;
    const onScreen = visible();
    let reason = d.reason;
    if (!onScreen) reason = "the editor window is hidden";
    else if (failed) reason = failReason;
    else if (force === false) reason = "turned off for this session";
    else if (st?.off) reason = st.off;
    else if (st?.lost || st?.restoring) reason = "the WebGL context was lost; it is being restored";
    else if (st?.over) reason = st.over.reason;
    else if (!st && views.size >= MAX_VIEWS) reason = "more than " + MAX_VIEWS + " board views";
    const gpu = onScreen && wanted() && !st?.off && !st?.lost && !st?.restoring && !st?.over && (!!st?.shown || !st);
    return {renderer: gpu ? "gpu" : "2d", reason: gpu ? "" : reason, device: d.device || (onScreen && st ? stats(I)?.renderer : "") || "", mode: d.mode, forced: force};
  }
  // reset: restart the per-frame averages (acc: frames, and main-thread ms in update, GL calls, the 2D layer).
  function stats(I, reset) {
    const st = I ? views.get(I) : views.values().next().value;
    if (!st) return null;
    const a = st.stats.acc, f = v => +(v / a.n).toFixed(2);
    const avg = a.n ? {frames: a.n, update: f(a.update), gl: f(a.gl), overlay: f(a.overlay), board: f(a.board), text: f(a.text), textHits: a.textHits, gesture: a.gesture} : null;
    if (reset) {
      st.frameOffset = (st.frameOffset ?? 0) + a.n;
      st.retainedFrameOffset = (st.retainedFrameOffset ?? 0) + a.gesture;
      st.stats.acc = {n: 0, update: 0, gl: 0, overlay: 0, board: 0, text: 0, textHits: 0, gesture: 0};
    }
    let instances = 0, dead = 0, bytes = 0, layers = 0;
    if (st.scene) { layers = st.scene.layers.size; for (const b of bufs(st.scene)) { instances += b.n; dead += b.dead; bytes += b.f.byteLength + b.st.byteLength; } }
    return {...st.stats, acc: avg, exactAt: st.exact ? [st.exact.cx, st.exact.cy, st.exact.scale] : null, slicing: !!st.textJob || !!st.wideText, wideAt: st.wide ? st.wide.scale : null, instances, dead, instanceBytes: bytes, gpuBytes: bytesOf(st), backingBytes: backingBytes(st), layers, mode, parked: st.parked.size, lost: st.lost,
      renderer: (() => { try { const x = st.gl.getExtension("WEBGL_debug_renderer_info"); return x ? st.gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : st.gl.getParameter(st.gl.RENDERER); } catch { return ""; } })()};
  }
  function diagnosticRenderState(st) {
    return !visible() ? "paused" : failed ? "error" : st?.lost || st?.restoring ? "context-lost" :
      st?.over ? "memory-limit" : st?.off ? "disabled" : st?.shown ? "gpu" : "2d";
  }
  // Timing probes can read counters between draws without querying the driver.
  function resourceCounters(I) {
    I ??= views.keys().next().value;
    const st = views.get(I), s = st?.stats;
    if (!s) return null;
    const exact = st.exact, [cx, cy, scale, flipped, width, height, dpr] = I.cam();
    const exactCamera = !!exact && exact.doc === I.cache?.doc && exact.rev === I.cache?.rev &&
      exact.cx === cx && exact.cy === cy && exact.scale === scale && exact.flipped === flipped &&
      exact.width === width && exact.height === height && exact.dpr === dpr;
    const {pourUploads, pourUploadBytes, pourBytes, pourCacheBytes, pourCacheHits, coverageUpload, textUpload, wideBuilds,
      gridBufferAllocations, driverFenceSubmissions, driverMemoryChecks, driverMemoryCheckMs,
      textSliceRows, wideSliceRows, textSliceWorkMs, wideSliceWorkMs} = s;
    return {renderState:diagnosticRenderState(st), exactCamera, slicing:!!st.textJob || !!st.wideText,
      frames:(st.frameOffset ?? 0) + s.acc.n, retainedFrames:(st.retainedFrameOffset ?? 0) + s.acc.gesture,
      gestureScale:s.gestureScale ?? null, gridBufferAllocations, driverFenceSubmissions,
      pourUploads, pourUploadBytes, pourBytes, pourCacheBytes, pourCacheHits, driverMemoryChecks, driverMemoryCheckMs,
      textSliceRows, wideSliceRows, textSliceWorkMs, wideSliceWorkMs,
      coverageUpload:coverageUpload || 0, textUpload:textUpload || 0, wideBuilds:wideBuilds || 0};
  }
  // Shareable diagnostics read application state only. No driver, DOM readback, or render work.
  function diagnosticState(I) {
    const st = views.get(I);
    const state = diagnosticRenderState(st);
    return {state, contexts: views.size, warmupPending: preparing.size !== 0,
      losses: st?.losses ?? 0, activeBytes: st ? bytesOf(st) + backingBytes(st) : 0,
      parkedScenes: st?.parked.size ?? 0, work: st ? resourceCounters(I) : null};
  }
  // Forces the GPU to finish (benchmarks only: a readback stalls the pipeline).
  function finish(I) { const st = I ? views.get(I) : views.values().next().value; if (st && !st.lost) st.gl.readPixels(0, 0, 1, 1, st.gl.RGBA, st.gl.UNSIGNED_BYTE, new Uint8Array(4)); }
  // The two canvases composited, for pixel comparisons (benchmarks and tests), right after a render.
  function composite(I) {
    const [V, st] = I ? [I, views.get(I)] : [...views].find(([, s]) => s.shown) || [...views][0] || [];
    if (!st || !st.shown) return null;
    const c = G.document.createElement("canvas"); c.width = st.canvas.width; c.height = st.canvas.height;
    const g = c.getContext("2d"); g.drawImage(st.canvas, 0, 0); g.drawImage(V.canvas, 0, 0);
    return c;
  }
  // Drops every view's GPU state (benchmarks: the next frame is a first draw).
  function reset() {
    for (const I of preparing.keys()) cancelPreparation(I);
    for (const I of views.keys()) destroy(I);
  }
  // Tests: lose (and restore) a view's context as a driver reset would.
  function loseContext(I, restoreAfterMs) {
    const st = I ? views.get(I) : views.values().next().value, x = st?.gl.getExtension("WEBGL_lose_context");
    if (!x) return false;
    x.loseContext();
    if (restoreAfterMs != null) setTimeout(() => { try { x.restoreContext(); } catch {} }, restoreAfterMs);
    return true;
  }
  return Object.freeze({render, damage, stats, resourceCounters, diagnosticState, status, finish, composite, reset, release: destroy, refresh, pause, loseContext, overlays: () => overlays,
    hasView: I => views.has(I), enabled: () => wanted(), failed: () => failed,
    // enable(true / false) overrides the preference for this session (tests and benchmarks); enable(null) follows it again.
    enable(v) { failed = false; failReason = ""; force = v == null ? null : !!v; refresh(); },
    mode(m) { if (m === "journal" || m === "prints") { mode = m; for (const st of views.values()) { freeScene(st, st.scene); st.scene = null; for (const S of st.parked.values()) freeScene(st, S); st.parked.clear(); } } return mode; }});
})();
