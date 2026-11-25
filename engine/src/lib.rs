//! Waffle compute kernels, compiled to WebAssembly and embedded in app/engine-core.js by
//! scripts/build-engine.py. JavaScript stays the runtime: every kernel has a JS fallback that
//! gives the same answer, and the bridge (engine/bridge.js) uses it whenever this module is
//! missing, refuses an input or exceeds a size cap.
//!
//! ABI (see `abi` below). The module owns all of its memory. JS never passes a pointer in:
//! it asks for an input buffer of a given kind, slot and length (`in_f64(slot, n)` returns
//! where to write n values, or 0), fills it, calls a kernel, then reads output buffers whose
//! address and length the module reports. Kernels re-validate every count, offset and index
//! they read, because inputs come from untrusted design files.

pub mod airwire;
pub mod jskey;
pub mod pairs;
pub mod pour;

#[cfg(target_arch = "wasm32")]
mod abi {
    use crate::{airwire, pairs, pour};
    use core::cell::UnsafeCell;

    pub const SLOTS: usize = 4;
    /// The largest input buffer, in bytes (each buffer; wasm32 memory is 4 GiB at most).
    pub const MAX_BYTES: usize = 512 * 1024 * 1024;

    #[derive(Default)]
    struct State {
        f64_in: [Vec<f64>; SLOTS],
        u32_in: [Vec<u32>; SLOTS],
        u16_in: [Vec<u16>; SLOTS],
        i32_in: [Vec<i32>; SLOTS],
        f64_out: [Vec<f64>; SLOTS],
        u32_out: [Vec<u32>; SLOTS],
        i32_out: [Vec<i32>; SLOTS],
    }

    // WebAssembly here is single-threaded and never calls back into JS, so exactly one
    // export runs at a time and holds the only reference to the state.
    struct Global(UnsafeCell<Option<State>>);
    unsafe impl Sync for Global {}
    static STATE: Global = Global(UnsafeCell::new(None));

