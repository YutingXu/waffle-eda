//! Polygon pour boolean core: a line-for-line port of `PourCore().solve` in
//! app/polygon-pour.js (planarize, merge, classify, trace, islands, dead copper).
//!
//! The JS core is an exact integer overlay over coordinates of at most 2^24, computed in
//! doubles. This port does every step in the same order with the same f64 operations
//! (no fused multiply-add, the same rounding, the same stable sorts and first-seen
//! numbering), so its islands are identical to the JS ones, not merely close. Inputs outside
//! the JS core's own limits are refused and the JS core runs instead.

use core::cmp::Ordering;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Largest |coordinate| (the JS builds rings within 1.6e7; vertex keys need < 2^25).
pub const MAX_COORD: f64 = 16_777_216.0;
pub const MAX_EDGES: usize = 8_000_000;
pub const MAX_CLASSES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    /// Valid, but outside what this port reproduces exactly (or out of memory).
    Fallback,
}

pub struct Shape<'a> {
    pub cls: u32,
    pub sign: f64,
    pub ring: &'a [i32],
    pub tags: Option<&'a [i32]>,
}

pub struct Task<'a> {
    pub shapes: Vec<Shape<'a>>,
    pub k: usize,
    pub has_board: bool,
    pub anchors: Vec<&'a [i32]>,
    pub remove_dead: bool,
    pub min_area: f64,
    pub min_size: f64,
    /// Remove Necks (mode 1) or Outlines Only (mode 2) on the copper before the island tests.
    pub morph: Option<Morph<'a>>,
}

/// `task.morph` of the JS core (polygon-pour.js `shapeIslands`): the template `t` (a convex,
/// origin-symmetric, counter-clockwise polygon), its grown copy `u` (mode 1) and the rings that
/// are never removed (`keep`, counter-clockwise).
pub struct Morph<'a> {
    pub mode: u32,
    pub t: &'a [i32],
    pub u: &'a [i32],
    pub keep: Vec<&'a [i32]>,
}

#[derive(Default, Debug, Clone, PartialEq)]
pub struct Stats {
    pub passes: u32,
    pub unresolved: bool,
    pub edges: u32,
    pub merged: u32,
    /// Set by the face walk (absent in JS when it did not finish).
    pub faces: Option<u32>,
    pub rays: Option<u32>,
    pub face_fallback: bool,
    pub broken_rings: u32,
    pub dead_islands: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ring {
    pub ring: Vec<i32>,
    pub tags: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Island {
    pub ring: Ring,
    pub links: Vec<u32>,
    pub holes: Vec<Ring>,
}

// ---------------------------------------------------------------- helpers

/// A small multiplicative hasher for integer keys (no dependency, no DoS concern: the
/// keys are coordinates and indices, and the worst case is only slower).
#[derive(Default)]
struct Mix(u64);
impl Hasher for Mix {
    fn finish(&self) -> u64 { let h = self.0; h ^ (h >> 29) }
    fn write(&mut self, bytes: &[u8]) { for &b in bytes { self.write_u64(b as u64); } }
    fn write_u64(&mut self, v: u64) { self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x9e37_79b9_7f4a_7c15); }
    fn write_i64(&mut self, v: i64) { self.write_u64(v as u64); }
    fn write_u32(&mut self, v: u32) { self.write_u64(v as u64); }
}
type Map<K, V> = HashMap<K, V, BuildHasherDefault<Mix>>;

#[inline]
fn orient(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

fn strictly_on(ax: f64, ay: f64, bx: f64, by: f64, px: f64, py: f64) -> bool {
    if (px == ax && py == ay) || (px == bx && py == by) {
        return false;
    }
    (px - ax) * (bx - ax) + (py - ay) * (by - ay) > 0.0 && (px - bx) * (ax - bx) + (py - by) * (ay - by) > 0.0
}

/// JS `Math.round`: the nearest integer, ties toward +infinity.
#[inline]
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// JS `Math.max` / `Math.min` of two numbers (NaN wins, -0 < +0).
#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else if a == b { if a.is_sign_negative() { b } else { a } } else if a > b { a } else { b }
}
#[inline]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else if a == b { if a.is_sign_negative() { a } else { b } } else if a < b { a } else { b }
}

/// JS ToInt32 (Int32Array stores).
#[inline]
fn to_i32(v: f64) -> i32 {
    if !v.is_finite() { return 0; }
    let t = v.trunc();
    (t.rem_euclid(4_294_967_296.0) as u32) as i32
}

/// Vertex key, as the JS `(x+OFF)*SPAN+(y+OFF)` for in-range integers (-0 equals 0).
#[inline]
fn vkey(x: f64, y: f64) -> (i64, i64) { (x as i64, y as i64) }

// ---------------------------------------------------------------- vector lanes
//
// Two loops of a dense pour gain from WebAssembly SIMD: the bounding-box test of each
// candidate pair in the intersection grid, and the point-in-ring test that places holes and
// links anchors. Their "blocked" forms test four candidates (four ring edges) per step with
// exact integer lanes, then run the unchanged scalar body, in the same order, for the ones that
// pass, so the result is the scalar loops', bit for bit. (The ray cast that seeds each face's
// winding was tried too, with i64x2 orientation products: gathering each column's coordinates
// cost what the lanes saved, so it stays scalar.)
//
// Every lane test is exact: the coordinates are integers of at most 2^24 (`validate`), so a
// bounding-box test is an i32 comparison and the point-in-ring filter compares i32 heights; the
// pairs and edges they keep run the scalar f64 body. No reduced-precision (f32) arithmetic
// decides anything: f32 holds integers only to 2^24 and products not at all, and f32x4 has no
// more lanes than i32x4.
//
// `lanes` is core::arch::wasm32 simd128 in the SIMD build of the module (scripts/build-engine.py
// builds an MVP module and a simd128 one; engine/bridge.js picks one at run time) and a
// plain-Rust model of the same lanes elsewhere, so `cargo test` checks the blocked loops against
// the scalar ones on the host. The MVP module runs the scalar loops only.

/// Whether `solve` uses the blocked loops: only where they are vector instructions.
pub const BLOCKED: bool = cfg!(all(target_arch = "wasm32", target_feature = "simd128"));

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod lanes {
    use core::arch::wasm32::*;

    type Q = [i32; 4];
    #[inline(always)]
    fn load(a: &Q) -> v128 {
        // SAFETY: a is four i32 (16 bytes); v128_load is unaligned.
        unsafe { v128_load(a.as_ptr() as *const v128) }
    }

    /// Bit l set when box l (lo_x[l]..hi_x[l] by lo_y[l]..hi_y[l]) overlaps box b (closed).
    #[inline(always)]
    pub fn overlap4(lo_x: &Q, hi_x: &Q, lo_y: &Q, hi_y: &Q, b: [i32; 4]) -> u32 {
        let out = v128_or(v128_or(i32x4_lt(load(hi_x), i32x4_splat(b[0])), i32x4_gt(load(lo_x), i32x4_splat(b[1]))),
            v128_or(i32x4_lt(load(hi_y), i32x4_splat(b[2])), i32x4_gt(load(lo_y), i32x4_splat(b[3]))));
        (!i32x4_bitmask(out)) as u32 & 15
    }

    /// Bit l set when edge (y[l], y[l+1]) may matter to a point at height py: it straddles py
    /// ((y > py) differs) or has an end at py. No other edge can toggle the crossing parity or
    /// hold the point (`point_in_ring_ys`).
    #[inline(always)]
    pub fn y_cross4(y: &[i32; 5], py: i32) -> u32 {
        // SAFETY: y is five i32, so both four-lane loads are inside it; v128_load is unaligned.
        let (a, b) = unsafe { (v128_load(y.as_ptr() as *const v128), v128_load(y.as_ptr().add(1) as *const v128)) };
        let v = i32x4_splat(py);
        let hit = v128_or(v128_xor(i32x4_gt(a, v), i32x4_gt(b, v)), v128_or(i32x4_eq(a, v), i32x4_eq(b, v)));
        i32x4_bitmask(hit) as u32
    }
}

/// The same lanes in plain Rust (the host's `cargo test` runs the blocked loops with these).
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod lanes {
    type Q = [i32; 4];
    pub fn overlap4(lo_x: &Q, hi_x: &Q, lo_y: &Q, hi_y: &Q, b: [i32; 4]) -> u32 {
        (0..4).filter(|&l| !(hi_x[l] < b[0] || lo_x[l] > b[1] || hi_y[l] < b[2] || lo_y[l] > b[3])).fold(0, |m, l| m | 1 << l)
    }
    pub fn y_cross4(y: &[i32; 5], py: i32) -> u32 {
        (0..4).filter(|&l| (y[l] > py) != (y[l + 1] > py) || y[l] == py || y[l + 1] == py).fold(0, |m, l| m | 1 << l)
    }
}

// ---------------------------------------------------------------- edge list

#[derive(Default)]
struct Edges {
    x1: Vec<f64>,
    y1: Vec<f64>,
    x2: Vec<f64>,
    y2: Vec<f64>,
    c: Vec<u32>,
    s: Vec<f64>,
    t: Vec<i32>,
}

impl Edges {
    fn len(&self) -> usize { self.x1.len() }
    #[allow(clippy::too_many_arguments)]
    fn push(&mut self, ax: f64, ay: f64, bx: f64, by: f64, c: u32, s: f64, t: i32) {
        self.x1.push(ax); self.y1.push(ay); self.x2.push(bx); self.y2.push(by); self.c.push(c); self.s.push(s); self.t.push(t);
    }
}

fn edge_list(shapes: &[Shape]) -> Edges {
    let mut e = Edges::default();
    for sh in shapes {
        let n = sh.ring.len() >> 1;
        if n < 3 { continue; }
        for i in 0..n {
            let j = if i + 1 == n { 0 } else { i + 1 };
            let (ax, ay, bx, by) = (sh.ring[2 * i] as f64, sh.ring[2 * i + 1] as f64, sh.ring[2 * j] as f64, sh.ring[2 * j + 1] as f64);
            if ax == bx && ay == by { continue; }
            e.push(ax, ay, bx, by, sh.cls, sh.sign, sh.tags.map_or(-1, |t| t[i]));
        }
    }
    e
}

// ---------------------------------------------------------------- intersections

struct Found {
    edge: Vec<u32>,
    x: Vec<f64>,
    y: Vec<f64>,
}

/// The grid cells edge (ex1, ey1)-(ex2, ey2) passes through, in the JS order (`intersections`).
#[inline(always)]
fn supercover(ex1: f64, ey1: f64, ex2: f64, ey2: f64, (min_x, min_y, cs, cols): (f64, f64, f64, i64), f: &mut impl FnMut(usize)) {
    let (lx, hx) = if ex1 < ex2 { (ex1, ex2) } else { (ex2, ex1) };
    let (ly, hy) = if ey1 < ey2 { (ey1, ey2) } else { (ey2, ey1) };
    let c0 = ((lx - min_x) / cs).floor() as i64;
    let c1 = ((hx - min_x) / cs).floor() as i64;
    let r0 = ((ly - min_y) / cs).floor() as i64;
    let r1 = ((hy - min_y) / cs).floor() as i64;
    if c0 == c1 || r0 == r1 {
        for r in r0..=r1 { for c in c0..=c1 { f((r * cols + c) as usize); } }
        return;
    }
    let slope = (ey2 - ey1) / (ex2 - ex1);
    for c in c0..=c1 {
        let xa = js_max(lx, min_x + c as f64 * cs);
        let xb = js_min(hx, min_x + (c + 1) as f64 * cs);
        let ya = ey1 + (xa - ex1) * slope;
        let yb = ey1 + (xb - ex1) * slope;
        let lo = if ya < yb { ya } else { yb };
        let hi = if ya < yb { yb } else { ya };
        let ra = r0.max(((lo - 1.0 - min_y) / cs).floor() as i64);
        let rb = r1.min(((hi + 1.0 - min_y) / cs).floor() as i64);
        for r in ra..=rb { f((r * cols + c) as usize); }
    }
}

