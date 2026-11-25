//! Airwires (ratsnest) for every net in one call: connectivity.js `airwireEdges`.
//!
//! Each net's islands are joined by a Euclidean minimum spanning forest over their anchors.
//! The JS finds it with Borůvka rounds over a k-d tree and outputs each round's joins in
//! order, so the output order is part of the result. The result must equal the JS exactly,
//! under the same strict total order: squared distance, then the text of
//! `JSON.stringify([a.key, b.key])` with each pair oriented so that `a.key <= b.key`.
//!
//! Under a strict total order the spanning forest is unique, and the cheapest edge leaving
//! any group of islands is one of its edges (the cut property). So a Borůvka round, which
//! joins each component to its cheapest outgoing edge, can be replayed on the forest's own
//! edges. Small nets (up to `PRIM_MAX` anchors) find the forest with Prim's O(n²) scan, which
//! has no data-dependent pruning, and then replay the rounds; larger nets run the k-d tree
//! Borůvka directly. Two different pairs whose key texts are equal (only duplicate object IDs
//! produce them) make the JS answer depend on traversal order: then `Err(Fallback)`.

use core::cmp::Ordering;

pub const MAX_ANCHORS: usize = 4_000_000;
pub const MAX_KEY_UNITS: usize = 16 * 1024 * 1024;
pub const MAX_NETS: usize = 1_000_000;
/// Nets with at most this many anchors use Prim's scan.
pub const PRIM_MAX: u32 = 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// Malformed input (counts, offsets, island indices).
    Invalid,
    /// Valid input whose answer depends on JS traversal order (non-finite or duplicate keys),
    /// or that needs more memory than is available.
    Fallback,
}

pub struct Input<'a> {
    /// x, y per anchor.
    pub xy: &'a [f64],
    /// Island of each anchor, numbered within its net.
    pub island: &'a [u32],
    /// Per net: anchor count, island count. Anchors of a net are contiguous.
    pub nets: &'a [u32],
    /// Key of anchor i: units[offsets[i]..offsets[i + 1]] (UTF-16).
    pub offsets: &'a [u32],
    pub units: &'a [u16],
}

#[derive(Clone, Copy, Debug)]
pub struct Edge {
    /// Global anchor indices, a.key <= b.key.
    pub a: u32,
    pub b: u32,
    pub d: f64,
}

pub struct Output {
    /// Edges of every net in order.
    pub edges: Vec<Edge>,
    /// Edge count per net.
    pub counts: Vec<u32>,
}

/// Anchor keys (UTF-16), compared as the JS compares them: raw keys by code unit, and pair
/// texts through each key's JSON escape (`JSON.stringify(key)` without its quotes).
struct Keys<'a> {
    offsets: &'a [u32],
    units: &'a [u16],
    /// The first eight code units of each raw key and of each escaped key + `"`, zero-padded,
    /// as integers: when two differ they already order the strings.
    raw_head: Vec<u128>,
    escaped_head: Vec<u128>,
    /// Set when two different edges compare equal.
    ambiguous: bool,
}

impl<'a> Keys<'a> {
    fn new(offsets: &'a [u32], units: &'a [u16]) -> Result<Self, Error> {
        let n = offsets.len() - 1;
        let mut keys = Keys { offsets, units, raw_head: Vec::new(), escaped_head: Vec::new(), ambiguous: false };
        keys.raw_head.try_reserve_exact(n).map_err(|_| Error::Fallback)?;
        keys.escaped_head.try_reserve_exact(n).map_err(|_| Error::Fallback)?;
        fn head(units: impl Iterator<Item = u16>) -> u128 {
            let (mut h, mut k) = (0u128, 0);
            for u in units.take(8) { h = h << 16 | u as u128; k += 1; }
            if k == 0 { 0 } else { h << (16 * (8 - k)) }
        }
        for i in 0..n as u32 {
            let h = head(keys.raw(i).iter().copied());
            keys.raw_head.push(h);
            let h = head(keys.escaped(i));
            keys.escaped_head.push(h);
        }
        Ok(keys)
    }