    fn state() -> &'static mut State {
        unsafe { (*STATE.0.get()).get_or_insert_with(State::default) }
    }

    fn input<T: Copy + Default>(buffers: &mut [Vec<T>; SLOTS], slot: u32, n: u32) -> *mut T {
        let (slot, n) = (slot as usize, n as usize);
        if slot >= SLOTS || n.saturating_mul(core::mem::size_of::<T>()) > MAX_BYTES {
            return core::ptr::null_mut();
        }
        let buffer = &mut buffers[slot];
        buffer.clear();
        if buffer.try_reserve_exact(n).is_err() {
            return core::ptr::null_mut();
        }
        buffer.resize(n, T::default());
        if n == 0 { 4 as *mut T } else { buffer.as_mut_ptr() } // non-null for empty inputs
    }

    #[no_mangle]
    extern "C" fn engine_version() -> u32 { 3 }

    #[no_mangle]
    extern "C" fn in_f64(slot: u32, n: u32) -> *mut f64 { input(&mut state().f64_in, slot, n) }
    #[no_mangle]
    extern "C" fn in_u32(slot: u32, n: u32) -> *mut u32 { input(&mut state().u32_in, slot, n) }
    #[no_mangle]
    extern "C" fn in_u16(slot: u32, n: u32) -> *mut u16 { input(&mut state().u16_in, slot, n) }
    #[no_mangle]
    extern "C" fn in_i32(slot: u32, n: u32) -> *mut i32 { input(&mut state().i32_in, slot, n) }

    #[no_mangle]
    extern "C" fn out_f64(slot: u32) -> *const f64 { state().f64_out.get(slot as usize).map_or(core::ptr::null(), |b| b.as_ptr()) }
    #[no_mangle]
    extern "C" fn out_f64_len(slot: u32) -> u32 { state().f64_out.get(slot as usize).map_or(0, |b| b.len() as u32) }
    #[no_mangle]
    extern "C" fn out_u32(slot: u32) -> *const u32 { state().u32_out.get(slot as usize).map_or(core::ptr::null(), |b| b.as_ptr()) }
    #[no_mangle]
    extern "C" fn out_u32_len(slot: u32) -> u32 { state().u32_out.get(slot as usize).map_or(0, |b| b.len() as u32) }
    #[no_mangle]
    extern "C" fn out_i32(slot: u32) -> *const i32 { state().i32_out.get(slot as usize).map_or(core::ptr::null(), |b| b.as_ptr()) }
    #[no_mangle]
    extern "C" fn out_i32_len(slot: u32) -> u32 { state().i32_out.get(slot as usize).map_or(0, |b| b.len() as u32) }

    /// Releases every buffer (the bridge calls it after a large job).
    #[no_mangle]
    extern "C" fn engine_reset() { unsafe { *STATE.0.get() = None; } }

    // ---- Airwires. Inputs: f64_in[0] x,y; u32_in[0] island; u32_in[1] per net (anchors,
    // islands); u32_in[2] key offsets; u16_in[0] key units. Outputs: u32_out[0] a,b per edge;
    // f64_out[0] squared length per edge; u32_out[1] edges per net. Returns the edge count,
    // -1 for invalid input, -2 when the JS fallback must decide. ----

    #[no_mangle]
    extern "C" fn airwire_run() -> i32 {
        let s = state();
        let input = airwire::Input {
            xy: &s.f64_in[0], island: &s.u32_in[0], nets: &s.u32_in[1], offsets: &s.u32_in[2], units: &s.u16_in[0],
        };
        let result = airwire::run(&input);
        for b in s.u32_out.iter_mut() { b.clear(); }
        s.f64_out[0].clear();
        match result {
            Ok(out) => {
                s.u32_out[0].extend(out.edges.iter().flat_map(|e| [e.a, e.b]));
                s.f64_out[0].extend(out.edges.iter().map(|e| e.d));
                s.u32_out[1] = out.counts;
                out.edges.len() as i32
            }
            Err(airwire::Error::Invalid) => -1,
            Err(airwire::Error::Fallback) => -2,
        }
    }

    // ---- DRC broad phase (pairs.rs). pairs_grid: f64_in[0] boxes [x0, y0, x1, y1] per feature,
    // f64_in[1] [size, reach]. Output: u32_out[0] the visited pairs (a, b), in visit order.
    // Returns the pair count, -1 for invalid input, -2 when the JS loop must run. ----

    fn pairs_out(result: Result<Vec<u32>, pairs::Error>) -> i32 {
        let s = state();
        match result {
            Ok(v) => { let n = (v.len() / 2) as i32; s.u32_out[0] = v; n }
            Err(e) => { s.u32_out[0] = Vec::new(); match e { pairs::Error::Invalid => -1, pairs::Error::Fallback => -2 } }
        }
    }
    #[no_mangle]
    extern "C" fn pairs_grid() -> i32 {
        let s = state();
        let (boxes, p) = (&s.f64_in[0], &s.f64_in[1]);
        if p.len() != 2 || !(p[0] > 0.0) || !p[0].is_finite() || p[1].is_nan() { return pairs_out(Err(pairs::Error::Invalid)); }
        let r = pairs::grid(boxes, p[0], p[1]);
        pairs_out(r)
    }

    // ---- Polygon pour solve (polygon-pour.js PourCore().solve). Inputs: u32_in[0] header
    // [k, hasBoard, removeDead, shapes, anchors, then per shape cls, sign (0 = +1, 1 = -1),
    // ring length, has tags; then per anchor ring length]; i32_in[0] every shape ring, then
    // its tags when it has them, in shape order, then every anchor ring; f64_in[0] [minArea,
    // minSize]; i32_in[1] Remove Necks / Outlines Only (pour_morph). Outputs: i32_out[0] the islands [count, then per island ring length, ring,
    // tag count, tags, link count, links, hole count, then per hole ring length, ring, tag
    // count, tags]; u32_out[0] stats [passes, unresolved, edges, merged, faces, rays (u32::MAX
    // when absent), face fallback, broken rings, dead islands]. Returns 0, -1 for invalid
    // input, -2 when the JS core must run. ----

    // i32_in[1]: Remove Necks / Outlines Only, [mode (0 none), template length, template, grown
    // template length, grown template, keep count, then per keep ring its length and ring].
    fn take_ring<'a>(rest: &mut &'a [i32]) -> Option<&'a [i32]> {
        let (&n, r) = rest.split_first()?;
        let (a, b) = r.split_at_checked(usize::try_from(n).ok()?)?;
        *rest = b;
        Some(a)
    }
    fn pour_morph(m: &[i32]) -> Option<Option<pour::Morph<'_>>> {
        let (&mode, mut rest) = m.split_first()?;
        if mode == 0 { return if rest.is_empty() { Some(None) } else { None }; }
        let t = take_ring(&mut rest)?;
        let u = take_ring(&mut rest)?;
        let (&nk, r) = rest.split_first()?;
        rest = r;
        let nk = usize::try_from(nk).ok()?;
        let mut keep = Vec::new();
        keep.try_reserve_exact(nk.min(rest.len())).ok()?;
        for _ in 0..nk { keep.push(take_ring(&mut rest)?); }
        if !rest.is_empty() { return None; }
        Some(Some(pour::Morph { mode: u32::try_from(mode).ok()?, t, u, keep }))
    }

    fn pour_task<'a>(header: &'a [u32], data: &'a [i32], params: &'a [f64], morph: &'a [i32]) -> Option<pour::Task<'a>> {
        let (&[k, has_board, remove_dead, shapes, anchors], rest) = header.split_first_chunk::<5>()?;
        let (shape_meta, rest) = rest.split_at_checked((shapes as usize).checked_mul(4)?)?;
        if rest.len() != anchors as usize || params.len() != 2 { return None; }
        let mut at = 0usize;
        let mut take = |n: usize| -> Option<&'a [i32]> { let s = data.get(at..at.checked_add(n)?)?; at += n; Some(s) };
        let mut task = pour::Task { shapes: Vec::new(), k: k as usize, has_board: has_board != 0, anchors: Vec::new(), remove_dead: remove_dead != 0, min_area: params[0], min_size: params[1],
            morph: pour_morph(morph)? };
        task.shapes.try_reserve_exact(shapes as usize).ok()?;
        for m in shape_meta.chunks_exact(4) {
            let ring = take(m[2] as usize)?;
            let tags = if m[3] != 0 { Some(take(m[2] as usize / 2)?) } else { None };
            task.shapes.push(pour::Shape { cls: m[0], sign: if m[1] == 0 { 1.0 } else { -1.0 }, ring, tags });
        }
        for &n in rest { task.anchors.push(take(n as usize)?); }
        if at != data.len() { return None; }
        Some(task)
    }

    #[no_mangle]
    extern "C" fn pour_solve() -> i32 {
        let s = state();
        let Some(task) = pour_task(&s.u32_in[0], &s.i32_in[0], &s.f64_in[0], &s.i32_in[1]) else { return -1; };
        let result = pour::solve(&task);
        let (out, stats) = (&mut s.i32_out[0], &mut s.u32_out[0]);
        out.clear();
        stats.clear();
        match result {
            Ok((islands, st)) => {
                let ring = |out: &mut Vec<i32>, r: &pour::Ring| {
                    out.push(r.ring.len() as i32); out.extend_from_slice(&r.ring);
                    out.push(r.tags.len() as i32); out.extend_from_slice(&r.tags);
                };
                out.push(islands.len() as i32);
                for isl in &islands {
                    ring(out, &isl.ring);
                    out.push(isl.links.len() as i32); out.extend(isl.links.iter().map(|&l| l as i32));
                    out.push(isl.holes.len() as i32);
                    for h in &isl.holes { ring(out, h); }
                }
                stats.extend([st.passes, st.unresolved as u32, st.edges, st.merged, st.faces.unwrap_or(u32::MAX), st.rays.unwrap_or(u32::MAX),
                    st.face_fallback as u32, st.broken_rings, st.dead_islands]);
                0
            }
            Err(pour::Error::Invalid) => -1,
            Err(pour::Error::Fallback) => -2,
        }
    }
}
