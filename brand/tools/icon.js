// macOS icon for the final Stack mark, on the shared 824 pt plate.
'use strict';
const I = require('./base');
const M = require('./base');
const S = require('./stack');

const PLATES = {
  cream: { base: '#F3E9D8', g: [['0', '#FFFBF3'], ['1', '#EADBC2']] },
  cocoa: { base: '#2A211B', g: [['0', '#43362C'], ['1', '#1A1410']] },
};
// art: stack inner markup (1024 space); placed through a nested svg (no transforms)
function icon({ plate = 'cream', flavour = null, small = false, id = 'i' } = {}) {
  const P = PLATES[plate];
  const G = S.centred(small ? S.SMALL : S.FULL, 512);
  const art = S.build(G, { flavour, id: id + 'a' });
  const b = S.bounds(G);
  const size = small ? 790 : 860;                    // art box inside the plate's safe area
  const x = 512 - size / 2, y = 512 - size / 2 + (small ? 0 : 6);
  const sy = y + (b.y1 / 1024) * size;               // stack's front-bottom point
  const shadow = `<ellipse cx="512" cy="${(sy - 10).toFixed(1)}" rx="${(size * 0.30).toFixed(1)}" ry="${(size * 0.055).toFixed(1)}" fill="#000" opacity="${plate === 'cream' ? 0.22 : 0.5}" filter="url(#${id}cs)"/>`;
  const content = `<path d="${I.SQ}" fill="url(#${id}pg)"/>${shadow}` +
    `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 1024 1024">${art}</svg>`;
  const defs = M.grad(id + 'pg', P.g.map(([o, c]) => [o, c])) +
    `<filter id="${id}cs" x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="18"/></filter>`;
  return I.plate({ defs, base: P.base, content });
}
module.exports = { icon, PLATES };