/// The uniform grid of `intersections`: each cell's items (edge indices, in edge order) and each
/// edge's cells (in supercover order). A boxed grid (the blocked candidate loop) pads each cell
/// to a multiple of four items and keeps the items' bounding boxes, in item order; padding
/// boxes are empty, so they never overlap anything.
struct Grid { start: Vec<u32>, items: Vec<u32>, edge_start: Vec<usize>, edge_cells: Vec<u32>, boxes: [Vec<i32>; 4], sub_of: Vec<i32>, subs: Vec<Sub> }

/// The grid of a crowded cell (JS `visitSub`): k by k cells of side s from (x0, y0).
struct Sub { x0: f64, y0: f64, s: f64, k: i64, start: Vec<u32>, items: Vec<u32> }

/// The sub-cells edge (x1, y1)-(x2, y2) crosses, clamped to the sub-grid (a superset), in the JS order.
#[inline(always)]
fn visit_sub(x1: f64, y1: f64, x2: f64, y2: f64, g: &Sub, f: &mut impl FnMut(usize)) {
    let (lx, hx) = if x1 < x2 { (x1, x2) } else { (x2, x1) };
    let (ly, hy) = if y1 < y2 { (y1, y2) } else { (y2, y1) };
    let k = g.k;
    let cl = |v: f64| -> i64 { let c = v.floor() as i64; c.clamp(0, k - 1) };
    let (c0, c1, r0, r1) = (cl((lx - g.x0) / g.s), cl((hx - g.x0) / g.s), cl((ly - g.y0) / g.s), cl((hy - g.y0) / g.s));
    if c0 == c1 || r0 == r1 {
        for r in r0..=r1 { for c in c0..=c1 { f((r * k + c) as usize); } }
        return;
    }
    let slope = (y2 - y1) / (x2 - x1);
    for c in c0..=c1 {
        let xa = js_min(hx, js_max(lx, g.x0 + c as f64 * g.s));
        let xb = js_max(lx, js_min(hx, g.x0 + (c + 1) as f64 * g.s));
        let ya = y1 + (xa - x1) * slope;
        let yb = y1 + (xb - x1) * slope;
        let ra = cl(((if ya < yb { ya } else { yb }) - 1.0 - g.y0) / g.s);
        let rb = cl(((if ya < yb { yb } else { ya }) + 1.0 - g.y0) / g.s);
        for r in ra..=rb { f((r * k + c) as usize); }
    }
}

fn grid(e: &Edges, want_boxes: bool) -> Result<Grid, Error> {
    let (x1, y1, x2, y2) = (&e.x1, &e.y1, &e.x2, &e.y2);
    let n = x1.len();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for i in 0..n {
        let (a, b, c, d) = (x1[i], x2[i], y1[i], y2[i]);
        if a < min_x { min_x = a; } if b < min_x { min_x = b; } if a > max_x { max_x = a; } if b > max_x { max_x = b; }
        if c < min_y { min_y = c; } if d < min_y { min_y = d; } if c > max_y { max_y = c; } if d > max_y { max_y = d; }
    }
    let w = max_x - min_x + 1.0;
    let h = max_y - min_y + 1.0;
    let lo = js_max(w / 2048.0, h / 2048.0);
    let mut cs = js_max(1.0, (w * h / n as f64).sqrt() * 1.5);
    cs = js_max(js_max(cs, w / 2048.0), h / 2048.0);
    // Smaller cells where edges crowd a few (JS `intersections`): the candidate loop costs the
    // sum of the cells' item counts squared.
    let limit = 48.0 * n as f64 + 1048576.0;
    let (mut cols, mut cells, mut start, mut edge_start, mut work);
    loop {
        cols = (w / cs).floor() as usize + 1;
        let rows = (h / cs).floor() as usize + 1;
        cells = cols.checked_mul(rows).filter(|&c| c <= 64 << 20).ok_or(Error::Fallback)?;
        start = vec![0u32; cells + 1];
        edge_start = vec![0usize; n + 1];
        let grid = (min_x, min_y, cs, cols as i64);
        for i in 0..n {
            let mut k = 0;
            supercover(x1[i], y1[i], x2[i], y2[i], grid, &mut |c| { start[c + 1] += 1; k += 1; });
            edge_start[i + 1] = edge_start[i] + k;
        }
        work = 0.0f64;
        for c in 1..=cells { let v = start[c] as f64; work += v * v; }
        if work <= limit || cs <= lo { break; }
        cs = js_max(lo, cs / 4.0);
    }
    let dense = work > limit;
    let grid = (min_x, min_y, cs, cols as i64);
    for c in 0..cells { start[c + 1] += start[c]; }
    let total = start[cells] as usize;
    if total > 256 << 20 { return Err(Error::Fallback); }
    // Sub-grids run in the scalar candidate loop only.
    let boxed = want_boxes && !dense && total + 3 * cells <= 256 << 20;
    if boxed {
        for c in (0..cells).rev() { start[c + 1] = (start[c + 1] - start[c]).next_multiple_of(4); }
        for c in 0..cells { start[c + 1] += start[c]; }
    }
    let total = start[cells] as usize;
    let mut items = vec![0u32; total];
    let mut edge_cells = vec![0u32; edge_start[n]];
    let mut fill: Vec<u32> = start[..cells].to_vec();
    let mut boxes: [Vec<i32>; 4] = Default::default();
    if boxed {
        boxes = [vec![i32::MAX; total], vec![i32::MIN; total], vec![i32::MAX; total], vec![i32::MIN; total]];
        let [lo_x, hi_x, lo_y, hi_y] = &mut boxes;
        let bound = |v: f64| v as i32; // an integer of at most 2^24 (validate)
        for i in 0..n {
            let mut k = edge_start[i];
            let (lx, hx) = if x1[i] < x2[i] { (x1[i], x2[i]) } else { (x2[i], x1[i]) };
            let (ly, hy) = if y1[i] < y2[i] { (y1[i], y2[i]) } else { (y2[i], y1[i]) };
            let b = [bound(lx), bound(hx), bound(ly), bound(hy)];
            supercover(x1[i], y1[i], x2[i], y2[i], grid, &mut |c| {
                let q = fill[c] as usize;
                items[q] = i as u32; lo_x[q] = b[0]; hi_x[q] = b[1]; lo_y[q] = b[2]; hi_y[q] = b[3];
                fill[c] += 1; edge_cells[k] = c as u32; k += 1;
            });
        }
    } else {
        for i in 0..n {
            let mut k = edge_start[i];
            supercover(x1[i], y1[i], x2[i], y2[i], grid, &mut |c| { items[fill[c] as usize] = i as u32; fill[c] += 1; edge_cells[k] = c as u32; k += 1; });
        }
    }
    // Each cell of m > 256 items gets ceil(sqrt(m/4)) (at most 256) sub-cells a side.
    let mut sub_of = vec![-1i32; if dense { cells } else { 0 }];
    let mut subs: Vec<Sub> = Vec::new();
    for cell in 0..sub_of.len() {
        let (a, b) = (start[cell] as usize, start[cell + 1] as usize);
        let m = b - a;
        if m <= 256 { continue; }
        let k = ((m as f64 / 4.0).sqrt().ceil() as i64).min(256);
        let kk = (k * k) as usize;
        let mut g = Sub { x0: min_x + (cell % cols) as f64 * cs, y0: min_y + (cell / cols) as f64 * cs, s: cs / k as f64, k, start: Vec::new(), items: Vec::new() };
        let mut st = vec![0u32; kk + 1];
        for q in a..b { let j = items[q] as usize; visit_sub(x1[j], y1[j], x2[j], y2[j], &g, &mut |c| { st[c + 1] += 1; }); }
        for c in 0..kk { st[c + 1] += st[c]; }
        g.start = st;
        let mut items_s = vec![0u32; g.start[kk] as usize];
        let mut f: Vec<u32> = g.start[..kk].to_vec();
        for q in a..b { let j = items[q]; let ju = j as usize; visit_sub(x1[ju], y1[ju], x2[ju], y2[ju], &g, &mut |c| { items_s[f[c] as usize] = j; f[c] += 1; }); }
        g.items = items_s;
        sub_of[cell] = subs.len() as i32;
        subs.push(g);
    }
    Ok(Grid { start, items, edge_start, edge_cells, boxes, sub_of, subs })
}

/// Edge i against edge j once their boxes overlap: the crossing or touching points.
#[inline(always)]
fn pair(e: &Edges, found: &mut Found, i: usize, j: usize) {
    let mut add = |e: usize, x: f64, y: f64| { found.edge.push(e as u32); found.x.push(x); found.y.push(y); };
    let (ax, ay, bx, by) = (e.x1[i], e.y1[i], e.x2[i], e.y2[i]);
    let (cx, cy, dx, dy) = (e.x1[j], e.y1[j], e.x2[j], e.y2[j]);
    let d1 = orient(ax, ay, bx, by, cx, cy);
    let d2 = orient(ax, ay, bx, by, dx, dy);
    if (d1 > 0.0 && d2 > 0.0) || (d1 < 0.0 && d2 < 0.0) { return; }
    let d3 = orient(cx, cy, dx, dy, ax, ay);
    let d4 = orient(cx, cy, dx, dy, bx, by);
    if (d3 > 0.0 && d4 > 0.0) || (d3 < 0.0 && d4 < 0.0) { return; }
    if d1 != 0.0 && d2 != 0.0 && d3 != 0.0 && d4 != 0.0 {
        let t = d3 / (d3 - d4);
        let px = js_round(ax + t * (bx - ax));
        let py = js_round(ay + t * (by - ay));
        add(i, px, py);
        add(j, px, py);
        return;
    }
    if d1 == 0.0 && strictly_on(ax, ay, bx, by, cx, cy) { add(i, cx, cy); }
    if d2 == 0.0 && strictly_on(ax, ay, bx, by, dx, dy) { add(i, dx, dy); }
    if d3 == 0.0 && strictly_on(cx, cy, dx, dy, ax, ay) { add(j, ax, ay); }
    if d4 == 0.0 && strictly_on(cx, cy, dx, dy, bx, by) { add(j, bx, by); }
}

/// The candidate pairs of the dirty edges, cell by cell, each pair once (the JS loop).
fn candidates(e: &Edges, dirty: &[u8], g: &Grid, found: &mut Found) {
    let (x1, y1, x2, y2) = (&e.x1, &e.y1, &e.x2, &e.y2);
    let mut mark = vec![u32::MAX; x1.len()];
    for i in 0..x1.len() {
        if dirty[i] == 0 { continue; }
        let (ax, ay, bx, by) = (x1[i], y1[i], x2[i], y2[i]);
        let (alx, ahx) = if ax < bx { (ax, bx) } else { (bx, ax) };
        let (aly, ahy) = if ay < by { (ay, by) } else { (by, ay) };
        let mut test = |j: usize| {
            if j == i || mark[j] == i as u32 { return; }
            mark[j] = i as u32;
            if dirty[j] != 0 && j < i { return; }
            let (cx, cy, dx, dy) = (x1[j], y1[j], x2[j], y2[j]);
            if (if cx < dx { dx } else { cx }) < alx || (if cx < dx { cx } else { dx }) > ahx
                || (if cy < dy { dy } else { cy }) < aly || (if cy < dy { cy } else { dy }) > ahy { return; }
            pair(e, found, i, j);
        };
        for k in g.edge_start[i]..g.edge_start[i + 1] {
            let cell = g.edge_cells[k] as usize;
            let sb = if g.subs.is_empty() { -1 } else { g.sub_of[cell] };
            if sb < 0 {
                for q in g.start[cell] as usize..g.start[cell + 1] as usize { test(g.items[q] as usize); }
            } else {
                let sg = &g.subs[sb as usize];
                visit_sub(ax, ay, bx, by, sg, &mut |c| { for q in sg.start[c] as usize..sg.start[c + 1] as usize { test(sg.items[q] as usize); } });
            }
        }
    }
}