    /// The escaped key followed by the closing quote.
    fn escaped(&self, i: u32) -> impl Iterator<Item = u16> + '_ {
        crate::jskey::Escaped::new(self.raw(i)).chain([b'"' as u16])
    }

    fn raw(&self, i: u32) -> &[u16] {
        let i = i as usize;
        &self.units[self.offsets[i] as usize..self.offsets[i + 1] as usize]
    }

    /// The edge as the JS builds it: a.key <= b.key (code-unit order).
    fn orient(&self, p: u32, q: u32, d: f64) -> Edge {
        let o = self.raw_head[p as usize].cmp(&self.raw_head[q as usize]).then_with(|| self.raw(p).cmp(self.raw(q)));
        if o == Ordering::Greater { Edge { a: q, b: p, d } } else { Edge { a: p, b: q, d } }
    }

    /// Orders `escaped(x) + '"'` against `escaped(y) + '"'`. The JSON text of a pair,
    /// `["` esc(a) `","` esc(b) `"]`, then orders exactly as (that of a, that of b):
    /// escaping is a prefix code whose code words never start with `"`.
    fn order_escaped(&self, x: u32, y: u32) -> Ordering {
        self.escaped_head[x as usize].cmp(&self.escaped_head[y as usize]).then_with(|| self.escaped(x).cmp(self.escaped(y)))
    }

    /// The JS order of two oriented edges: length, then JSON key text.
    fn order(&mut self, x: &Edge, y: &Edge) -> Ordering {
        let o = x.d.partial_cmp(&y.d).unwrap_or(Ordering::Equal)
            .then_with(|| self.order_escaped(x.a, y.a))
            .then_with(|| self.order_escaped(x.b, y.b));
        if o == Ordering::Equal && (x.a != y.a || x.b != y.b) {
            self.ambiguous = true;
        }
        o
    }
}

struct Node {
    lo: [f64; 2],
    hi: [f64; 2],
    /// Slots start..end of the tree order.
    start: u32,
    end: u32,
    /// Children; 0 for a leaf (node 0 is the root, never a child).
    left: u32,
    right: u32,
    /// The one component every anchor below belongs to this round, or u32::MAX.
    root: u32,
}

const LEAF: usize = 8;

/// A k-d tree over one net's anchors, with coordinates copied into tree order.
struct Tree {
    nodes: Vec<Node>,
    xy: Vec<[f64; 2]>,
    /// Global anchor index of each slot.
    id: Vec<u32>,
    /// Component of each slot (this round).
    root: Vec<u32>,
}

impl Tree {
    fn build(xy: &[f64], first: u32, count: u32) -> Tree {
        let mut id: Vec<u32> = (first..first + count).collect();
        let mut nodes = Vec::with_capacity(4 * (count as usize / LEAF + 1));
        Self::split(&mut nodes, &mut id, xy, 0, count as usize);
        let xy = id.iter().map(|&p| [xy[2 * p as usize], xy[2 * p as usize + 1]]).collect();
        Tree { nodes, xy, root: vec![0; id.len()], id }
    }

    fn split(nodes: &mut Vec<Node>, order: &mut [u32], xy: &[f64], start: usize, end: usize) -> u32 {
        let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        for &p in &order[start..end] {
            for k in 0..2 {
                let v = xy[2 * p as usize + k];
                lo[k] = lo[k].min(v);
                hi[k] = hi[k].max(v);
            }
        }
        let id = nodes.len() as u32;
        nodes.push(Node { lo, hi, start: start as u32, end: end as u32, left: 0, right: 0, root: u32::MAX });
        if end - start > LEAF {
            let axis = if hi[0] - lo[0] >= hi[1] - lo[1] { 0 } else { 1 };
            let mid = (end - start) / 2;
            order[start..end].select_nth_unstable_by(mid, |&a, &b| {
                xy[2 * a as usize + axis].total_cmp(&xy[2 * b as usize + axis])
            });
            let left = Self::split(nodes, order, xy, start, start + mid);
            let right = Self::split(nodes, order, xy, start + mid, end);
            let node = &mut nodes[id as usize];
            node.left = left;
            node.right = right;
        }
        id
    }

