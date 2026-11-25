// Waffle "Stack" - final geometry.
// A waffle slab, a copper foil and a green core, seen in a slightly turned
// (non-symmetric) dimetric view. All curves are cubic Beziers in plan space,
// projected point by point, so the output has no transforms and strokes stay true.
'use strict';

const f = n => +(+n).toFixed(2);

// Orthographic view: yaw ~37 deg, elevation 30 deg. Screen = origin + u*U + v*V - z.
const U = [0.40, 0.15], V = [-0.30, 0.20];
const K = 0.5523; // circle-to-cubic constant

function projector(ox, oy, P) {
  return ([u, v], dy = 0) => [ox + (U[0] * u + V[0] * v) * P / 1000, oy + dy + (U[1] * u + V[1] * v) * P / 1000];
}
// rounded rectangle in plan units as cubic segments
function rrSegs(x, y, w, h, r) {
  const k = r * K;
  return [
    ['M', [x + r, y]], ['L', [x + w - r, y]], ['C', [x + w - r + k, y], [x + w, y + r - k], [x + w, y + r]],
    ['L', [x + w, y + h - r]], ['C', [x + w, y + h - r + k], [x + w - r + k, y + h], [x + w - r, y + h]],
    ['L', [x + r, y + h]], ['C', [x + r - k, y + h], [x, y + h - r + k], [x, y + h - r]],
    ['L', [x, y + r]], ['C', [x, y + r - k], [x + r - k, y], [x + r, y]], ['Z'],
  ];
}
function circSegs(cx, cy, r) {
  const k = r * K;
  return [['M', [cx + r, cy]], ['C', [cx + r, cy + k], [cx + k, cy + r], [cx, cy + r]], ['C', [cx - k, cy + r], [cx - r, cy + k], [cx - r, cy]],
    ['C', [cx - r, cy - k], [cx - k, cy - r], [cx, cy - r]], ['C', [cx + k, cy - r], [cx + r, cy - k], [cx + r, cy]], ['Z']];
}
const toPath = (segs, pr, dy = 0) => segs.map(([c, ...pts]) => c + pts.map(p => pr(p, dy).map(f).join(' ')).join(' ')).join('');

// ---------------------------------------------------------------------------
// Parameters. Plan square is 0..1000; P scales the plan to screen.
// ---------------------------------------------------------------------------
const FULL = {
  P: 1000, R: 150, ox: 462, oy: 222,
  layers: [
    { kind: 'waffle', t: 92, gap: 20 },
    { kind: 'copper', t: 30, gap: 20 },
    { kind: 'core', t: 78, gap: 0, inner: [26, 52] },
  ],
  pockets: { n: 3, m: 140, g: 105, r: 34, depth: 24 },
  via: { u: 637.5, v: 637.5, r: 50, hole: 21 },
};
// 16-32 px: two chunky slabs, 2x2 pockets, no via or inner layers.
const SMALL = {
  P: 1360, R: 190, ox: 512 - 0.05 * 1360, oy: 96,
  layers: [
    { kind: 'waffle', t: 150, gap: 54 },
    { kind: 'core', t: 120, gap: 0 },
  ],
  pockets: { n: 2, m: 175, g: 170, r: 70, depth: 40 },
  via: null, chunky: true, knock: 60,
};
// Menu-bar template / symbolic icon: bigger holes and gaps so it survives 16 pt.
const TEMPLATE = {
  P: 1400, R: 210, ox: 512, oy: 96,
  layers: [
    { kind: 'waffle', t: 170, gap: 90 },
    { kind: 'core', t: 120, gap: 0 },
  ],
  pockets: { n: 2, m: 150, g: 130, r: 70, depth: 40 },
  via: null, chunky: true, knock: 90, sep: 44,
};

const COL = {
  waffle: { top: ['#FFD781', '#F3A93A'], left: '#DB8B22', right: '#B4650F', front: '#C97A19', bevel: '#FFE7AE' },
  copper: { top: ['#F7B27E', '#DC7A3E'], left: '#C9652C', right: '#8C4217', front: '#AA5322', bevel: '#FFD2B0' },
  core: { top: ['#4BA864', '#2E8540'], left: '#2A7A3B', right: '#184D24', front: '#21642F', bevel: '#86CF99' },
};

function slabGeom(G, layer, y0) {
  const pr = projector(G.ox, y0, G.P);
  const { R } = G;
  const top = toPath(rrSegs(0, 0, 1000, 1000, R), pr);
  const bot = toPath(rrSegs(0, 0, 1000, 1000, R), pr, layer.t);
  // screen-x extremes of the rounded square sit on the corner arcs
  const gx = [U[0], V[0]], n = Math.hypot(...gx), d = [gx[0] / n, gx[1] / n];
  const right = [1000 - R + R * d[0], R + R * d[1]];
  const left = [R - R * d[0], 1000 - R - R * d[1]];
  const L0 = pr(left), R0 = pr(right), L1 = pr(left, layer.t), R1 = pr(right, layer.t);
  const quad = `M${L0.map(f).join(' ')}L${R0.map(f).join(' ')}L${R1.map(f).join(' ')}L${L1.map(f).join(' ')}Z`;
  // the turn from the left face to the right face happens across the front corner arc
  const xa = pr([1000 - R, 1000])[0], xb = pr([1000, 1000 - R])[0];
  return { pr, top, bot, quad, left, right, xmin: L0[0], xmax: R0[0], xa, xb, y0 };
}