/// `candidates` over a boxed grid, four boxes per step. A pair whose boxes miss is skipped
/// before it is marked: it would miss in every cell, so the pairs tested, and their order, are
/// the scalar loop's.
fn candidates_boxed<'a>(e: &Edges, dirty: &[u8], g: &'a Grid, found: &mut Found) {
    let (x1, y1, x2, y2) = (&e.x1, &e.y1, &e.x2, &e.y2);
    let mut mark = vec![u32::MAX; x1.len()];
    let [lo_x, hi_x, lo_y, hi_y] = &g.boxes;
    for i in 0..x1.len() {
        if dirty[i] == 0 { continue; }
        let (ax, ay, bx, by) = (x1[i], y1[i], x2[i], y2[i]);
        let (alx, ahx) = if ax < bx { (ax, bx) } else { (bx, ax) };
        let (aly, ahy) = if ay < by { (ay, by) } else { (by, ay) };
        let b = [alx as i32, ahx as i32, aly as i32, ahy as i32];
        for k in g.edge_start[i]..g.edge_start[i + 1] {
            let cell = g.edge_cells[k] as usize;
            // Padded: the cell's range is a multiple of four.
            let cell = g.start[cell] as usize..g.start[cell + 1] as usize;
            let quads = |v: &'a [i32]| v[cell.clone()].as_chunks::<4>().0;
            let items = &g.items[cell.clone()];
            let boxes = quads(lo_x).iter().zip(quads(hi_x)).zip(quads(lo_y)).zip(quads(hi_y));
            for (s, (((lx, hx), ly), hy)) in boxes.enumerate() {
                let mut hits = lanes::overlap4(lx, hx, ly, hy, b);
                while hits != 0 {
                    let j = items[4 * s + hits.trailing_zeros() as usize] as usize;
                    hits &= hits - 1;
                    if j == i || mark[j] == i as u32 { continue; }
                    mark[j] = i as u32;
                    if dirty[j] != 0 && j < i { continue; }
                    pair(e, found, i, j);
                }
            }
        }
    }
}

fn intersections(e: &Edges, dirty: &[u8], blocked: bool) -> Result<Found, Error> {
    let n = e.len();
    let mut found = Found { edge: Vec::new(), x: Vec::new(), y: Vec::new() };
    if n < 2 { return Ok(found); }
    // The boxes pay off when many edges are queried (the first pass); later passes query only
    // the edges just split, which the scalar loop does without building them.
    let want_boxes = blocked && dirty.iter().filter(|&&d| d != 0).count() * 4 >= n;
    let g = grid(e, want_boxes)?;
    if g.boxes[0].is_empty() { candidates(e, dirty, &g, &mut found); } else { candidates_boxed(e, dirty, &g, &mut found); }
    Ok(found)
}

/// `planarize` in JS: the edges split at their rounded crossings, or None when the second pass
/// finds crossings the rounding made (the caller snap rounds the input edges instead).
fn planarize<const LIMIT: usize>(mut e: Edges, stats: &mut Stats, blocked: bool) -> Result<Option<Edges>, Error> {
    let mut dirty = vec![1u8; e.len()];
    for pass in 0..2 {
        let found = intersections(&e, &dirty, blocked)?;
        stats.passes = pass + 1;
        if found.edge.is_empty() { return Ok(Some(e)); }
        if pass > 0 { return Ok(None); }
        // Crossing points per edge, in the order they were found.
        let mut first = vec![u32::MAX; e.len()];
        let mut link = vec![u32::MAX; found.edge.len()];
        let mut last = vec![u32::MAX; e.len()];
        for k in 0..found.edge.len() {
            let i = found.edge[k] as usize;
            if first[i] == u32::MAX { first[i] = k as u32; } else { link[last[i] as usize] = k as u32; }
            last[i] = k as u32;
        }
        let mut r = Edges::default();
        let mut nd: Vec<u8> = Vec::new();
        let mut pts: Vec<(f64, f64, f64)> = Vec::new();
        // Every original edge contributes its terminal segment, including
        // edges without crossings. Only accepted splits spend the extra budget.
        let mut splits_left = LIMIT.checked_sub(e.len()).ok_or(Error::Fallback)?;
        for i in 0..e.len() {
            let (ax, ay, bx, by, c, s, g) = (e.x1[i], e.y1[i], e.x2[i], e.y2[i], e.c[i], e.s[i], e.t[i]);
            if first[i] == u32::MAX { r.push(ax, ay, bx, by, c, s, g); nd.push(0); continue; }
            let (vx, vy) = (bx - ax, by - ay);
            let len = vx * vx + vy * vy;
            pts.clear();
            let mut k = first[i];
            while k != u32::MAX {
                let (px, py) = (found.x[k as usize], found.y[k as usize]);
                let t = (px - ax) * vx + (py - ay) * vy;
                if t > 0.0 && t < len { pts.push((t, px, py)); }
                k = link[k as usize];
            }
            pts.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(Ordering::Equal)); // stable, as JS
            let (mut px, mut py) = (ax, ay);
            for &(_, x, y) in &pts {
                if (x == px && y == py) || (x == bx && y == by) { continue; }
                if splits_left == 0 { return Err(Error::Fallback); }
                splits_left -= 1;
                r.push(px, py, x, y, c, s, g); nd.push(1);
                px = x; py = y;
            }
            r.push(px, py, bx, by, c, s, g); nd.push(1);
        }
        e = r;
        dirty = nd;
    }
    unreachable!("the second pass returns")
}

/// Snap rounding (Hobby), for the inputs whose rounded crossings make new ones (`snapRound` in
/// JS): from the input edges again, every endpoint and every rounded crossing is a hot pixel, and each edge
/// is routed through the centre of every hot pixel it meets (half-open unit squares), in order
/// along the edge (by projection, then x, then y). Each round is checked; `stats.passes` is 12
/// plus the rounds checked (13..16), `unresolved` only when 4 rounds leave a crossing.
fn snap_round<const LIMIT: usize>(mut e: Edges, stats: &mut Stats, blocked: bool) -> Result<Edges, Error> {
    for round in 0..4u32 {
        let n = e.len();
        let found = intersections(&e, &vec![1u8; n], blocked)?;
        if round > 0 {
            stats.passes = 12 + round;
            if found.edge.is_empty() { return Ok(e); }
        }
        let mut hmap: Map<(i64, i64), u32> = Map::default();
        let (mut hx_, mut hy_): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
        let mut hot = |x: f64, y: f64| { hmap.entry(vkey(x, y)).or_insert_with(|| { hx_.push(x); hy_.push(y); (hx_.len() - 1) as u32 }); };
        for i in 0..n { hot(e.x1[i], e.y1[i]); hot(e.x2[i], e.y2[i]); }
        for k in 0..found.x.len() { hot(found.x[k], found.y[k]); }
        drop(hmap);
        let h = hx_.len();
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for q in 0..h {
            let (x, y) = (hx_[q], hy_[q]);
            if x < min_x { min_x = x; } if x > max_x { max_x = x; } if y < min_y { min_y = y; } if y > max_y { max_y = y; }
        }
        let w = max_x - min_x + 1.0;
        let hh = max_y - min_y + 1.0;
        let mut cs = js_max(1.0, (w * hh / h as f64).sqrt() * 1.5);
        cs = js_max(js_max(cs, w / 2048.0), hh / 2048.0);
        let cols = (w / cs).floor() as i64 + 1;
        let rows = (hh / cs).floor() as i64 + 1;
        let cells = (cols as usize).checked_mul(rows as usize).filter(|&c| c <= 64 << 20).ok_or(Error::Fallback)?;
        let col_of = |x: f64| -> i64 { let c = ((x - min_x) / cs).floor() as i64; c.clamp(0, cols - 1) };
        let row_of = |y: f64| -> i64 { let r = ((y - min_y) / cs).floor() as i64; r.clamp(0, rows - 1) };
        let mut start = vec![0u32; cells + 1];
        for q in 0..h { start[(row_of(hy_[q]) * cols + col_of(hx_[q])) as usize + 1] += 1; }
        for c in 0..cells { start[c + 1] += start[c]; }
        let mut items = vec![0u32; h];
        let mut fill: Vec<u32> = start[..cells].to_vec();
        for q in 0..h { let c = (row_of(hy_[q]) * cols + col_of(hx_[q])) as usize; items[fill[c] as usize] = q as u32; fill[c] += 1; }
        let mut mark = vec![u32::MAX; h];
        let mut r = Edges::default();
        let mut pts: Vec<(f64, f64, f64)> = Vec::new();
        for i in 0..n {
            let (ax, ay, bx, by) = (e.x1[i], e.y1[i], e.x2[i], e.y2[i]);
            let (vx, vy) = (bx - ax, by - ay);
            let (lx, hx) = if ax < bx { (ax, bx) } else { (bx, ax) };
            let (ly, hy) = if ay < by { (ay, by) } else { (by, ay) };
            pts.clear();
            let mut c = col_of(lx - 1.0);
            let c1 = col_of(hx + 1.0);
            while c <= c1 {
                let (ra, rb);
                if vx == 0.0 { ra = row_of(ly - 1.0); rb = row_of(hy + 1.0); }
                else {
                    let xa = js_max(lx, min_x + c as f64 * cs - 1.0);
                    let xb = js_min(hx, min_x + (c + 1) as f64 * cs + 1.0);
                    if xa > xb { c += 1; continue; }
                    let ya = ay + (xa - ax) * vy / vx;
                    let yb = ay + (xb - ax) * vy / vx;
                    ra = row_of((if ya < yb { ya } else { yb }) - 1.0);
                    rb = row_of((if ya < yb { yb } else { ya }) + 1.0);
                }
                for row in ra..=rb {
                    let cell = (row * cols + c) as usize;
                    for k in start[cell] as usize..start[cell + 1] as usize {
                        let q = items[k] as usize;
                        if mark[q] == i as u32 { continue; }
                        mark[q] = i as u32;
                        let (px, py) = (hx_[q], hy_[q]);
                        if (px == ax && py == ay) || (px == bx && py == by) { continue; }
                        // The half-open pixel [l, l+1) x [b, b+1): entered, or passed through at (l, b).
                        let (l, b) = (px - 0.5, py - 0.5);
                        if hx < l || lx > l + 1.0 || hy < b || ly > b + 1.0 { continue; }
                        let s1 = orient(ax, ay, bx, by, l, b);
                        let s2 = orient(ax, ay, bx, by, l + 1.0, b);
                        let s3 = orient(ax, ay, bx, by, l + 1.0, b + 1.0);
                        let s4 = orient(ax, ay, bx, by, l, b + 1.0);
                        let open = lx < l + 1.0 && hx > l && ly < b + 1.0 && hy > b
                            && (s1 < 0.0 || s2 < 0.0 || s3 < 0.0 || s4 < 0.0) && (s1 > 0.0 || s2 > 0.0 || s3 > 0.0 || s4 > 0.0);
                        if !open && !(s1 == 0.0 && lx <= l && ly <= b) { continue; }
                        pts.push(((px - ax) * vx + (py - ay) * vy, px, py));
                    }
                }
                c += 1;
            }
            pts.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(Ordering::Equal)
                .then(p.1.partial_cmp(&q.1).unwrap_or(Ordering::Equal)).then(p.2.partial_cmp(&q.2).unwrap_or(Ordering::Equal)));
            let (cl, sg, tg) = (e.c[i], e.s[i], e.t[i]);
            let (mut px, mut py) = (ax, ay);
            for &(_, x, y) in &pts {
                if x == px && y == py { continue; }
                if r.len() == LIMIT { return Err(Error::Fallback); }
                r.push(px, py, x, y, cl, sg, tg);
                px = x; py = y;
            }
            if px != bx || py != by {
                if r.len() == LIMIT { return Err(Error::Fallback); }
                r.push(px, py, bx, by, cl, sg, tg);
            }
        }
        e = r;
    }
    stats.passes = 16;
    let n = e.len();
    if !intersections(&e, &vec![1u8; n], blocked)?.edge.is_empty() { stats.unresolved = true; }
    Ok(e)
}