    /// Children come after their parent, so one backwards pass marks every node.
    fn mark(&mut self) {
        for i in (0..self.nodes.len()).rev() {
            let n = &self.nodes[i];
            let root = if n.left == 0 {
                let slots = &self.root[n.start as usize..n.end as usize];
                if slots.iter().all(|&r| r == slots[0]) { slots[0] } else { u32::MAX }
            } else {
                let (a, b) = (self.nodes[n.left as usize].root, self.nodes[n.right as usize].root);
                if a == b { a } else { u32::MAX }
            };
            self.nodes[i].root = root;
        }
    }
}

fn box_distance(p: [f64; 2], n: &Node) -> f64 {
    let dx = (n.lo[0] - p[0]).max(0.0).max(p[0] - n.hi[0]);
    let dy = (n.lo[1] - p[1]).max(0.0).max(p[1] - n.hi[1]);
    dx * dx + dy * dy
}

/// The cheapest edge from slot `s` to another component, given the component's best so far.
fn nearest(keys: &mut Keys, tree: &Tree, s: usize, best: &mut Option<Edge>) {
    let at = tree.xy[s];
    let (root, p) = (tree.root[s], tree.id[s]);
    let mut stack = [(0u32, 0.0f64); 64];
    let mut top = 1;
    while top > 0 {
        top -= 1;
        let (id, bound) = stack[top];
        let n = &tree.nodes[id as usize];
        if n.root == root || best.is_some_and(|b| bound > b.d) {
            continue;
        }
        if n.left == 0 {
            for t in n.start as usize..n.end as usize {
                if tree.root[t] == root {
                    continue;
                }
                let (dx, dy) = (at[0] - tree.xy[t][0], at[1] - tree.xy[t][1]);
                let d = dx * dx + dy * dy;
                if best.is_some_and(|b| d > b.d) {
                    continue;
                }
                let c = keys.orient(p, tree.id[t], d);
                if best.is_none_or(|b| keys.order(&c, &b) == Ordering::Less) {
                    *best = Some(c);
                }
            }
            continue;
        }
        let (l, r) = (&tree.nodes[n.left as usize], &tree.nodes[n.right as usize]);
        let (dl, dr) = (box_distance(at, l), box_distance(at, r));
        // Depth is at most log2(MAX_ANCHORS / LEAF) + 1, far below the stack size.
        if dl <= dr {
            stack[top] = (n.right, dr);
            stack[top + 1] = (n.left, dl);
        } else {
            stack[top] = (n.left, dl);
            stack[top + 1] = (n.right, dr);
        }
        top += 2;
    }
}

struct Sets {
    parent: Vec<u32>,
    size: Vec<u32>,
}

impl Sets {
    fn new(n: usize) -> Self { Sets { parent: (0..n as u32).collect(), size: vec![1; n] } }
    fn root(&mut self, mut i: u32) -> u32 {
        while i != self.parent[i as usize] {
            let g = self.parent[self.parent[i as usize] as usize];
            self.parent[i as usize] = g;
            i = g;
        }
        i
    }
    fn join(&mut self, i: u32, j: u32) -> bool {
        let (mut i, mut j) = (self.root(i), self.root(j));
        if i == j { return false; }
        if self.size[i as usize] < self.size[j as usize] { core::mem::swap(&mut i, &mut j); }
        self.parent[j as usize] = i;
        self.size[i as usize] += self.size[j as usize];
        true
    }
}