// ---------------------------------------------------------------------------
function build(G, { mono = false, flavour = null, id = 's' } = {}) {
  let y = G.oy;
  const geo = G.layers.map(l => { const g = slabGeom(G, l, y); y += l.t + l.gap; return { l, g }; });
  const defs = [];
  const out = [];
  const pk = G.pockets;
  const pocketSegs = [];
  const pp = (1000 - 2 * pk.m - (pk.n - 1) * pk.g) / pk.n;
  for (let i = 0; i < pk.n; i++) for (let j = 0; j < pk.n; j++) pocketSegs.push(rrSegs(pk.m + i * (pp + pk.g), pk.m + j * (pp + pk.g), pp, pp, pk.r));

  if (mono) {
    const m = [];
    geo.slice().reverse().forEach(({ l, g }, idx) => {
      const knock = idx > 0 ? (G.knock || 30) : 0;
      if (knock) for (const d of [g.bot, g.quad, g.top]) m.push(`<path d="${d}" fill="#000" stroke="#000" stroke-width="${knock}" stroke-linejoin="round"/>`);
      m.push(`<path d="${g.bot}" fill="#fff"/><path d="${g.quad}" fill="#fff"/>`);
      if (l.kind === 'waffle') m.push(`<path d="${g.top}" fill="#000" stroke="#000" stroke-width="${G.sep || (G.chunky ? 26 : 13)}"/>`);
      m.push(`<path d="${g.top}" fill="#fff"/>`);
      if (l.kind === 'waffle') {
        m.push(`<path d="${pocketSegs.map(s => toPath(s, g.pr)).join('')}" fill="#000"/>`);
        if (G.via) {
          const v = G.via;
          m.push(`<path d="${toPath(circSegs(v.u, v.v, v.r + 14), g.pr)}" fill="#000"/><path d="${toPath(circSegs(v.u, v.v, v.r), g.pr)}" fill="#fff"/>` +
            `<path d="${toPath(circSegs(v.u, v.v, v.hole), g.pr)}" fill="#000"/>`);
        }
      }
    });
    // top layer's own side/top separation was drawn above; cut the core top-face rim to keep faces readable
    return `<defs><mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#000"/>${m.join('')}</mask></defs>` +
      `<rect width="1024" height="1024" fill="currentColor" mask="url(#${id}m)"/>`;
  }

  defs.push(`<filter id="${id}B" x="-10%" y="-10%" width="120%" height="140%"><feGaussianBlur stdDeviation="${G.chunky ? 14 : 7}"/></filter>`);
  geo.slice().reverse().forEach(({ l, g }, ri) => {
    const above = geo[geo.length - 2 - ri];
    const c = COL[l.kind];
    const sid = `${id}${l.kind}`;
    const t0 = (g.xa - g.xmin) / (g.xmax - g.xmin), t1 = (g.xb - g.xmin) / (g.xmax - g.xmin);
    defs.push(`<linearGradient id="${sid}S" gradientUnits="userSpaceOnUse" x1="${f(g.xmin)}" y1="0" x2="${f(g.xmax)}" y2="0">` +
      `<stop offset="0" stop-color="${c.left}"/><stop offset="${f(t0)}" stop-color="${c.left}"/><stop offset="${f((t0 + t1) / 2)}" stop-color="${c.front}"/>` +
      `<stop offset="${f(t1)}" stop-color="${c.right}"/><stop offset="1" stop-color="${c.right}"/></linearGradient>`);
    defs.push(`<linearGradient id="${sid}T" gradientUnits="userSpaceOnUse" x1="0" y1="${f(g.y0)}" x2="0" y2="${f(g.y0 + 0.35 * G.P)}">` +
      `<stop offset="0" stop-color="${c.top[0]}"/><stop offset="1" stop-color="${c.top[1]}"/></linearGradient>`);
    out.push(`<path d="${g.bot}" fill="url(#${sid}S)"/><path d="${g.quad}" fill="url(#${sid}S)"/>`);
    if (l.inner) {
      // each inner layer is the front half of the outline, cut at the chord between its extremes
      defs.push(`<clipPath id="${sid}E"><path d="${g.bot}"/><path d="${g.quad}"/></clipPath>`);
      out.push(`<g clip-path="url(#${sid}E)">`);
      l.inner.forEach((k, n) => {
        const a = g.pr(g.left, k), b = g.pr(g.right, k);
        defs.push(`<clipPath id="${sid}D${n}"><path d="M${f(a[0] - 20)} ${f(a[1])}L${f(b[0] + 20)} ${f(b[1])}V${f(b[1] + 400)}H${f(a[0] - 20)}Z"/></clipPath>`);
        out.push(`<path clip-path="url(#${sid}D${n})" fill="none" stroke="#E98A4E" stroke-width="4.5" d="${toPath(rrSegs(0, 0, 1000, 1000, G.R), g.pr, k)}"/>`);
      });
      out.push('</g>');
    }
    out.push(`<path d="${g.top}" fill="url(#${sid}T)"/>`);
    // bevel: a light line along the top face's front edge
    defs.push(`<clipPath id="${sid}C"><path d="${g.top}"/></clipPath>`);
    out.push(`<path d="${g.top}" fill="none" stroke="${c.bevel}" stroke-opacity=".75" stroke-width="${G.chunky ? 22 : 9}" clip-path="url(#${sid}C)"/>`);
    if (above) {
      const sh = toPath(rrSegs(0, 0, 1000, 1000, G.R), above.g.pr, above.l.t + (G.chunky ? 14 : 7));
      const q = above.g.quad;
      out.push(`<g clip-path="url(#${sid}C)"><g filter="url(#${id}B)" opacity=".42"><path d="${sh}"/><path d="${q}" transform="translate(0 ${G.chunky ? 14 : 7})"/></g></g>`);
    }
    if (l.kind === 'waffle') {
      const open = pocketSegs.map(s => toPath(s, g.pr)).join('');
      const floor = pocketSegs.map(s => toPath(s, g.pr, pk.depth)).join('');
      defs.push(`<clipPath id="${id}P"><path d="${open}"/></clipPath>`);
      const fl = flavour ? flavour.pool : ['#8A4208', '#A65300'];
      const wall = flavour ? flavour.wall : ['#4E2302', '#7A3C05'];
      defs.push(`<linearGradient id="${id}W" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${wall[0]}"/><stop offset="1" stop-color="${wall[1]}"/></linearGradient>`);
      defs.push(`<linearGradient id="${id}F" gradientUnits="userSpaceOnUse" x1="0" y1="${f(g.y0)}" x2="0" y2="${f(g.y0 + 0.35 * G.P)}"><stop offset="0" stop-color="${fl[0]}"/><stop offset="1" stop-color="${fl[1]}"/></linearGradient>`);
      out.push(`<path d="${open}" fill="url(#${id}W)"/><g clip-path="url(#${id}P)"><path d="${floor}" fill="url(#${id}F)"/></g>`);
      if (flavour && G !== SMALL) {
        // a glossy glint on each pool: a short light arc near the far edge of the floor
        const gl = [];
        for (let i = 0; i < pk.n; i++) for (let j = 0; j < pk.n; j++) {
          const x = pk.m + i * (pp + pk.g), yy = pk.m + j * (pp + pk.g);
          gl.push(toPath(rrSegs(x + pp * 0.22, yy + pp * 0.2, pp * 0.42, pp * 0.14, pp * 0.07), g.pr, pk.depth));
        }
        out.push(`<g clip-path="url(#${id}P)"><path d="${gl.join('')}" fill="#fff" fill-opacity=".38"/></g>`);
      }
      if (G.via) {
        const v = G.via;
        const ring = flavour ? flavour.via : ['#FFFFFF', '#E7B77F'];
        defs.push(`<linearGradient id="${id}V" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ring[0]}"/><stop offset="1" stop-color="${ring[1]}"/></linearGradient>`);
        const hole = toPath(circSegs(v.u, v.v, v.hole), g.pr);
        defs.push(`<clipPath id="${id}H"><path d="${hole}"/></clipPath>`);
        out.push(`<path d="${toPath(circSegs(v.u, v.v, v.r), g.pr, 4)}" fill="#6E3304" fill-opacity=".45"/>` +
          `<path d="${toPath(circSegs(v.u, v.v, v.r), g.pr)}" fill="url(#${id}V)"/>` +
          `<path d="${hole}" fill="#C8763C"/><g clip-path="url(#${id}H)"><path d="${toPath(circSegs(v.u, v.v, v.hole), g.pr, 9)}" fill="#2A1404"/></g>`);
      }
    }
  });
  return `<defs>${defs.join('')}</defs>${out.join('')}`;
}

// Silhouette bounds (for centring and for the icon's contact shadow)
function bounds(G) {
  let y = G.oy, last;
  for (const l of G.layers) { last = slabGeom(G, l, y); y += l.t + l.gap; }
  const first = slabGeom(G, G.layers[0], G.oy);
  const lastL = G.layers[G.layers.length - 1];
  const front = last.pr([1000, 1000], lastL.t);
  return { x0: first.xmin, x1: first.xmax, y0: G.oy, y1: front[1] };
}

module.exports = { TEMPLATE, FULL, SMALL, build, bounds, COL, projector, rrSegs, circSegs, toPath };

// Shift a parameter set so its silhouette is centred on the 1024 canvas.
function centred(G, cy = 512) {
  const b = bounds(G);
  return { ...G, ox: G.ox + (512 - (b.x0 + b.x1) / 2), oy: G.oy + (cy - (b.y0 + b.y1) / 2) };
}
module.exports.centred = centred;