// ---------------------------------------------------------------- merge

struct Merged {
    x1: Vec<i32>, y1: Vec<i32>, x2: Vec<i32>, y2: Vec<i32>,
    a: Vec<u32>, b: Vec<u32>, t: Vec<i32>, d: Vec<i32>, k: usize,
    vx: Vec<i32>,
}

fn merge(e: &Edges, k: usize) -> Merged {
    let mut vmap: Map<(i64, i64), u32> = Map::default();
    vmap.reserve(e.len() + e.len() / 2);
    let (mut vxs, mut vys): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    let mut vid = |x: f64, y: f64| -> u32 {
        *vmap.entry(vkey(x, y)).or_insert_with(|| { vxs.push(x); vys.push(y); (vxs.len() - 1) as u32 })
    };
    let mut emap: Map<(u32, u32), u32> = Map::default();
    emap.reserve(e.len());
    let (mut a_, mut b_, mut t_, mut d_): (Vec<u32>, Vec<u32>, Vec<i32>, Vec<f64>) = (vec![], vec![], vec![], vec![]);
    for i in 0..e.len() {
        let (mut ax, mut ay, mut bx, mut by, mut s) = (e.x1[i], e.y1[i], e.x2[i], e.y2[i], e.s[i]);
        if ax > bx || (ax == bx && ay > by) {
            core::mem::swap(&mut ax, &mut bx); core::mem::swap(&mut ay, &mut by); s = -s;
        }
        let a = vid(ax, ay);
        let b = vid(bx, by);
        let kk = match emap.get(&(a, b)) {
            Some(&kk) => { if t_[kk as usize] != e.t[i] { t_[kk as usize] = -1; } kk }
            None => {
                let kk = a_.len() as u32;
                emap.insert((a, b), kk);
                a_.push(a); b_.push(b); t_.push(e.t[i]); d_.extend(core::iter::repeat_n(0.0, k));
                kk
            }
        };
        d_[kk as usize * k + e.c[i] as usize] += s;
    }
    let keep: Vec<usize> = (0..a_.len()).filter(|&kk| (0..k).any(|c| d_[kk * k + c] != 0.0)).collect();
    let m = keep.len();
    let mut out = Merged {
        x1: vec![0; m], y1: vec![0; m], x2: vec![0; m], y2: vec![0; m], a: vec![0; m], b: vec![0; m], t: vec![0; m], d: vec![0; m * k], k,
        vx: vxs.iter().map(|&v| to_i32(v)).collect(),
    };
    let vy: Vec<i32> = vys.iter().map(|&v| to_i32(v)).collect();
    for (e2, &kk) in keep.iter().enumerate() {
        let (a, b) = (a_[kk] as usize, b_[kk] as usize);
        out.a[e2] = a as u32; out.b[e2] = b as u32;
        out.x1[e2] = out.vx[a]; out.y1[e2] = vy[a]; out.x2[e2] = out.vx[b]; out.y2[e2] = vy[b];
        out.t[e2] = t_[kk];
        for c in 0..k { out.d[e2 * k + c] = to_i32(d_[kk * k + c]); }
    }
    out
}

// ---------------------------------------------------------------- classification

struct RayCaster { min_x: f64, bw: f64, cols: usize, start: Vec<u32>, items: Vec<u32> }

impl RayCaster {
    fn new(m: &Merged) -> Self {
        let n = m.x1.len();
        let (mut min_x, mut max_x, mut non_vertical) = (f64::INFINITY, f64::NEG_INFINITY, 0usize);
        for e in 0..n {
            if (m.x1[e] as f64) < min_x { min_x = m.x1[e] as f64; }
            if (m.x2[e] as f64) > max_x { max_x = m.x2[e] as f64; }
            if m.x1[e] != m.x2[e] { non_vertical += 1; }
        }
        let cols = 1usize.max(8192usize.min(non_vertical.div_ceil(4)));
        let bw = js_max(1.0, (max_x - min_x + 1.0) / cols as f64);
        let mut rc = RayCaster { min_x, bw, cols, start: vec![0; cols + 1], items: Vec::new() };
        for e in 0..n {
            if m.x1[e] != m.x2[e] {
                let (c0, z) = (rc.col(m.x1[e] as f64), rc.col(m.x2[e] as f64 - 0.5));
                for c in c0..=z { rc.start[c + 1] += 1; }
            }
        }
        for c in 0..cols { rc.start[c + 1] += rc.start[c]; }
        rc.items = vec![0; rc.start[cols] as usize];
        let mut fill: Vec<u32> = rc.start[..cols].to_vec();
        for e in 0..n {
            if m.x1[e] != m.x2[e] {
                let (c0, z) = (rc.col(m.x1[e] as f64), rc.col(m.x2[e] as f64 - 0.5));
                for c in c0..=z { rc.items[fill[c] as usize] = e as u32; fill[c] += 1; }
            }
        }
        rc
    }

    fn col(&self, x: f64) -> usize {
        let c = ((x - self.min_x) / self.bw).floor();
        if c < 0.0 { 0 } else if c >= self.cols as f64 { self.cols - 1 } else { c as usize }
    }

    /// The winding just above edge e's midpoint, ignoring e.
    fn cast(&self, m: &Merged, e: usize, w: &mut [i32]) {
        let mx = m.x1[e] as f64 + m.x2[e] as f64;
        let my = m.y1[e] as f64 + m.y2[e] as f64;
        let col = self.col(mx / 2.0);
        w.fill(0);
        for q in self.start[col] as usize..self.start[col + 1] as usize {
            let f = self.items[q] as usize;
            if f == e { continue; }
            let (fx1, fx2) = (m.x1[f] as f64, m.x2[f] as f64);
            if !(2.0 * fx1 <= mx && mx < 2.0 * fx2) { continue; }
            let fy1 = m.y1[f] as f64;
            if (fx2 - fx1) * (my - 2.0 * fy1) - (m.y2[f] as f64 - fy1) * (mx - 2.0 * fx1) < 0.0 {
                let o = f * m.k;
                for c in 0..m.k { w[c] = w[c].wrapping_sub(m.d[o + c]); }
            }
        }
    }
}

#[derive(Default)]
struct Directed { x1: Vec<f64>, y1: Vec<f64>, x2: Vec<f64>, y2: Vec<f64>, t: Vec<i32> }

fn emit(out: &mut Directed, m: &Merged, e: usize, forward: bool) {
    let (x1, y1, x2, y2) = (m.x1[e] as f64, m.y1[e] as f64, m.x2[e] as f64, m.y2[e] as f64);
    if forward { out.x1.push(x1); out.y1.push(y1); out.x2.push(x2); out.y2.push(y2); }
    else { out.x1.push(x2); out.y1.push(y2); out.x2.push(x1); out.y2.push(y1); }
    out.t.push(m.t[e]);
}

fn classify_rays(m: &Merged, inside: &dyn Fn(&[i32]) -> bool) -> Directed {
    let mut out = Directed::default();
    let n = m.x1.len();
    if n == 0 { return out; }
    let ray = RayCaster::new(m);
    let k = m.k;
    let (mut w, mut l, mut r) = (vec![0i32; k], vec![0i32; k], vec![0i32; k]);
    for e in 0..n {
        ray.cast(m, e, &mut w);
        let o = e * k;
        if m.x1[e] == m.x2[e] { for c in 0..k { r[c] = w[c]; l[c] = w[c].wrapping_add(m.d[o + c]); } }
        else { for c in 0..k { l[c] = w[c]; r[c] = w[c].wrapping_sub(m.d[o + c]); } }
        let (fl, fr) = (inside(&l), inside(&r));
        if fl != fr { emit(&mut out, m, e, fl); }
    }
    out
}

fn classify(m: &Merged, inside: &dyn Fn(&[i32]) -> bool, stats: &mut Stats) -> Directed {
    let n = m.x1.len();
    let nv = m.vx.len();
    if n == 0 { return Directed::default(); }
    if stats.unresolved { return classify_rays(m, inside); }
    let k = m.k;
    let mut start = vec![0u32; nv + 1];
    for e in 0..n { start[m.a[e] as usize + 1] += 1; start[m.b[e] as usize + 1] += 1; }
    for v in 0..nv { start[v + 1] += start[v]; }
    let mut list = vec![0u32; 2 * n];
    let mut fill: Vec<u32> = start[..nv].to_vec();
    for e in 0..n {
        list[fill[m.a[e] as usize] as usize] = 2 * e as u32; fill[m.a[e] as usize] += 1;
        list[fill[m.b[e] as usize] as usize] = 2 * e as u32 + 1; fill[m.b[e] as usize] += 1;
    }
    let hx = |h: u32| -> f64 { let e = (h >> 1) as usize; if h & 1 == 1 { m.x1[e] as f64 - m.x2[e] as f64 } else { m.x2[e] as f64 - m.x1[e] as f64 } };
    let hy = |h: u32| -> f64 { let e = (h >> 1) as usize; if h & 1 == 1 { m.y1[e] as f64 - m.y2[e] as f64 } else { m.y2[e] as f64 - m.y1[e] as f64 } };
    let cmp = |a: &u32, b: &u32| -> Ordering {
        let (ax, ay, bx, by) = (hx(*a), hy(*a), hx(*b), hy(*b));
        let ha = if ay > 0.0 || (ay == 0.0 && ax > 0.0) { 0 } else { 1 };
        let hb = if by > 0.0 || (by == 0.0 && bx > 0.0) { 0 } else { 1 };
        if ha != hb { return (ha as i32).cmp(&hb); }
        let cr = ax * by - ay * bx;
        if cr > 0.0 { Ordering::Less } else if cr < 0.0 { Ordering::Greater } else { Ordering::Equal }
    };
    let mut pos = vec![0u32; 2 * n];
    for v in 0..nv {
        let (s, t) = (start[v] as usize, start[v + 1] as usize);
        if t - s > 2 { list[s..t].sort_by(cmp); }
        for j in s..t { pos[list[j] as usize] = (j - s) as u32; }
    }
    let mut nxt = vec![0u32; 2 * n];
    for h in 0..2 * n {
        let t = h ^ 1;
        let e = t >> 1;
        let v = if t & 1 == 1 { m.b[e] } else { m.a[e] } as usize;
        let (s, d) = (start[v] as usize, (start[v + 1] - start[v]) as usize);
        nxt[h] = list[s + (pos[t] as usize + d - 1) % d];
    }
    let mut face = vec![u32::MAX; 2 * n];
    let mut first: Vec<u32> = Vec::new();
    for h in 0..2 * n {
        if face[h] != u32::MAX { continue; }
        let f = first.len() as u32;
        first.push(h as u32);
        let (mut g, mut guard) = (h, 0usize);
        loop {
            face[g] = f;
            g = nxt[g] as usize;
            guard += 1;
            if guard > 2 * n { return classify_rays(m, inside); }
            if g == h { break; }
        }
    }
    let nf = first.len();
    let mut fw = vec![0i32; nf * k];
    let mut known = vec![false; nf];
    let mut queue = vec![0u32; nf];
    let mut w = vec![0i32; k];
    let mut ray: Option<RayCaster> = None;
    let mut rays = 0u32;
    for f0 in 0..nf {
        if known[f0] { continue; }
        let h0 = first[f0] as usize;
        let e0 = h0 >> 1;
        let o0 = e0 * k;
        let caster = ray.get_or_insert_with(|| RayCaster::new(m));
        caster.cast(m, e0, &mut w);
        rays += 1;
        let vertical = m.x1[e0] == m.x2[e0];
        for c in 0..k {
            let l = if vertical { w[c] as i64 + m.d[o0 + c] as i64 } else { w[c] as i64 };
            fw[f0 * k + c] = to_i32((if h0 & 1 == 1 { l - m.d[o0 + c] as i64 } else { l }) as f64);
        }
        known[f0] = true;
        let (mut qh, mut qt) = (0usize, 0usize);
        queue[qt] = f0 as u32; qt += 1;
        while qh < qt {
            let g = queue[qh] as usize; qh += 1;
            let gh = first[g] as usize;
            let mut h = gh;
            loop {
                let e = h >> 1;
                let g2 = face[h ^ 1] as usize;
                let o = e * k;
                let sg: i64 = if h & 1 == 1 { 1 } else { -1 };
                if !known[g2] {
                    for c in 0..k { fw[g2 * k + c] = to_i32((fw[g * k + c] as i64 + sg * m.d[o + c] as i64) as f64); }
                    known[g2] = true;
                    queue[qt] = g2 as u32; qt += 1;
                } else {
                    for c in 0..k {
                        if fw[g2 * k + c] as i64 != fw[g * k + c] as i64 + sg * m.d[o + c] as i64 {
                            stats.face_fallback = true;
                            return classify_rays(m, inside);
                        }
                    }
                }
                h = nxt[h] as usize;
                if h == gh { break; }
            }
        }
    }
    stats.faces = Some(nf as u32);
    stats.rays = Some(rays);
    let mut fin = vec![false; nf];
    for f in 0..nf { fin[f] = inside(&fw[f * k..f * k + k]); }
    let mut out = Directed::default();
    for e in 0..n {
        let (fl, fr) = (fin[face[2 * e] as usize], fin[face[2 * e + 1] as usize]);
        if fl != fr { emit(&mut out, m, e, fl); }
    }
    out
}