pub fn validate(input: &Input) -> Result<(), Error> {
    let n = input.island.len();
    if n > MAX_ANCHORS || input.xy.len() != 2 * n || input.offsets.len() != n + 1
        || input.units.len() > MAX_KEY_UNITS || input.nets.len() % 2 != 0 || input.nets.len() / 2 > MAX_NETS
    {
        return Err(Error::Invalid);
    }
    if input.offsets[0] != 0 || input.offsets[n] as usize != input.units.len()
        || input.offsets.windows(2).any(|w| w[0] > w[1])
    {
        return Err(Error::Invalid);
    }
    let mut first = 0usize;
    for net in input.nets.chunks_exact(2) {
        let (count, islands) = (net[0] as usize, net[1]);
        let end = first.checked_add(count).filter(|&e| e <= n).ok_or(Error::Invalid)?;
        if input.island[first..end].iter().any(|&i| i >= islands) {
            return Err(Error::Invalid);
        }
        first = end;
    }
    if first != n {
        return Err(Error::Invalid);
    }
    if input.xy.iter().any(|v| !v.is_finite()) {
        return Err(Error::Fallback);
    }
    Ok(())
}

pub fn run(input: &Input) -> Result<Output, Error> {
    validate(input)?;
    let mut keys = Keys::new(input.offsets, input.units)?;
    let mut output = Output { edges: Vec::new(), counts: Vec::with_capacity(input.nets.len() / 2) };
    let mut first = 0u32;
    for net in input.nets.chunks_exact(2) {
        let (count, islands) = (net[0], net[1]);
        let before = output.edges.len();
        if islands >= 2 && count > 0 {
            if count <= PRIM_MAX {
                let forest = prim(input, &mut keys, first, count, islands);
                replay(input, &mut keys, forest, islands, &mut output.edges);
            } else {
                boruvka(input, &mut keys, first, count, islands, &mut output.edges);
            }
            if keys.ambiguous {
                return Err(Error::Fallback);
            }
        }
        output.counts.push((output.edges.len() - before) as u32);
        first += count;
    }
    Ok(output)
}

/// The spanning forest of one net's islands (Prim over anchors; a whole island joins at once).
/// Anchors not yet joined are kept compacted in parallel arrays, so the scans stream.
fn prim(input: &Input, keys: &mut Keys, first: u32, count: u32, islands: u32) -> Vec<Edge> {
    let island = |i: u32| input.island[(first + i) as usize];
    // Anchors of each island (counting sort), as global indices.
    let mut start = vec![0u32; islands as usize + 1];
    for i in 0..count { start[island(i) as usize + 1] += 1; }
    for k in 0..islands as usize { start[k + 1] += start[k]; }
    let mut members = vec![0u32; count as usize];
    let mut fill = start.clone();
    for i in 0..count { let k = island(i) as usize; members[fill[k] as usize] = first + i; fill[k] += 1; }

    // The rest: global index, coordinates, island, best squared distance and its tree anchor.
    let mut added = island(0);
    let (mut id, mut x, mut y, mut isl, mut bd, mut from) = (vec![], vec![], vec![], vec![], vec![], vec![]);
    for i in 0..count {
        if island(i) == added { continue; }
        let g = (first + i) as usize;
        id.push(g as u32); x.push(input.xy[2 * g]); y.push(input.xy[2 * g + 1]); isl.push(island(i));
        bd.push(f64::INFINITY); from.push(u32::MAX);
    }
    let mut forest = Vec::with_capacity(islands as usize - 1);
    // One pass per joined island: relax the rest against its anchors and pick the cheapest
    // edge to the tree. Joined anchors are marked and compacted away once a quarter is dead.
    const DEAD: u32 = u32::MAX;
    let mut fresh: Vec<(f64, f64, u32)> = Vec::new();
    let mut dead = 0usize;
    loop {
        let k = added as usize;
        fresh.clear();
        fresh.extend(members[start[k] as usize..start[k + 1] as usize].iter().map(|&a| (input.xy[2 * a as usize], input.xy[2 * a as usize + 1], a)));
        let n = id.len();
        let (sid, sx, sy, sisl, sbd, sfrom) = (&id[..n], &x[..n], &y[..n], &mut isl[..n], &mut bd[..n], &mut from[..n]);
        let mut pick = usize::MAX;
        let (mut pick_d, mut pick_via, mut pick_id) = (f64::INFINITY, 0u32, 0u32);
        for j in 0..n {
            if sisl[j] == added { sisl[j] = DEAD; dead += 1; }
            if sisl[j] == DEAD { continue; }
            let (jx, jy, jid) = (sx[j], sy[j], sid[j]);
            let (mut best, mut via) = (sbd[j], sfrom[j]);
            for &(ax, ay, a) in &fresh {
                let (dx, dy) = (ax - jx, ay - jy);
                let d = dx * dx + dy * dy;
                if d <= best {
                    if d < best {
                        best = d;
                        via = a;
                    } else {
                        let (p, q) = (keys.orient(a, jid, d), keys.orient(via, jid, d));
                        if keys.order(&p, &q) == Ordering::Less { via = a; }
                    }
                }
            }
            if via != sfrom[j] { sbd[j] = best; sfrom[j] = via; }
            if best <= pick_d && (pick == usize::MAX || best < pick_d || {
                let (p, q) = (keys.orient(via, jid, best), keys.orient(pick_via, pick_id, pick_d));
                keys.order(&p, &q) == Ordering::Less
            }) {
                pick = j;
                (pick_d, pick_via, pick_id) = (best, via, jid);
            }
        }
        if pick == usize::MAX { break; }
        forest.push(keys.orient(pick_via, pick_id, pick_d));
        added = isl[pick];
        if dead * 4 > n {
            let mut w = 0;
            for j in 0..n {
                if isl[j] == DEAD { continue; }
                id[w] = id[j]; x[w] = x[j]; y[w] = y[j]; isl[w] = isl[j]; bd[w] = bd[j]; from[w] = from[j];
                w += 1;
            }
            for v in [&mut id, &mut isl, &mut from] { v.truncate(w); }
            for v in [&mut x, &mut y, &mut bd] { v.truncate(w); }
            dead = 0;
        }
    }
    forest
}

