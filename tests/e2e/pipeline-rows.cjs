"use strict";
// Neutral comparison rows shared by the end-to-end oracles and the pipeline. Frame: mm, Y down,
// angles clockwise-positive on screen (Waffle's model frame). No app code is used here.
// Tolerances. Coordinates: the coarser of the two files' resolutions (Altium 0.0254 µm,
// KiCad 1 nm, Waffle 0.1 µm rounding) with margin. Plots: the shipped protocol's pixel grid.
const TOL = {mm:0.002, deg:0.05, xorCopperMm2:0.25, xorRenderMm2:0.5, xorMaskMm2:0.25, drillMm:0.005, placeMm:0.01, rotDeg:0.1, profileMm:0.01};
const mod = (a, m) => ((a % m) + m) % m;

// Canonical pad face: shapes that are geometrically equal compare equal. Angles in the
// Waffle frame (Y down, so the negative of a Y-up source angle).
function face(shape, w, h, angle, radius) {
  if (!(w > 0 && h > 0)) return null;
  const small = Math.min(w, h) / 2;
  if (shape === "roundrect" || shape === "chamfrect") {
    if (radius <= 1e-4) shape = "rect";
    else if (radius >= small - 1e-4) shape = "round";
  }
  if (shape === "oval" || shape === "obround") shape = "round";
  if (shape === "round" || shape === "circle") {
    if (Math.abs(w - h) <= 1e-4) return {shape:"circle", w, h:w, angle:0, radius:w / 2};
    shape = "oblong"; radius = small;
  }
  if (shape === "rect") radius = 0;
  let a = angle;
  if (w < h) { [w, h] = [h, w]; a += 90; }
  const period = Math.abs(w - h) <= 1e-4 && shape !== "octagonal" ? 90 : 180;
  a = mod(a, period);
  if (a > period - TOL.deg) a -= period;
  return {shape, w, h, angle:a, radius:radius || 0};
}
// Copper area of a canonical face; custom outlines pass their polygon area.
function faceArea(f) {
  if (f.shape === "circle") return Math.PI * f.radius * f.radius;
  if (f.shape === "oblong") return f.w * f.h - (4 - Math.PI) * f.radius * f.radius;
  if (f.shape === "roundrect") return f.w * f.h - (4 - Math.PI) * f.radius * f.radius;
  if (f.shape === "octagonal") { const c = Math.min(f.w, f.h) / 4; return f.w * f.h - 2 * c * c; }
  return f.w * f.h;
}
function faceRow(faceName, f, x, y, drill, ref, area) {
  return {cat:faceName + "|" + f.shape, area:area ?? faceArea(f), v:[x, y, f.w, f.h, f.radius, f.angle, drill || 0],
    tol:[TOL.mm, TOL.mm, TOL.mm, TOL.mm, TOL.mm, TOL.deg, TOL.mm], ref};
}
function segRow(layer, a, b, width, net, ref) {
  return {cat:layer, v:[a[0], a[1], b[0], b[1], width], alt:[b[0], b[1], a[0], a[1], width],
    tol:[TOL.mm, TOL.mm, TOL.mm, TOL.mm, TOL.mm], net, ref};
}
// An arc as centre, radius, width, |sweep| and its midpoint (direction independent), plus endpoints.
function arcRow(layer, c, r, width, sweep, p0, p1, mid, net, ref) {
  const full = Math.abs(sweep) >= 360 - TOL.deg;
  const ends = full ? [0, 0, 0, 0] : [...p0, ...p1], swapped = full ? ends : [...p1, ...p0];
  const m = full ? [0, 0] : mid;
  return {cat:layer, geom:{c, r, width, p0, p1, mid, full}, v:[c[0], c[1], r, width, Math.abs(sweep), ...m, ...ends], alt:[c[0], c[1], r, width, Math.abs(sweep), ...m, ...swapped],
    tol:[TOL.mm, TOL.mm, TOL.mm, TOL.mm, TOL.deg * 2, TOL.mm * 2, TOL.mm * 2, TOL.mm * 2, TOL.mm * 2, TOL.mm * 2, TOL.mm * 2], net, ref};
}

module.exports = {TOL, face, faceRow, segRow, arcRow, mod};