// ---------------------------------------------------------------- rings

struct Traced { ring: Vec<f64>, tags: Vec<i32> }

fn trace(o: &Directed, stats: &mut Stats) -> Vec<Traced> {
    let n = o.x1.len();
    let mut head: Map<(i64, i64), u32> = Map::default();
    head.reserve(n);
    let mut next = vec![u32::MAX; n];
    let mut used = vec![false; n];
    let mut rings = Vec::new();
    for e in 0..n {
        let key = vkey(o.x1[e], o.y1[e]);
        if let Some(&h) = head.get(&key) { next[e] = h; }
        head.insert(key, e as u32);
    }
    let group = |rx: f64, ry: f64, ox: f64, oy: f64| -> u32 {
        let cr = rx * oy - ry * ox;
        if cr < 0.0 { return 0; }
        if cr == 0.0 { return if rx * ox + ry * oy < 0.0 { 1 } else { 3 }; }
        2
    };
    for s in 0..n {
        if used[s] { continue; }
        let (mut ring, mut tags) = (Vec::new(), Vec::new());
        let (mut e, mut ok, mut guard) = (s, true, 0usize);
        loop {
            used[e] = true;
            ring.push(o.x1[e]); ring.push(o.y1[e]); tags.push(o.t[e]);
            let (vx, vy) = (o.x2[e], o.y2[e]);
            let Some(&first) = head.get(&vkey(vx, vy)) else { ok = false; break; };
            let mut best = first as usize;
            if next[first as usize] != u32::MAX {
                let (rx, ry) = (o.x1[e] - vx, o.y1[e] - vy);
                let (mut bg, mut bx, mut by) = (9u32, 0.0f64, 0.0f64);
                let mut f = first;
                while f != u32::MAX {
                    let fu = f as usize;
                    let (ox, oy) = (o.x2[fu] - vx, o.y2[fu] - vy);
                    let g = group(rx, ry, ox, oy);
                    if g < bg || (g == bg && (g == 0 || g == 2) && bx * oy - by * ox > 0.0) { bg = g; bx = ox; by = oy; best = fu; }
                    f = next[fu];
                }
            }
            if best == s { break; }
            guard += 1;
            if used[best] || guard > n { ok = false; break; }
            e = best;
        }
        if !ok { stats.broken_rings += 1; continue; }
        if let Some(clean) = simplify(ring, tags) { rings.push(clean); }
    }
    rings
}

fn area2(r: &[f64]) -> f64 {
    let n = r.len() >> 1;
    let mut s = 0.0;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        s += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
        j = i;
    }
    s
}

fn simplify(ring: Vec<f64>, tags: Vec<i32>) -> Option<Traced> {
    let (mut pts, mut tg, mut changed) = (ring, tags, true);
    while changed && pts.len() >= 6 {
        changed = false;
        let n = pts.len() >> 1;
        let (mut out, mut ot): (Vec<f64>, Vec<i32>) = (Vec::with_capacity(pts.len()), Vec::with_capacity(n));
        let mut lead: Option<i32> = None;
        for i in 0..n {
            let (p, q) = ((i + n - 1) % n, (i + 1) % n);
            let (ax, ay, bx, by, cx, cy) = (pts[2 * p], pts[2 * p + 1], pts[2 * i], pts[2 * i + 1], pts[2 * q], pts[2 * q + 1]);
            if (ax == bx && ay == by) || (orient(ax, ay, bx, by, cx, cy) == 0.0 && (bx - ax) * (cx - bx) + (by - ay) * (cy - by) >= 0.0) {
                changed = true;
                if let Some(last) = ot.last_mut() { *last = if *last == tg[i] { tg[i] } else { -1 }; }
                else { lead = Some(match lead { None => tg[i], Some(l) if l == tg[i] => l, Some(_) => -1 }); }
                continue;
            }
            out.push(bx); out.push(by); ot.push(tg[i]);
        }
        if let (Some(l), Some(last)) = (lead, ot.last_mut()) { *last = if *last == l { l } else { -1 }; }
        pts = out;
        tg = ot;
    }
    if pts.len() >= 6 && area2(&pts) != 0.0 { Some(Traced { ring: pts, tags: tg }) } else { None }
}

fn box_of(r: &[f64]) -> [f64; 4] {
    let (mut a, mut b, mut c, mut d) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut i = 0;
    while i < r.len() {
        let x = r[i];
        let y = if i + 1 < r.len() { r[i + 1] } else { f64::NAN }; // r[i+1] of an odd ring is undefined in JS
        if x < a { a = x; } if x > c { c = x; } if y < b { b = y; } if y > d { d = y; }
        i += 2;
    }
    [a, b, c, d]
}

/// 1 inside, -1 outside, 0 on the boundary.
fn point_in_ring(px: f64, py: f64, r: &[f64]) -> i32 {
    let mut inside = false;
    let n = r.len() >> 1;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (x1, y1, x2, y2) = (r[2 * j], r[2 * j + 1], r[2 * i], r[2 * i + 1]);
        let cr = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
        if cr == 0.0 && px >= js_min(x1, x2) && px <= js_max(x1, x2) && py >= js_min(y1, y2) && py <= js_max(y1, y2) { return 0; }
        if (y1 > py) != (y2 > py) && (cr > 0.0) == (y2 > y1) { inside = !inside; }
        j = i;
    }
    if inside { 1 } else { -1 }
}

/// Edge (x1, y1)-(x2, y2) of `point_in_ring`: (p is on it, it toggles the crossing parity).
#[inline(always)]
fn ring_edge(px: f64, py: f64, x1: f64, y1: f64, x2: f64, y2: f64) -> (bool, bool) {
    let cr = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    let on = cr == 0.0 && px >= js_min(x1, x2) && px <= js_max(x1, x2) && py >= js_min(y1, y2) && py <= js_max(y1, y2);
    (on, (y1 > py) != (y2 > py) && (cr > 0.0) == (y2 > y1))
}

/// `point_in_ring` with the ring's y coordinates `ys` (i32, `ring_ys`), four edges per step:
/// only an edge that straddles py or ends at it can toggle the parity or hold the point, so the
/// others are skipped and the rest run the scalar body (`ring_edge`, the same f64 operations).
/// The scalar loop returns 0 at the first edge holding p and otherwise the crossing parity, so
/// "on some edge" and the parity over all edges, in any order, give its answer.
fn point_in_ring_ys(px: f64, py: f64, r: &[f64], ys: &[i32]) -> i32 {
    let n = r.len() >> 1;
    let iy = py as i32;
    if ys.len() != n || iy as f64 != py { return point_in_ring(px, py, r); }
    if n == 0 { return -1; }
    let (mut on, mut odd) = (false, false);
    let mut edge = |j: usize, i: usize| {
        let (a, b) = ring_edge(px, py, r[2 * j], r[2 * j + 1], r[2 * i], r[2 * i + 1]);
        on |= a; odd ^= b;
    };
    edge(n - 1, 0);
    let mut i = 1;
    while i + 4 <= n {
        let Some(quad) = ys[i - 1..].first_chunk::<5>() else { break };
        let mut hits = lanes::y_cross4(quad, iy);
        while hits != 0 { let l = i + hits.trailing_zeros() as usize; edge(l - 1, l); hits &= hits - 1; }
        i += 4;
    }
    for i in i..n {
        if (ys[i - 1] > iy) != (ys[i] > iy) || ys[i - 1] == iy || ys[i] == iy { edge(i - 1, i); }
    }
    if on { 0 } else if odd { 1 } else { -1 }
}

/// The y coordinates of a ring, for `point_in_ring_ys` (empty for the scalar loops).
fn ring_ys(r: &[f64], blocked: bool) -> Vec<i32> {
    if !blocked { return Vec::new(); }
    r.chunks_exact(2).map(|p| p[1] as i32).collect() // integers of at most 2^24 (validate)
}

#[inline]
fn in_ring(px: f64, py: f64, r: &[f64], ys: &[i32]) -> i32 {
    if ys.is_empty() { point_in_ring(px, py, r) } else { point_in_ring_ys(px, py, r, ys) }
}

struct Poly { ring: Vec<f64>, tags: Vec<i32>, area: f64, bx: [f64; 4], holes: Vec<Poly>, links: Vec<u32>, ys: Vec<i32> }

fn contains(a: &[f64; 4], b: &[f64; 4]) -> bool { a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3] }

fn islands(rings: Vec<Traced>, blocked: bool) -> Vec<Poly> {
    let (mut outers, mut holes) = (Vec::new(), Vec::new());
    for t in rings {
        let a = area2(&t.ring) / 2.0;
        let bx = box_of(&t.ring);
        let p = Poly { area: a.abs(), bx, ys: ring_ys(&t.ring, blocked), ring: t.ring, tags: t.tags, holes: Vec::new(), links: Vec::new() };
        if a > 0.0 { outers.push(p) } else { holes.push(p) }
    }
    for h in holes {
        let mut best: Option<usize> = None;
        for (oi, o) in outers.iter().enumerate() {
            if o.area <= h.area || !contains(&o.bx, &h.bx) || best.is_some_and(|b| o.area >= outers[b].area) { continue; }
            let mut side = 0;
            let mut i = 0;
            while i < h.ring.len() && side == 0 { side = in_ring(h.ring[i], h.ring[i + 1], &o.ring, &o.ys); i += 2; }
            if side >= 0 { best = Some(oi); }
        }
        if let Some(b) = best { outers[b].holes.push(h); }
    }
    outers
}