/// Replays the JS Borůvka rounds on the forest's edges: each round, every component takes its
/// cheapest incident forest edge (its cheapest outgoing edge overall), and the round's edges are
/// joined in order.
fn replay(input: &Input, keys: &mut Keys, forest: Vec<Edge>, islands: u32, out: &mut Vec<Edge>) {
    let mut group = Sets::new(islands as usize);
    let mut alive = forest;
    let mut best: Vec<Option<usize>> = vec![None; islands as usize];
    while !alive.is_empty() {
        for (k, e) in alive.iter().enumerate() {
            for r in [group.root(input.island[e.a as usize]), group.root(input.island[e.b as usize])] {
                let slot = &mut best[r as usize];
                if slot.is_none_or(|b| keys.order(e, &alive[b]) == Ordering::Less) {
                    *slot = Some(k);
                }
            }
        }
        let mut round: Vec<usize> = best.iter_mut().filter_map(|b| b.take()).collect();
        round.sort_unstable();
        round.dedup();
        round.sort_by(|&x, &y| keys.order(&alive[x], &alive[y]));
        let mut taken = vec![false; alive.len()];
        for k in round {
            let e = alive[k];
            if group.join(input.island[e.a as usize], input.island[e.b as usize]) {
                out.push(e);
            }
            taken[k] = true;
        }
        let mut k = 0;
        alive.retain(|_| { k += 1; !taken[k - 1] });
    }
}

