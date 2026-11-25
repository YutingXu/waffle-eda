//! The DRC broad phase over feature boxes (app/rules.js `pairs(F, reach, visit)`), visiting the
//! candidate pairs in exactly the order the JS loop visits them, so what callers build from the
//! visits (the first of equal distances, the order of results) is unchanged: a uniform grid of
//! cell `size`; each feature not spanning more than 4096 cells visits the later features in the
//! cells its box grown by `reach` covers (rows, then columns, then each cell's list in feature
//! order, every feature once), when the boxes are within `reach`; then each big feature visits
//! every other feature (a later big one only from the earlier).
//!
//! (A WebAssembly copy of connectivity.js's contact sweep measured no faster end to end in
//! JavaScriptCore or V8: there the sweep is a small part of the pass. It is not offered.)
//!
//! Every cell key is computed as the JS computes it, `(x + OFF) * SPAN + (y + OFF)` in f64, and
//! compared by its bits, so cells the JS map merges are merged here too. Coordinates the JS loop
//! cannot step through exactly (2^52 cells and beyond) are left to it (`Error::Fallback`).

pub enum Error { Invalid, Fallback }

const OFF: f64 = 1048576.0;
const SPAN: f64 = 2097152.0;
const LIMIT: f64 = 4503599627370496.0; // 2^52
/// Visits beyond this are left to the JS loop (u32 pairs, wasm32 memory).
pub const MAX_PAIRS: usize = 48 * 1024 * 1024;

#[inline]
fn key(x: f64, y: f64) -> u64 { ((x + OFF) * SPAN + (y + OFF)).to_bits() }

#[inline]
fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

/// Cell key -> the features in it, in insertion order (compressed rows).
struct Cells { slots: Vec<u64>, used: Vec<u32>, start: Vec<u32>, items: Vec<u32>, mask: usize }

impl Cells {
    /// `entries`: (key, feature) in feature order.
    fn build(entries: &[(u64, u32)]) -> Cells {
        let mut cap = 16usize;
        while cap < entries.len() * 2 { cap <<= 1; }
        let mut c = Cells { slots: vec![0; cap], used: vec![0; cap], start: Vec::new(), items: vec![0; entries.len()], mask: cap - 1 };
        // used[s] = 1 + bucket index; buckets numbered in first-seen order.
        let mut counts: Vec<u32> = Vec::new();
        let mut bucket_of = Vec::with_capacity(entries.len());
        for &(k, _) in entries {
            let b = c.find_or_insert(k, &mut counts);
            counts[b] += 1;
            bucket_of.push(b as u32);
        }
        c.start = Vec::with_capacity(counts.len() + 1);
        let mut at = 0u32;
        for &n in &counts { c.start.push(at); at += n; }
        c.start.push(at);
        let mut fill: Vec<u32> = c.start[..counts.len()].to_vec();
        for (e, &(_, i)) in entries.iter().enumerate() {
            let b = bucket_of[e] as usize;
            c.items[fill[b] as usize] = i;
            fill[b] += 1;
        }
        c
    }
    fn find_or_insert(&mut self, k: u64, counts: &mut Vec<u32>) -> usize {
        let mut s = mix(k) as usize & self.mask;
        loop {
            if self.used[s] == 0 {
                self.slots[s] = k;
                counts.push(0);
                self.used[s] = counts.len() as u32;
                return counts.len() - 1;
            }
            if self.slots[s] == k { return self.used[s] as usize - 1; }
            s = (s + 1) & self.mask;
        }
    }
    fn get(&self, k: u64) -> &[u32] {
        let mut s = mix(k) as usize & self.mask;
        loop {
            if self.used[s] == 0 { return &[]; }
            if self.slots[s] == k {
                let b = self.used[s] as usize - 1;
                return &self.items[self.start[b] as usize..self.start[b + 1] as usize];
            }
            s = (s + 1) & self.mask;
        }
    }
}

/// Whether a JS loop `for (v = a; v <= b; v++)` steps exactly (or runs no iteration).
#[inline]
fn steppable(a: f64, b: f64) -> bool { !(a <= b) || (a.abs() < LIMIT && b.abs() < LIMIT) }

fn push(out: &mut Vec<u32>, a: usize, b: usize) -> Result<(), Error> {
    if out.len() >= 2 * MAX_PAIRS { return Err(Error::Fallback); }
    out.push(a as u32); out.push(b as u32);
    Ok(())
}

/// rules.js pairs(): `boxes` [x0, y0, x1, y1] per feature.
pub fn grid(boxes: &[f64], size: f64, reach: f64) -> Result<Vec<u32>, Error> {
    if boxes.len() % 4 != 0 || boxes.len() / 4 > i32::MAX as usize { return Err(Error::Invalid); }
    let n = boxes.len() / 4;
    let mut out = Vec::new();
    if n < 2 { return Ok(out); }
    let b = |i: usize| -> &[f64] { &boxes[4 * i..4 * i + 4] };
    let cell = |v: f64| (v / size).floor();
    let mut entries: Vec<(u64, u32)> = Vec::new();
    let (mut big, mut is_big) = (Vec::new(), vec![false; n]);
    for i in 0..n {
        let q = b(i);
        let (x0, y0, x1, y1) = (cell(q[0]), cell(q[1]), cell(q[2]), cell(q[3]));
        if (x1 - x0 + 1.0) * (y1 - y0 + 1.0) > 4096.0 { big.push(i); is_big[i] = true; continue; }
        if !steppable(y0, y1) || !steppable(x0, x1) { return Err(Error::Fallback); }
        let mut y = y0;
        while y <= y1 {
            let mut x = x0;
            while x <= x1 { entries.push((key(x, y), i as u32)); x += 1.0; }
            y += 1.0;
        }
    }
    let cells = Cells::build(&entries);
    drop(entries);
    let near = |a: &[f64], o: &[f64]| !(o[0] - a[2] > reach || a[0] - o[2] > reach || o[1] - a[3] > reach || a[1] - o[3] > reach);
    let mut stamp = vec![-1i32; n];
    for i in 0..n {
        if is_big[i] { continue; }
        let q = b(i);
        let (x0, y0, x1, y1) = (cell(q[0] - reach), cell(q[1] - reach), cell(q[2] + reach), cell(q[3] + reach));
        if !steppable(y0, y1) || !steppable(x0, x1) { return Err(Error::Fallback); }
        let mut y = y0;
        while y <= y1 {
            let mut x = x0;
            while x <= x1 {
                for &j in cells.get(key(x, y)) {
                    let j = j as usize;
                    if j <= i || stamp[j] == i as i32 { continue; }
                    stamp[j] = i as i32;
                    if !near(q, b(j)) { continue; }
                    push(&mut out, i, j)?;
                }
                x += 1.0;
            }
            y += 1.0;
        }
    }
    for &i in &big {
        let q = b(i);
        for j in 0..n {
            if j == i || is_big[j] && j < i || !near(q, b(j)) { continue; }
            push(&mut out, i, j)?;
        }
    }
    Ok(out)
}