fn segments_touch(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) -> bool {
    let (d1, d2, d3, d4) = (orient(ax, ay, bx, by, cx, cy), orient(ax, ay, bx, by, dx, dy), orient(cx, cy, dx, dy, ax, ay), orient(cx, cy, dx, dy, bx, by));
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)) { return true; }
    let on = |px: f64, py: f64, qx: f64, qy: f64, rx: f64, ry: f64| rx >= js_min(px, qx) && rx <= js_max(px, qx) && ry >= js_min(py, qy) && ry <= js_max(py, qy);
    (d1 == 0.0 && on(ax, ay, bx, by, cx, cy)) || (d2 == 0.0 && on(ax, ay, bx, by, dx, dy)) || (d3 == 0.0 && on(cx, cy, dx, dy, ax, ay)) || (d4 == 0.0 && on(cx, cy, dx, dy, bx, by))
}

fn in_island(x: f64, y: f64, isl: &Poly) -> bool {
    let o = in_ring(x, y, &isl.ring, &isl.ys);
    if o < 0 { return false; }
    if o == 0 { return true; }
    for h in &isl.holes {
        if x >= h.bx[0] && x <= h.bx[2] && y >= h.bx[1] && y <= h.bx[3] && in_ring(x, y, &h.ring, &h.ys) > 0 { return false; }
    }
    true
}

fn touches(r: &[f64], b: &[f64; 4], isl: &Poly) -> bool {
    let ib = &isl.bx;
    if b[0] > ib[2] || b[2] < ib[0] || b[1] > ib[3] || b[3] < ib[1] { return false; }
    let n = r.len() >> 1;
    for i in 0..n { if in_island(r[2 * i], r[2 * i + 1], isl) { return true; } }
    // isl.ring[0], isl.ring[1] exist: islands have at least three vertices.
    if point_in_ring(isl.ring[0], isl.ring[1], r) >= 0 { return true; }
    for ring in core::iter::once(&isl.ring).chain(isl.holes.iter().map(|h| &h.ring)) {
        let m = ring.len() >> 1;
        let mut j = m.wrapping_sub(1);
        for i in 0..m {
            let (x1, y1, x2, y2) = (ring[2 * j], ring[2 * j + 1], ring[2 * i], ring[2 * i + 1]);
            j = i;
            if js_max(x1, x2) < b[0] || js_min(x1, x2) > b[2] || js_max(y1, y2) < b[1] || js_min(y1, y2) > b[3] { continue; }
            let mut l = n.wrapping_sub(1);
            for k in 0..n {
                if segments_touch(x1, y1, x2, y2, r[2 * l], r[2 * l + 1], r[2 * k], r[2 * k + 1]) { return true; }
                l = k;
            }
        }
    }
    false
}

/// The pour predicate. Classes: 0 polygon, 1 board, 2 obstacle, 3 relief annulus, 4 spoke,
/// 5 same-net clearance (a spoke crosses it), 6.. earlier pours.
fn pour_inside(k: usize, has_board: bool) -> impl Fn(&[i32]) -> bool {
    move |w: &[i32]| {
        if w[0] == 0 || (has_board && w[1] == 0) || w[2] > 0 { return false; }
        for c in 6..k { if w[c] > 0 { return false; } }
        w[4] != 0 || (w[3] == 0 && w[5] == 0)
    }
}

// ---------------------------------------------------------------- Remove Necks, Outlines Only

/// JS `convolution`: the convolution cycle of a ring (interior on its left; `reverse` walks it
/// backwards) with the template: each edge moved by the template vertex farthest along its outward
/// normal (ties: the lowest index), the template's vertices walked between edges (forward at a left
/// turn, backward at a right one).
fn convolution(r: &[i32], t: &[i32], reverse: bool) -> Vec<i32> {
    let (n, k) = (r.len() >> 1, t.len() >> 1);
    let (mut x, mut y) = (vec![0f64; n], vec![0f64; n]);
    for i in 0..n { let j = if reverse { n - 1 - i } else { i }; x[i] = r[2 * j] as f64; y[i] = r[2 * j + 1] as f64; }
    let mut s = vec![0usize; n];
    for i in 0..n {
        let q = if i + 1 == n { 0 } else { i + 1 };
        let (nx, ny) = (y[q] - y[i], x[i] - x[q]);
        let (mut best, mut bd) = (0usize, f64::NEG_INFINITY);
        for j in 0..k { let d = t[2 * j] as f64 * nx + t[2 * j + 1] as f64 * ny; if d > bd { bd = d; best = j; } }
        s[i] = best;
    }
    let mut out: Vec<i32> = Vec::with_capacity(4 * n + 2 * k);
    let mut push = |px: f64, py: f64| { out.push(to_i32(px)); out.push(to_i32(py)); };
    for i in 0..n {
        let q = if i + 1 == n { 0 } else { i + 1 };
        let w = if q + 1 == n { 0 } else { q + 1 };
        let (a, b) = (s[i], s[q]);
        push(x[i] + t[2 * a] as f64, y[i] + t[2 * a + 1] as f64);
        push(x[q] + t[2 * a] as f64, y[q] + t[2 * a + 1] as f64);
        if a == b { continue; }
        let (ex, ey, fx, fy) = (x[q] - x[i], y[q] - y[i], x[w] - x[q], y[w] - y[q]);
        let c = ex * fy - ey * fx;
        if c > 0.0 || (c == 0.0 && ex * fx + ey * fy < 0.0) {
            let mut j = (a + 1) % k;
            while j != b { push(x[q] + t[2 * j] as f64, y[q] + t[2 * j + 1] as f64); j = (j + 1) % k; }
        } else {
            let mut j = (a + k - 1) % k;
            while j != b { push(x[q] + t[2 * j] as f64, y[q] + t[2 * j + 1] as f64); j = (j + k - 1) % k; }
        }
    }
    out
}

/// JS `overlayInt` with its own stats (the pour's stats are those of its main overlay). Inputs
/// this port cannot reproduce exactly (too many edges, coordinates out of range) fall back.
fn overlay(shapes: &[Shape], k: usize, inside: &dyn Fn(&[i32]) -> bool, blocked: bool) -> Result<Vec<Poly>, Error> {
    let mut edges = 0usize;
    for s in shapes {
        edges += s.ring.len() / 2;
        if !s.ring.iter().all(|&v| (v as f64).abs() <= MAX_COORD) { return Err(Error::Fallback); }
    }
    if edges > MAX_EDGES { return Err(Error::Fallback); }
    let mut stats = Stats::default();
    let e = match planarize::<MAX_EDGES>(edge_list(shapes), &mut stats, blocked)? {
        Some(e) => e,
        None => snap_round::<MAX_EDGES>(edge_list(shapes), &mut stats, blocked)?,
    };
    let m = merge(&e, k);
    drop(e);
    let c = classify(&m, inside, &mut stats);
    drop(m);
    Ok(islands(trace(&c, &mut stats), blocked))
}

fn int_ring(r: &[f64]) -> Vec<i32> { r.iter().map(|&v| to_i32(v)).collect() }

fn reach_of(t: &[i32]) -> i32 { t.iter().fold(0, |x, &v| x.max(v.abs())) }

fn reversed_ring(r: &[i32]) -> Vec<i32> {
    let n = r.len() >> 1;
    let mut o = vec![0i32; r.len()];
    for i in 0..n { o[2 * i] = r[2 * (n - 1 - i)]; o[2 * i + 1] = r[2 * (n - 1 - i) + 1]; }
    o
}

/// JS `boxSlit`: the box round a ring (counter-clockwise), a slit from its lower left corner to the
/// ring's lowest vertex (x, then y), and the ring as given, as one ring.
fn box_slit(r: &[i32], margin: i32) -> Vec<i32> {
    let n = r.len() >> 1;
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    let mut v = 0usize;
    for i in 0..n {
        let (x, y) = (r[2 * i], r[2 * i + 1]);
        x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y);
        if i > 0 && (x < r[2 * v] || (x == r[2 * v] && y < r[2 * v + 1])) { v = i; }
    }
    let (x0, y0, x1, y1) = (x0 - margin, y0 - margin, x1 + margin, y1 + margin);
    let mut out = vec![x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
    for i in 0..=n { let j = (v + i) % n; out.push(r[2 * j]); out.push(r[2 * j + 1]); }
    out
}

/// JS `convexRing`: every turn strict and of one sign.
fn convex_ring(r: &[f64]) -> bool {
    let n = r.len() >> 1;
    if n < 3 { return false; }
    let mut sg = 0i32;
    for i in 0..n {
        let p = if i > 0 { i - 1 } else { n - 1 };
        let q = if i + 1 == n { 0 } else { i + 1 };
        let o = orient(r[2 * p], r[2 * p + 1], r[2 * i], r[2 * i + 1], r[2 * q], r[2 * q + 1]);
        if o == 0.0 { return false; }
        let t = if o > 0.0 { 1 } else { -1 };
        if sg != 0 && t != sg { return false; }
        sg = t;
    }
    true
}

fn area2_i(r: &[i32]) -> f64 {
    let n = r.len() >> 1;
    let mut s = 0.0;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        s += r[2 * j] as f64 * r[2 * i + 1] as f64 - r[2 * i] as f64 * r[2 * j + 1] as f64;
        j = i;
    }
    s
}

/// JS `holeOf`: for each point, the index of the first hole of E (in E's order) holding it, or -1.
fn hole_of(e: &[Poly], pts: &[(f64, f64)]) -> (Vec<i64>, usize) {
    let holes: Vec<&Poly> = e.iter().flat_map(|isl| isl.holes.iter()).collect();
    let mut out = vec![-1i64; pts.len()];
    if holes.is_empty() { return (out, 0); }
    let mut w = 1f64;
    for h in &holes { w = js_max(w, js_max(h.bx[2] - h.bx[0], h.bx[3] - h.bx[1])); }
    let c = js_max(16.0, js_min(w, 4_194_304.0));
    let mut cells: Map<(i64, i64), Vec<u32>> = Map::default();
    for (id, h) in holes.iter().enumerate() {
        let (ex, ey) = ((h.bx[2] / c).floor() as i64, (h.bx[3] / c).floor() as i64);
        let mut cx = (h.bx[0] / c).floor() as i64;
        while cx <= ex {
            let mut cy = (h.bx[1] / c).floor() as i64;
            while cy <= ey { cells.entry((cx, cy)).or_default().push(id as u32); cy += 1; }
            cx += 1;
        }
    }
    for (i, &(px, py)) in pts.iter().enumerate() {
        let Some(l) = cells.get(&((px / c).floor() as i64, (py / c).floor() as i64)) else { continue };
        for &id in l {
            let b = &holes[id as usize].bx;
            if px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3] && point_in_ring(px, py, &holes[id as usize].ring) > 0 { out[i] = id as i64; break; }
        }
    }
    (out, holes.len())
}

fn rings_of(e: &[Poly]) -> Vec<Vec<i32>> {
    let mut out = Vec::new();
    for isl in e { out.push(int_ring(&isl.ring)); for h in &isl.holes { out.push(int_ring(&h.ring)); } }
    out
}

