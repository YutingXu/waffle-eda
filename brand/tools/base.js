// Shared helpers for the brand build: number formatting, the continuous-corner
// macOS plate, SVG wrapper and gradients. (Self-contained; no other dependencies.)
'use strict';
const f = n => +(+n).toFixed(2);
function squircle(x, y, size, R, s = 0.6) {
  const p = (1 + s) * R;
  const arcMeasure = 90 * (1 - s);
  const rad = d => d * Math.PI / 180;
  const arc = Math.sin(rad(arcMeasure / 2)) * R * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p34 = R * Math.tan(rad(alpha / 2));
  const beta = 45 * s;
  const c = p34 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const W = size, H = size;
  const q = v => f(v);
  return `M${q(x + W - p)} ${q(y)}` +
    `c${q(a)} 0 ${q(a + b)} 0 ${q(a + b + c)} ${q(d)}a${q(R)} ${q(R)} 0 0 1 ${q(arc)} ${q(arc)}c${q(d)} ${q(c)} ${q(d)} ${q(b + c)} ${q(d)} ${q(a + b + c)}` +
    `L${q(x + W)} ${q(y + H - p)}` +
    `c0 ${q(a)} 0 ${q(a + b)} ${q(-d)} ${q(a + b + c)}a${q(R)} ${q(R)} 0 0 1 ${q(-arc)} ${q(arc)}c${q(-c)} ${q(d)} ${q(-(b + c))} ${q(d)} ${q(-(a + b + c))} ${q(d)}` +
    `L${q(x + p)} ${q(y + H)}` +
    `c${q(-a)} 0 ${q(-(a + b))} 0 ${q(-(a + b + c))} ${q(-d)}a${q(R)} ${q(R)} 0 0 1 ${q(-arc)} ${q(-arc)}c${q(-d)} ${q(-c)} ${q(-d)} ${q(-(b + c))} ${q(-d)} ${q(-(a + b + c))}` +
    `L${q(x)} ${q(y + p)}` +
    `c0 ${q(-a)} 0 ${q(-(a + b))} ${q(d)} ${q(-(a + b + c))}a${q(R)} ${q(R)} 0 0 1 ${q(arc)} ${q(-arc)}c${q(c)} ${q(-d)} ${q(b + c)} ${q(-d)} ${q(a + b + c)} ${q(-d)}Z`;
}

function svg(size, inner, { vb, title } = {}) {
  vb = vb || `0 0 ${size} ${size}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}">` +
    (title ? `<title>${title}</title>` : '') + inner + `</svg>\n`;
}
const grad = (id, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
  stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a != null ? ` stop-opacity="${a}"` : ''}/>`).join('') +
  `</linearGradient>`;


const SQ = squircle(100, 100, 824, 186, 0.6);

function plate({ defs = '', base, content = '', overlay = true }) {
  const d = `<defs>
<filter id="sh" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/></filter>
<filter id="sh2" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.18"/></filter>
<clipPath id="pl"><path d="${SQ}"/></clipPath>
${grad('gl', [[0, '#fff', 0.20], [0.42, '#fff', 0], [0.75, '#000', 0], [1, '#000', 0.10]])}
${grad('ed', [[0, '#fff', 0.55], [0.18, '#fff', 0.0], [0.85, '#000', 0], [1, '#000', 0.22]])}
${defs}</defs>`;
  return svg(1024, d +
    `<g filter="url(#sh)"><path d="${SQ}" fill="${base}"/></g>` +
    `<g clip-path="url(#pl)">${content}` +
    (overlay ? `<path d="${SQ}" fill="url(#gl)"/><path d="${SQ}" fill="none" stroke="url(#ed)" stroke-width="7"/>` : '') +
    `</g>`, { title: 'Waffle' });
}


module.exports = { f, squircle, svg, grad, SQ, plate };