/// Borůvka rounds over a k-d tree, as the JS does it (large nets).
fn boruvka(input: &Input, keys: &mut Keys, first: u32, count: u32, islands: u32, out: &mut Vec<Edge>) {
    let mut tree = Tree::build(input.xy, first, count);
    let mut group = Sets::new(islands as usize);
    let mut best: Vec<Option<Edge>> = vec![None; islands as usize];
    let mut joined = 0u32;
    while joined < islands - 1 {
        for s in 0..tree.id.len() {
            tree.root[s] = group.root(input.island[tree.id[s] as usize]);
        }
        tree.mark();
        for s in 0..tree.id.len() {
            nearest(keys, &tree, s, &mut best[tree.root[s] as usize]);
        }
        let mut round: Vec<Edge> = best.iter_mut().filter_map(|b| b.take()).collect();
        round.sort_by(|x, y| keys.order(x, y));
        let mut joins = 0;
        for e in round {
            if !group.join(input.island[e.a as usize], input.island[e.b as usize]) { continue; }
            joins += 1;
            out.push(e);
        }
        joined += joins;
        if joins == 0 { break; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Net { points: Vec<(f64, f64, u32, String)>, islands: u32 }

    fn solve(nets: &[Net]) -> Result<Vec<Vec<(String, String, f64)>>, Error> {
        let (mut xy, mut island, mut meta, mut offsets, mut units) = (vec![], vec![], vec![], vec![0u32], vec![]);
        let mut names = vec![];
        for net in nets {
            meta.push(net.points.len() as u32);
            meta.push(net.islands);
            for (x, y, i, key) in &net.points {
                xy.extend([*x, *y]);
                island.push(*i);
                units.extend(key.encode_utf16());
                offsets.push(units.len() as u32);
                names.push(key.clone());
            }
        }
        let out = run(&Input { xy: &xy, island: &island, nets: &meta, offsets: &offsets, units: &units })?;
        let mut edges = out.edges.iter();
        Ok(out.counts.iter().map(|&c| (0..c).map(|_| {
            let e = edges.next().unwrap();
            (names[e.a as usize].clone(), names[e.b as usize].clone(), e.d)
        }).collect()).collect())
    }

    /// Brute-force Kruskal with the same total order (independent oracle).
    fn oracle(net: &Net) -> Vec<(String, String, f64)> {
        let json = |a: &str, b: &str| format!("{:?}", [a, b]); // same as JSON for ASCII keys without escapes
        let mut edges = vec![];
        for (i, p) in net.points.iter().enumerate() {
            for q in &net.points[i + 1..] {
                if p.2 == q.2 { continue; }
                let (a, b) = if p.3 <= q.3 { (p, q) } else { (q, p) };
                edges.push(((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2), json(&a.3, &b.3), a.clone(), b.clone()));
            }
        }
        edges.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap().then(x.1.cmp(&y.1)));
        let mut sets = Sets::new(net.islands as usize);
        edges.into_iter().filter(|e| sets.join(e.2 .2, e.3 .2)).map(|e| (e.2 .3, e.3 .3, e.0)).collect()
    }

    fn sorted(mut v: Vec<(String, String, f64)>) -> Vec<(String, String, f64)> {
        v.sort_by(|x, y| x.partial_cmp(y).unwrap());
        v
    }

    #[test]
    fn grid_with_ties_matches_kruskal() {
        // Integer grid: many equal distances, so key order decides.
        let mut seed = 7u32;
        let mut rnd = || { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); seed >> 8 };
        for size in [2usize, 3, 13, 40, 200] {
            let islands = (size as u32 / 3).max(2);
            let points: Vec<_> = (0..size).map(|i| {
                let isl = if i < islands as usize { i as u32 } else { rnd() % islands };
                ((rnd() % 9) as f64, (rnd() % 7) as f64 * 0.5, isl, format!("[\"o{}\",0]/{}", rnd() % 100000, i))
            }).collect();
            let net = Net { points, islands };
            let got = solve(std::slice::from_ref(&net)).unwrap().remove(0);
            assert_eq!(got.len(), islands as usize - 1);
            // Kruskal and Borůvka give the same forest under a strict total order.
            assert_eq!(sorted(got), sorted(oracle(&net)));
        }
    }

    /// Prim + replay (small nets) and the k-d tree Borůvka (large nets, the JS algorithm) give
    /// the same edges in the same order, on grids full of ties and with escaped keys.
    #[test]
    fn replayed_rounds_equal_direct_boruvka() {
        let mut seed = 99u32;
        let mut rnd = || { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); seed >> 8 };
        for trial in 0..60 {
            let n = 2 + rnd() as usize % 300;
            let islands = 2 + rnd() % (n as u32 - 1).min(150);
            let grid = trial % 3 != 0;
            let (mut xy, mut island, mut offsets, mut units) = (vec![], vec![], vec![0u32], vec![]);
            for i in 0..n {
                let (x, y) = if grid { ((rnd() % 12) as f64 * 0.25, (rnd() % 9) as f64 * 0.5) } else { (rnd() as f64 / 7e3, rnd() as f64 / 9e3) };
                xy.extend([x, y]);
                island.push(if (i as u32) < islands { i as u32 } else { rnd() % islands });
                let key = format!("[\"o{}{}\",{}]/{}", rnd() % 50, ["", "\\", "a\"", "\u{1}"][rnd() as usize % 4], rnd() % 3, i);
                units.extend(key.encode_utf16());
                offsets.push(units.len() as u32);
            }
            let input = Input { xy: &xy, island: &island, nets: &[n as u32, islands], offsets: &offsets, units: &units };
            let mut keys = Keys::new(&offsets, &units).unwrap();
            let (mut a, mut b) = (vec![], vec![]);
            let forest = prim(&input, &mut keys, 0, n as u32, islands);
            replay(&input, &mut keys, forest, islands, &mut a);
            boruvka(&input, &mut keys, 0, n as u32, islands, &mut b);
            assert!(!keys.ambiguous);
            assert_eq!(a.len(), islands as usize - 1);
            assert_eq!(a.iter().map(|e| (e.a, e.b, e.d)).collect::<Vec<_>>(), b.iter().map(|e| (e.a, e.b, e.d)).collect::<Vec<_>>(), "trial {}", trial);
        }
    }

    #[test]
    fn escaped_order_equals_json_pair_text_order() {
        let words: Vec<Vec<u16>> = ["", "a", "a!", "a#", "a\"", "a\\", "\"", "A", "a\u{1}", "a\n", "ab", "é", "\u{7f}"]
            .iter().map(|w| w.encode_utf16().collect()).chain([vec![0xd800], vec![0xd800, 0xdc00], vec![0xdc00]]).collect();
        let (mut offsets, mut units) = (vec![0u32], vec![]);
        for w in &words { units.extend(w); offsets.push(units.len() as u32); }
        let mut keys = Keys::new(&offsets, &units).unwrap();
        let n = words.len() as u32;
        for a in 0..n { for b in 0..n { for c in 0..n { for d in 0..n {
            let (x, y) = (Edge { a, b, d: 1.0 }, Edge { a: c, b: d, d: 1.0 });
            let want = crate::jskey::compare_pair_json(&words[a as usize], &words[b as usize], &words[c as usize], &words[d as usize]);
            assert_eq!(keys.order(&x, &y), want);
        }}}}
        assert!(!keys.ambiguous);
    }

    #[test]
    fn several_nets_and_trivial_ones() {
        let a = Net { points: vec![(0.0, 0.0, 0, "a".into()), (3.0, 4.0, 1, "b".into())], islands: 2 };
        let one = Net { points: vec![(0.0, 0.0, 0, "c".into())], islands: 1 };
        let got = solve(&[a, one]).unwrap();
        assert_eq!(got, vec![vec![("a".into(), "b".into(), 25.0)], vec![]]);
    }

    #[test]
    fn duplicate_keys_fall_back_and_bad_input_is_rejected() {
        let dup = Net { points: vec![(0.0, 0.0, 0, "k".into()), (1.0, 0.0, 1, "k".into()), (-1.0, 0.0, 2, "k".into())], islands: 3 };
        assert_eq!(solve(&[dup]).err(), Some(Error::Fallback));
        let nan = Net { points: vec![(f64::NAN, 0.0, 0, "a".into()), (1.0, 0.0, 1, "b".into())], islands: 2 };
        assert_eq!(solve(&[nan]).err(), Some(Error::Fallback));
        let bad = Net { points: vec![(0.0, 0.0, 5, "a".into())], islands: 2 };
        assert_eq!(solve(&[bad]).err(), Some(Error::Invalid));
        let xy = [0.0, 0.0];
        let input = Input { xy: &xy, island: &[0], nets: &[2, 1], offsets: &[0, 0], units: &[] };
        assert_eq!(run(&input).err(), Some(Error::Invalid));
        let input = Input { xy: &xy, island: &[0], nets: &[1, 1], offsets: &[0, 3], units: &[1] };
        assert_eq!(run(&input).err(), Some(Error::Invalid));
    }
}