/// JS `shapeIslands`: Remove Necks (the opening of the copper by the template) or Outlines Only.
fn shape_islands(found: Vec<Poly>, m: &Morph, blocked: bool) -> Result<Vec<Poly>, Error> {
    if !(m.mode == 1 || m.mode == 2) || found.is_empty() { return Ok(found); }
    let margin_t = 2 * reach_of(m.t) + 4;
    let (mut rings, mut tags): (Vec<Vec<i32>>, Vec<Vec<i32>>) = (Vec::new(), Vec::new());
    for isl in &found {
        rings.push(int_ring(&isl.ring)); tags.push(isl.tags.clone());
        for h in &isl.holes { rings.push(int_ring(&h.ring)); tags.push(h.tags.clone()); }
    }
    // Erosion, island by island.
    let mut e: Vec<Poly> = Vec::new();
    let mut reps: Vec<(f64, f64, f64)> = Vec::new();
    let mut at = 0usize;
    for isl in &found {
        let own = &rings[at..at + 1 + isl.holes.len()];
        at += 1 + isl.holes.len();
        let outer = convolution(&box_slit(&reversed_ring(&own[0]), margin_t), m.t, false);
        let holes: Vec<Vec<i32>> = own[1..].iter().map(|h| convolution(h, m.t, true)).collect();
        for (k, h) in isl.holes.iter().enumerate() {
            if convex_ring(&h.ring) { reps.push((h.ring[0], h.ring[1], area2_i(&holes[k]))); }
        }
        let mut sh: Vec<Shape> = own.iter().map(|r| Shape { cls: 0, sign: 1.0, ring: r, tags: None }).collect();
        sh.push(Shape { cls: 1, sign: 1.0, ring: &outer, tags: None });
        for h in &holes { sh.push(Shape { cls: 1, sign: 1.0, ring: h, tags: None }); }
        e.extend(overlay(&sh, 2, &|w: &[i32]| w[0] > 0 && w[1] == 0, blocked)?);
    }
    drop(found);
    let p_shapes = || rings.iter().zip(tags.iter()).map(|(r, t)| Shape { cls: 0, sign: 1.0, ring: r, tags: Some(t) });
    if m.mode == 2 {
        let er = rings_of(&e);
        let mut fin: Vec<Shape> = p_shapes().collect();
        for r in &er { fin.push(Shape { cls: 1, sign: 1.0, ring: r, tags: None }); }
        for r in &m.keep { fin.push(Shape { cls: 2, sign: 1.0, ring: r, tags: None }); }
        return overlay(&fin, 3, &|w: &[i32]| w[0] > 0 && (w[1] == 0 || w[2] > 0), blocked);
    }
    let pts: Vec<(f64, f64)> = reps.iter().map(|r| (r.0, r.1)).collect();
    let (hole_at, nh) = hole_of(&e, &pts);
    let (mut count, mut area) = (vec![0u32; nh], vec![0f64; nh]);
    for (i, &h) in hole_at.iter().enumerate() { if h >= 0 { count[h as usize] += 1; area[h as usize] = reps[i].2; } }
    let mut skip = Vec::with_capacity(nh);
    for isl in &e { for h in &isl.holes { let id = skip.len(); skip.push(count[id] == 1 && -area2(&h.ring) == area[id]); } }
    let margin = 2 * reach_of(m.u) + 4;
    let mut grown: Vec<Vec<i32>> = Vec::new();
    let mut hid = 0usize;
    for isl in &e {
        let outer = convolution(&int_ring(&isl.ring), m.u, false);
        let mut kept = Vec::new();
        for h in &isl.holes { if !skip[hid] { kept.push(int_ring(&h.ring)); } hid += 1; }
        if kept.is_empty() { grown.push(outer); continue; }
        let mut deep_rings: Vec<Vec<i32>> = Vec::new();
        for h in &kept {
            let (rev, around) = (reversed_ring(h), convolution(&box_slit(h, margin), m.u, false));
            let sh = [Shape { cls: 0, sign: 1.0, ring: &rev, tags: None }, Shape { cls: 1, sign: 1.0, ring: &around, tags: None }];
            deep_rings.extend(rings_of(&overlay(&sh, 2, &|w: &[i32]| w[0] > 0 && w[1] == 0, blocked)?));
        }
        let mut d: Vec<Shape> = vec![Shape { cls: 0, sign: 1.0, ring: &outer, tags: None }];
        for r in &deep_rings { d.push(Shape { cls: 1, sign: 1.0, ring: r, tags: None }); }
        let part = overlay(&d, 2, &|w: &[i32]| w[0] > 0 && w[1] == 0, blocked)?;
        grown.extend(rings_of(&part));
    }
    drop(e);
    let mut fin: Vec<Shape> = p_shapes().collect();
    for r in &grown { fin.push(Shape { cls: 1, sign: 1.0, ring: r, tags: None }); }
    for r in &m.keep { fin.push(Shape { cls: 2, sign: 1.0, ring: r, tags: None }); }
    overlay(&fin, 3, &|w: &[i32]| w[0] > 0 && (w[1] > 0 || w[2] > 0), blocked)
}

pub fn validate(task: &Task) -> Result<(), Error> {
    if task.k < 6 || task.k > MAX_CLASSES { return Err(Error::Invalid); }
    let mut edges = 0usize;
    for s in &task.shapes {
        if s.cls as usize >= task.k || !(s.sign == 1.0 || s.sign == -1.0) || s.ring.len() % 2 != 0 { return Err(Error::Invalid); }
        if let Some(t) = s.tags { if t.len() != s.ring.len() / 2 { return Err(Error::Invalid); } }
        edges += s.ring.len() / 2;
    }
    if edges > MAX_EDGES { return Err(Error::Fallback); }
    let in_range = |r: &[i32]| r.iter().all(|&v| (v as f64).abs() <= MAX_COORD);
    if !task.shapes.iter().all(|s| in_range(s.ring)) || !task.anchors.iter().all(|a| in_range(a)) { return Err(Error::Fallback); }
    if !task.min_area.is_finite() || !task.min_size.is_finite() { return Err(Error::Fallback); }
    if let Some(m) = &task.morph {
        let ring_ok = |r: &[i32]| r.len() % 2 == 0;
        if !(m.mode == 1 || m.mode == 2) || m.t.len() < 6 || m.t.len() > 1024 || !ring_ok(m.t) || (m.mode == 1 && m.u.len() != m.t.len()) || !m.keep.iter().all(|r| ring_ok(r)) { return Err(Error::Invalid); }
        // Template offsets stay far inside the coordinate range (the JS builds them from at most 5 mm).
        if !m.t.iter().chain(m.u.iter()).all(|&v| (v as f64).abs() <= MAX_COORD / 4.0) || !m.keep.iter().all(|r| in_range(r)) { return Err(Error::Fallback); }
    }
    Ok(())
}

/// `PourCore().solve(task)`: the kept islands (rings, edge tags, linked anchors, holes).
pub fn solve(task: &Task) -> Result<(Vec<Island>, Stats), Error> { solve_with(task, BLOCKED) }

