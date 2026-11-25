// Lowercase "waffle", a plain geometric sans drawn from lines, arcs and one clip.
// Units: x-height band is y 0..100 on the stroke centre line, stroke 22, so the
// outer x-height runs -11..111; ascenders reach -110; round letters overshoot ~3.
'use strict';
const f = n => +(+n).toFixed(2);
const SW = 22, H = SW / 2;

function glyphs() {
  const parts = [];      // stroked centre-line paths
  let x = 0;             // running left edge (outer)
  const sp = 24;         // gap between outer edges
  // w: four strokes; tips and terminals are cut flat by the clip band.
  {
    const a = x + 13, step = 27, ext = 0.3;
    const pts = [[a, 0], [a + step, 100], [a + 2 * step, 0], [a + 3 * step, 100], [a + 4 * step, 0]];
    const dx = step * ext;
    parts.push({ d: `M${f(pts[0][0] - dx)} -30L${pts.slice(1, 4).map(p => p.join(' ')).join('L')}L${f(pts[4][0] + dx)} -30`, clip: true, join: 'miter' });
    x = a + 4 * step + 13 + sp;
  }
  // a: single-storey; bowl plus stem.
  {
    const r = 52, cx = x + H + r;
    parts.push({ d: `M${cx + r} 50A${r} ${r} 0 1 1 ${cx - r} 50A${r} ${r} 0 1 1 ${cx + r} 50Z` });
    parts.push({ d: `M${cx + r} -11V111`, cap: 'butt' });
    x = cx + r + H + sp;
  }
  // ff: two stems with hooks, one shared crossbar.
  {
    const s1 = x + 30, s2 = s1 + 64, hr = 34;
    for (const s of [s1, s2]) parts.push({ d: `M${s} 111V${-110 + H + hr}A${hr} ${hr} 0 0 1 ${s + hr} ${-110 + H}H${s + hr + 12}`, cap: 'butt' });
    parts.push({ d: `M${x} 0H${s2 + 40}`, cap: 'butt' });
    x = s2 + hr + 12 + sp - 4;
  }
  // l
  { const s = x + H; parts.push({ d: `M${s} -110V111`, cap: 'butt' }); x = s + H + sp; }
  // e: bar, then the bowl swept anticlockwise to an open terminal.
  {
    const r = 52, cx = x + H + r, a = 38 * Math.PI / 180;
    parts.push({ d: `M${cx - r} 50H${cx + r}A${r} ${r} 0 1 0 ${f(cx + r * Math.cos(a))} ${f(50 + r * Math.sin(a))}`, cap: 'butt' });
    x = cx + r + H;
  }
  return { parts, width: x };
}

// "EDA" in small capitals of the same construction: lighter stroke (13 vs 22),
// cap height equal to the x-height (flat tops on -11 and 111), the A's apex
// overshooting by 3 like the round lowercase letters, wider tracking.
const ES = 13, EH = ES / 2;
function edaGlyphs(x0) {
  const parts = [];
  const yt = -11 + EH, yb = 111 - EH;
  let x = x0;
  { const s = x + EH, w = 64; // E
    parts.push({ d: `M${s} -11V111M${s} ${yt}H${s + w}M${s} 50H${s + w - 8}M${s} ${yb}H${s + w}` }); x = s + w + 20; }
  { const s = x + EH, st = 22, r = (yb - yt) / 2; // D
    parts.push({ d: `M${s} -11V111M${s} ${yt}H${s + st}A${r} ${r} 0 0 1 ${s + st} ${yb}H${s}` }); x = s + st + r + EH + 18; }
  { const half = 46, ext = 20, apex = -20; // A: miter apex cut flat by the clip at -14
    const foot = half * (111 + ext - 111) / (111 + ext - apex);
    const ax = x + (half - foot) + ES * 0.55;
    const bar = 64, bx = half * (111 + ext - bar) / (111 + ext - apex);
    parts.push({ d: `M${f(ax - half)} ${111 + ext}L${ax} ${apex}L${f(ax + half)} ${111 + ext}`, clip: 'a', join: 'miter' });
    parts.push({ d: `M${f(ax - bx)} ${bar}H${f(ax + bx)}` });
    x = ax + (half - foot) + ES * 0.55; }
  return { parts, width: x };
}

// Returns inner SVG markup in wordmark units, plus bounds. opts.eda appends "EDA".
function wordmarkInner(color, id = 'wm', { eda = false } = {}) {
  const { parts, width } = glyphs();
  const clip = `<clipPath id="${id}c"><rect x="-40" y="-11" width="300" height="122"/></clipPath>`;
  const body = parts.map(p => `<path d="${p.d}" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="${p.cap || 'butt'}" stroke-linejoin="${p.join || 'round'}" stroke-miterlimit="10"${p.clip ? ` clip-path="url(#${id}c)"` : ''}/>`).join('');
  if (!eda) return { svg: `<defs>${clip}</defs>${body}`, x0: 0, x1: width, y0: -110, y1: 114 };
  const e = edaGlyphs(width + 52);
  const clipA = `<clipPath id="${id}a"><rect x="${f(e.width - 140)}" y="-14" width="160" height="125"/></clipPath>`;
  const ebody = e.parts.map(p => `<path d="${p.d}" fill="none" stroke="${color}" stroke-width="${ES}" stroke-linecap="butt" stroke-linejoin="${p.join || 'miter'}" stroke-miterlimit="12"${p.clip ? ` clip-path="url(#${id}a)"` : ''}/>`).join('');
  return { svg: `<defs>${clip}${clipA}</defs>${body}${ebody}`, x0: 0, x1: e.width, y0: -110, y1: 114 };
}
function wordmarkSVG(color = '#2A1D07', height = 160, { eda = false } = {}) {
  const w = wordmarkInner(color, 'wm', { eda });
  const pad = 4;
  const vb = [w.x0 - pad, w.y0 - pad, w.x1 - w.x0 + 2 * pad, w.y1 - w.y0 + 2 * pad];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${f(vb[2] / vb[3] * height)}" height="${height}"><title>${eda ? 'Waffle EDA' : 'waffle'}</title>${w.svg}</svg>\n`;
}
module.exports = { wordmarkInner, wordmarkSVG, glyphs, SW };