/// `solve` with the blocked (vector) loops or the scalar ones: the same result either way.
pub fn solve_with(task: &Task, blocked: bool) -> Result<(Vec<Island>, Stats), Error> {
    // Outside tests, only the SIMD module has the blocked loops (they leave the MVP module).
    let blocked = blocked && (BLOCKED || cfg!(test));
    validate(task)?;
    let mut stats = Stats::default();
    let e = match planarize::<MAX_EDGES>(edge_list(&task.shapes), &mut stats, blocked)? {
        Some(e) => e,
        None => snap_round::<MAX_EDGES>(edge_list(&task.shapes), &mut stats, blocked)?,
    };
    stats.edges = e.len() as u32;
    let m = merge(&e, task.k);
    drop(e);
    stats.merged = m.x1.len() as u32;
    let inside = pour_inside(task.k, task.has_board);
    let c = classify(&m, &inside, &mut stats);
    drop(m);
    let rings = trace(&c, &mut stats);
    let mut found = islands(rings, blocked);
    if let Some(m) = &task.morph { found = shape_islands(found, m, blocked)?; }
    let anchors: Vec<(Vec<f64>, [f64; 4])> = task.anchors.iter().map(|a| { let r: Vec<f64> = a.iter().map(|&v| v as f64).collect(); let b = box_of(&r); (r, b) }).collect();
    for isl in found.iter_mut() {
        for (k, (r, b)) in anchors.iter().enumerate() {
            if touches(r, b, isl) { isl.links.push(k as u32); }
        }
    }
    let before = found.len();
    if task.remove_dead { found.retain(|isl| !isl.links.is_empty()); }
    stats.dead_islands = (before - found.len()) as u32;
    found.retain(|isl| {
        let area = isl.area - isl.holes.iter().fold(0.0, |s, h| s + h.area);
        if task.min_area > 0.0 && area < task.min_area { return false; }
        !(isl.bx[2] - isl.bx[0] < task.min_size && isl.bx[3] - isl.bx[1] < task.min_size)
    });
    let pack = |ring: &[f64], tags: &[i32]| Ring { ring: ring.iter().map(|&v| to_i32(v)).collect(), tags: tags.to_vec() };
    let out = found.iter().map(|isl| Island {
        ring: pack(&isl.ring, &isl.tags),
        links: isl.links.clone(),
        holes: isl.holes.iter().map(|h| pack(&h.ring, &h.tags)).collect(),
    }).collect();
    Ok((out, stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: i32, y: i32, s: i32) -> Vec<i32> { vec![x, y, x + s, y, x + s, y + s, x, y + s] }

    #[test]
    fn split_and_snap_count_distinct_emitted_edges_against_the_cap() {
        fn crossings() -> Edges {
            let mut e = Edges::default();
            e.push(0.0, 0.0, 10.0, 0.0, 0, 1.0, 10);
            // The horizontal edge sees the same hot point twice.
            e.push(5.0, -5.0, 5.0, 5.0, 1, 1.0, 11);
            e.push(5.0, -5.0, 5.0, 5.0, 2, -1.0, 12);
            // This final edge takes the planar no-hit path.
            e.push(50.0, 50.0, 60.0, 50.0, 3, 1.0, 13);
            e
        }
        let tags = [10, 10, 11, 11, 12, 12, 13];
        for blocked in [false, true] {
            let planar = planarize::<7>(crossings(), &mut Stats::default(), blocked).unwrap().unwrap();
            assert_eq!(planar.t, tags);
            assert!(matches!(planarize::<6>(crossings(), &mut Stats::default(), blocked), Err(Error::Fallback)));

            let snapped = snap_round::<7>(crossings(), &mut Stats::default(), blocked).unwrap();
            assert_eq!(snapped.t, tags);
            assert!(matches!(snap_round::<6>(crossings(), &mut Stats::default(), blocked), Err(Error::Fallback)));

            // With no tail segment left in the budget, an interior split alone
            // must not grow the snap output.
            assert!(matches!(snap_round::<1>(crossings(), &mut Stats::default(), blocked), Err(Error::Fallback)));
        }
    }

    #[test]
    fn js_number_helpers() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(to_i32(4294967297.0), 1);
        assert_eq!(to_i32(-1.0), -1);
        assert_eq!(to_i32(2147483648.0), -2147483648);
    }

    #[test]
    fn polygon_minus_obstacle_has_a_hole() {
        let poly = square(0, 0, 1000);
        let hole = square(400, 400, 200);
        let task = Task {
            shapes: vec![Shape { cls: 0, sign: 1.0, ring: &poly, tags: None }, Shape { cls: 2, sign: 1.0, ring: &hole, tags: None }],
            k: 6, has_board: false, anchors: vec![&hole], remove_dead: false, min_area: 0.0, min_size: 0.0, morph: None,
        };
        let (isl, stats) = solve(&task).unwrap();
        assert_eq!(isl.len(), 1);
        assert_eq!(isl[0].holes.len(), 1);
        assert_eq!(isl[0].links, vec![0]);
        assert_eq!(stats.passes, 1);
        assert!(stats.faces.is_some());
    }

    fn task_of<'a>(shapes: &'a [(u32, f64, Vec<i32>)], k: usize, has_board: bool) -> Task<'a> {
        Task { shapes: shapes.iter().map(|(c, s, r)| Shape { cls: *c, sign: *s, ring: r, tags: None }).collect(),
            k, has_board, anchors: vec![], remove_dead: false, min_area: 0.0, min_size: 0.0, morph: None }
    }

    // tests/fixtures/pour-fuzz/regressions.json seed-a4f45cfc: two outgoing edges in one half-plane
    // at a pinch vertex; trace took the far one and dropped every ring.
    #[test]
    fn pinch_vertex_rings_close() {
        let shapes = [(0, 1.0, vec![-1, 0, 15, 16, -1, 16]), (1, 1.0, vec![-1, 6, 10, 13, 3, 11]), (3, 1.0, vec![14, 7, 12, 11, 8, 13])];
        let (isl, stats) = solve(&task_of(&shapes, 7, true)).unwrap();
        assert_eq!(stats.broken_rings, 0);
        assert_eq!(isl.len(), 2);
    }

    // seed-3845cdb7: near-coincident slivers whose rounded crossings cascade; snap rounding settles them.
    #[test]
    fn cascading_crossings_are_snap_rounded() {
        let shapes = [(1, 1.0, vec![754, 119, 972, 90, 539, 71]), (4, 1.0, vec![558, 84, 920, 126, 602, 305]), (0, 1.0, vec![559, 84, 921, 126, 603, 305])];
        for blocked in [false, true] {
            let (_, stats) = solve_with(&task_of(&shapes, 7, true), blocked).unwrap();
            assert!(stats.passes > 12 && !stats.unresolved && stats.broken_rings == 0, "{stats:?}");
            assert!(stats.faces.is_some());
        }
    }

    // A fan of thin spokes through one small disk on a board-sized frame: crowded cells get
    // sub-grids (scalar loop only); the blocked and scalar paths still agree.
    #[test]
    fn crowded_cells_use_sub_grids() {
        let lim = 16_777_215;
        let mut shapes = vec![(0u32, 1.0, vec![-lim, -lim, lim, -lim, lim, lim, -lim, lim])];
        let mut s = 7u32;
        let mut rnd = || { s ^= s << 13; s ^= s >> 17; s ^= s << 5; s };
        for _ in 0..120 {
            let (cx, cy) = ((rnd() % 400) as f64 - 200.0, (rnd() % 400) as f64 - 200.0);
            let a = (rnd() % 3600) as f64 / 10.0 * core::f64::consts::PI / 180.0;
            let (c, sn, len, w) = (a.cos(), a.sin(), 60000.0, 3.0 + (rnd() % 4) as f64);
            let ring: Vec<i32> = [(0.0, -w / 2.0), (len, -w / 2.0), (len, w / 2.0), (0.0, w / 2.0)].iter()
                .flat_map(|&(u, v)| [js_round(cx + u * c - v * sn) as i32, js_round(cy + u * sn + v * c) as i32]).collect();
            shapes.push((2, 1.0, ring));
        }
        let t = task_of(&shapes, 6, false);
        let (a, sa) = solve_with(&t, false).unwrap();
        let (b, sb) = solve_with(&t, true).unwrap();
        assert_eq!(a, b);
        assert_eq!(sa, sb);
        assert_eq!(sa.broken_rings, 0);
        assert!(sa.edges > 10_000, "{sa:?}");
    }

    #[test]
    fn crossing_obstacles_split_and_dead_islands_go() {
        let poly = square(0, 0, 1000);
        // A bar across the polygon cuts it in two; an anchor touches only the left part.
        let bar = vec![480, -10, 520, -10, 520, 1010, 480, 1010];
        let anchor = square(10, 10, 5);
        let task = Task {
            shapes: vec![Shape { cls: 0, sign: 1.0, ring: &poly, tags: None }, Shape { cls: 2, sign: 1.0, ring: &bar, tags: None }],
            k: 6, has_board: false, anchors: vec![&anchor], remove_dead: true, min_area: 0.0, min_size: 0.0, morph: None,
        };
        let (isl, stats) = solve(&task).unwrap();
        assert_eq!(isl.len(), 1);
        assert_eq!(stats.dead_islands, 1);
        assert!(stats.passes >= 2);
    }

    /// The blocked loops (vector lanes in the simd128 module, their plain-Rust model here) give
    /// the scalar loops' islands and stats on random tasks full of crossings, shared and
    /// collinear edges, and on grids crowded enough that cells hold many candidates.
    #[test]
    fn blocked_loops_match_scalar() {
        let mut seed = 0x5eedu32;
        let mut int = |n: i32| { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); ((seed as f64 / 4294967296.0) * n as f64) as i32 };
        let (mut compared, mut copper) = (0, 0);
        for trial in 0..600 {
            let grid = [8, 40, 3000, 2_000_000, 16_000_000][trial % 5];
            let k = 6 + int(3) as usize;
            let mut rings: Vec<(u32, f64, Vec<i32>, Option<Vec<i32>>)> = vec![(0, 1.0, vec![0, 0, grid, 0, grid, grid, 0, grid], None)];
            if int(2) == 0 { rings.push((1, 1.0, vec![-1, -1, grid - 2, -1, grid - 2, grid + 1, -1, grid + 1], None)); }
            for _ in 0..int(40) {
                let (x, y, w, h) = (int(grid), int(grid), 1 + int(grid / 2), 1 + int(grid / 2));
                let mut r = Vec::new();
                match int(4) {
                    0 => r.extend([x, y, x + w, y, x + w, y + h, x, y + h]),
                    1 => for _ in 0..3 + int(5) { r.push(int(grid)); r.push(int(grid)); },
                    2 => { let n = 6 + int(30); let rad = 1 + int(grid / 3) as i64;
                        for i in 0..n { let a = 6.283 * i as f64 / n as f64;
                            r.push((x as f64 + rad as f64 * a.cos()).round() as i32); r.push((y as f64 + rad as f64 * a.sin()).round() as i32); } }
                    _ => r.extend([x, y, x + w, y, x + w, y + 1, x + 1, y + 1, x + 1, y + h, x, y + h]),
                }
                for v in r.iter_mut() { *v = (*v).clamp(-16_777_216, 16_777_216); }
                let tags = if int(3) == 0 { Some((0..r.len() / 2).map(|_| if int(2) == 0 { int(4) } else { -1 }).collect()) } else { None };
                rings.push(([2, 2, 3, 4, 5, 6, 7][int(7) as usize] % k as u32, if int(5) == 0 { -1.0 } else { 1.0 }, r, tags));
            }
            let anchors: Vec<Vec<i32>> = (0..int(5)).map(|_| { let (x, y) = (int(grid), int(grid)); vec![x, y, x + 1 + int(grid / 8), y, x, y + 1 + int(grid / 8)] }).collect();
            let task = Task {
                shapes: rings.iter().map(|(c, s, r, t)| Shape { cls: *c, sign: *s, ring: r, tags: t.as_deref() }).collect(),
                k, has_board: rings.get(1).is_some_and(|r| r.0 == 1), anchors: anchors.iter().map(|a| a.as_slice()).collect(),
                remove_dead: int(2) == 0, min_area: 0.0, min_size: 0.0, morph: None,
            };
            let (scalar, blocked) = (solve_with(&task, false), solve_with(&task, true));
            assert_eq!(scalar, blocked, "trial {trial}");
            compared += 1;
            if scalar.is_ok_and(|(isl, _)| !isl.is_empty()) { copper += 1; }
        }
        assert!(compared == 600 && copper > 150, "{copper} tasks with copper");
        // Rings of every length (both tails of the two-edge steps) and points on edges, at vertices,
        // inside and outside.
        for n in 0..12usize {
            let r: Vec<f64> = (0..n).flat_map(|i| { let a = 6.283 * i as f64 / n.max(1) as f64; [(100.0 * a.cos()).round(), (100.0 * a.sin()).round()] }).collect();
            for (px, py) in [(0.0, 0.0), (100.0, 0.0), (50.0, 0.0), (200.0, 5.0), (-100.0, 0.0), (99.0, 3.0), (0.0, 100.0)] {
                assert_eq!(point_in_ring(px, py, &r), point_in_ring_ys(px, py, &r, &ring_ys(&r, true)), "ring of {n}, ({px}, {py})");
            }
        }
    }

    #[test]
    fn refuses_bad_input() {
        let poly = square(0, 0, 10);
        let t = |cls, k| Task { shapes: vec![Shape { cls, sign: 1.0, ring: &poly, tags: None }], k, has_board: false, anchors: vec![], remove_dead: false, min_area: 0.0, min_size: 0.0, morph: None };
        assert_eq!(solve(&t(6, 6)).err(), Some(Error::Invalid));
        assert_eq!(solve(&t(0, 3)).err(), Some(Error::Invalid));
        let big = square(0, 0, 20_000_000);
        let task = Task { shapes: vec![Shape { cls: 0, sign: 1.0, ring: &big, tags: None }], k: 6, has_board: false, anchors: vec![], remove_dead: false, min_area: 0.0, min_size: 0.0, morph: None };
        assert_eq!(solve(&task).err(), Some(Error::Fallback));
        let tags = [1, 2];
        let task = Task { shapes: vec![Shape { cls: 0, sign: 1.0, ring: &poly, tags: Some(&tags) }], k: 6, has_board: false, anchors: vec![], remove_dead: false, min_area: 0.0, min_size: 0.0, morph: None };
        assert_eq!(solve(&task).err(), Some(Error::Invalid));
    }

    // Remove Necks: two squares joined by a bar narrower than the template are cut apart; a wider
    // bar stays. Outlines Only leaves a band inside the boundary.
    #[test]
    fn necks_and_outlines() {
        let poly = vec![0, 0, 1000, 0, 1000, 400, 0, 400];
        let gap = |w: i32| (vec![480, -10, 520, -10, 520, 200 - w / 2, 480, 200 - w / 2], vec![480, 200 + w / 2, 520, 200 + w / 2, 520, 410, 480, 410]);
        // A 12-gon of narrowest half-width 20 (vertices at angle pi/12 + 2 pi i / 12, radius 20 / cos(pi / 12)).
        let tmpl = |r: f64| { let mut t = vec![0i32; 24]; let rr = r / (core::f64::consts::PI / 12.0).cos();
            for i in 0..6 { let a = core::f64::consts::PI / 12.0 + core::f64::consts::TAU * i as f64 / 12.0; let (x, y) = (js_round(rr * a.cos()) as i32, js_round(rr * a.sin()) as i32); t[2 * i] = x; t[2 * i + 1] = y; t[2 * (i + 6)] = -x; t[2 * (i + 6) + 1] = -y; } t };
        let (t, u) = (tmpl(20.0), tmpl(23.0));
        for (w, pieces) in [(30, 2), (60, 1)] {
            let (lo, hi) = gap(w);
            let task = Task { shapes: vec![Shape { cls: 0, sign: 1.0, ring: &poly, tags: None }, Shape { cls: 2, sign: 1.0, ring: &lo, tags: None }, Shape { cls: 2, sign: 1.0, ring: &hi, tags: None }],
                k: 6, has_board: false, anchors: vec![], remove_dead: false, min_area: 0.0, min_size: 0.0, morph: Some(Morph { mode: 1, t: &t, u: &u, keep: vec![] }) };
            let (isl, _) = solve(&task).unwrap();
            assert_eq!(isl.len(), pieces, "bar {w}");
        }
        let task = Task { shapes: vec![Shape { cls: 0, sign: 1.0, ring: &poly, tags: None }], k: 6, has_board: false, anchors: vec![], remove_dead: false,
            min_area: 0.0, min_size: 0.0, morph: Some(Morph { mode: 2, t: &t, u: &[], keep: vec![] }) };
        let (isl, _) = solve(&task).unwrap();
        assert_eq!(isl.len(), 1);
        assert_eq!(isl[0].holes.len(), 1);
    }
}
