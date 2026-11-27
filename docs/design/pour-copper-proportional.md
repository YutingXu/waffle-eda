# Poured copper that costs what an edit touched

Status: all three stages approved by the owner on 2026-11-27. Stages 1 and 2 are built and measured
(results below); stage 3 is being built separately.
Stages 1 and 2 are on `perf/pour-copper-proportional`, stage 3 on `perf/pour-solve-local`. The
owner asked for stage 2 to be built whatever stage 1 measures. It follows the measurements on the
local branch `perf/pcb-edit-proportional` and a read-only map of the pour code made the same day.

## Goal

After a small edit on a board with large pours, no main-thread task over 50 ms, and the bytes
written, kept for Undo and repainted follow the copper that changed, not the size of the island.

## What exists today

Measured on the benchmark board: 25,600 objects, ten pours, about 580,000 pour vertices. The
top-layer ground island is one region of 6,540 rings, 190,000 vertices and 4.1 MB.

| Piece | Today |
| --- | --- |
| Tile solve (`PourTiles`, `polygon-pour.js`) | A display preview only. It runs for moves of at most 12 items, with live pours on and Efficiency mode off, and is dropped when the exact copper lands. 4–11 ms for the edits measured. |
| Exact copper | A whole-pour solve, or an area patch that still walks every ring of the pour. A track bend took 73 ms in the worker; a part move fell back to a full solve, 424–568 ms. |
| Encoding | One region per island. Every island of a repoured pour is encoded again, changed or not: 4.1–6.1 MB crosses to the main thread per edit, although one region changed. |
| Canvas | Any change to the stored pours repaints the whole frame on every layer: 143–171 ms, against about 5 ms on the same board without pours. |
| Autosave | The changed region's data is one chunk, so about 4 MB is produced per edit: 43–44 ms. |
| Undo | Each replaced region counts its full data against the 64 MB budget. |
| Tile preview state | Thrown away on add, delete, paste and structural undo, then rebuilt: about 150 ms on the main thread. |
| Checks | Already proportional on that branch (`copperChange`, the pour clearance session). |

## Principle: keep islands, stop treating one as indivisible

Islands stay the stored unit. Dead copper, minimum area, net links, Gerber and ODB++ surfaces,
KiCad and Altium export, and older builds all read a region as one island with its holes. Storing
tile pieces instead would change what a region means and need a stitch for every reader.

What changes is everything around the island: what is repainted, what is encoded, what is written
and what Undo keeps. Each already has a mechanism that works on parts of a region.

The pour engine owns copper. `polygon-pour.js`, `pcb-pours.js` (`AtriumPCBPours`), `PourCore`,
`PourTiles` and the live pour worker decide what changed, how rings are hashed and ordered, how a
region is encoded and decoded, what a run is, and how a region's data is read. This work reuses
what the engine already provides; anything missing is added to the engine and exposed there. The
canvas, autosave (`save-cache.js`), the undo store and every other reader consume that API and keep
no pour knowledge of their own: no second ring hash, no second notion of a run, no pour key list,
and no decoding of region data outside the engine's accessor. Nothing pour-specific goes into
collaboration code (`app/project/collab-*`).

| Need | Reused |
| --- | --- |
| Where copper changed | `AtriumPCBPours.copperChange(before, after)`: boxes around changed rings, matched by content hash |
| Repaint part of a frame | The canvas damage path item edits already use (`canvas-fast.js`) |
| Per-ring lookup inside a region | The ring index in `canvas-fast.js` |
| Unchanged data written once | The autosave chunk digests (`save-cache.js`) |
| Shared references in Undo | The undo store's shared fields for pours (`sh`) |
| Add and remove shapes in tiles | `PourTiles.update(diffs)` |

## Stages

Each stage is measured with `scripts/perf-sch.sh --board pours` before the next starts.

### 1. Repaint and transfer only what changed

No change to the model or the file.

- The canvas takes `copperChange` boxes as damage and no longer keys the board-layer copy on the
  identity of the pours array.
- The worker sends back only regions whose content changed. A region with identical content is
  returned as a reference to the one the editor holds, and an unchanged pour is not encoded again.
- Caches that are rebuilt per region (paths, contours, level of detail, GPU fans) keep the entries
  of rings that did not change. GPU damage is the changed boxes, not the region's bounds.
- Add, delete, paste and undo update the tile preview with `update(diffs)` instead of discarding
  and rebuilding it on the main thread.

Expected: the canvas cost falls towards the board without pours, about 2 MB less garbage per edit,
and the 150 ms rebuild goes. Autosave and Undo still handle 4 MB for the changed island.

#### Stage 1 as built

- Runs (`pcb-pours.js`). A region's rings are cut into runs: a run ends after a ring whose content
  hash has its five low bits clear (32 rings on average, about 15 KB on the benchmark island), or
  before 256 KB. A run's key is two 32-bit hashes of its rings, its ring count and its byte length.
  Decoded rings and ring boxes, run paths (joined with `Path2D.addPath`, which costs 1.2 ms for 180,000
  vertices against 9.4 ms for `lineTo`, with identical pixels) and display LOD are kept by run, so a
  new version of an island finds all but its changed runs cached. A table per region (ring hashes,
  offsets, runs) is kept by region; the base64 of a run alone is decoded when the rest is cached.
- `copperChange` cancels whole runs by key, then rings by hash and exact coordinates; the answer for
  the last four pairs of lists is kept (the canvas and the clearance session ask about one commit).
- `view(stored)` and `viewDamage(a, b)` (engine) give the canvas the boxes where shown copper
  changed: `copperChange` for stored copper, and through `displayHook` the clip rectangles of tile
  patches shown, faded, held or cleared (`bumpTiles` records them per display version; the token
  also carries whether the preview shows, since a mirror preview hides itself when the revision moves).
- `canvas-fast.js` takes those boxes as damage; the pours array and the tile version left its key. A
  copper-only patch is exact (batches are not rebuilt). A new region is indexed at once when its runs
  are cached. A part fill now uses a `Path2D` like the whole region, and the LOD rings are checked
  against the index after it is built (a first repaint drew stored rings before).
- `finishSteps` encodes through `regionLike`: an island identical to one the pour has (bytes, links,
  arcs) is that region object, so the worker returns it as an index and nothing is encoded again.
- `canvas-gpu.js`: coverage damage is the changed boxes; bounds come from the engine's ring boxes.
  GPU fans are still one buffer per region (see Not verified).
- Tile preview: adds, deletes, paste and their undo update a warm session through `tileDiff`.
  Efficiency mode has no tile preview, so there it changes nothing.

#### Stage 1 results

Benchmark board with pours, `scripts/perf-sch.sh --board pours`, 3 runs per side alternating base
(`cb612f8`) and branch, headless Chrome with CPU raster, MacBook on battery (75–79 %). Medians, range.

| | Efficiency always: base | stage 1 | Efficiency off: base | stage 1 |
| --- | --- | --- | --- | --- |
| Longest task after an edit (`editTaskMax`) | 83 ms [81–83] | 0 [0–56] | 73 [70–75] | 57 [57–63] |
| Longest canvas frame | 83 ms | 34 ms | 73 ms | 43 ms |
| Canvas time per edit (move part) | 214 ms | 94 ms | 232 ms | 128 ms |
| CPU per edit, worst | 562 ms | 360 ms | 568 ms | 404 ms |
| Worker transfer per edit | 4.1–6.1 MB (earlier map) | 5.0 MB (1 of 65 regions) | | |
| Autosave written per edit | 6.3 MB | 6.3 MB | | |
| Undo held per edit | 8.0–11.9 MB | 8.0 MB | | |

Every edit's own tasks now stay under 50 ms; the tasks left over 50 ms are Undo and Redo, and they
are not canvas work: the online DRC re-checks copper after Undo restores older copper and asks
`inspectCopper` for a board-wide signature pass (45–60 ms). The same board without pours spends
40–52 ms of canvas per edit; with pours stage 1 spends 70–128 ms: the exact idle frame after a
batched item patch still repaints the whole board (about 35 ms, the pours' share about 10 ms), and the
Insights and DRC markers are planned again when the copper changes (about 20 ms in a frame).
Autosave and Undo still carry the whole island, as expected.

### 2. Region data in content-addressed runs

Built at the owner's request whatever stage 1 measured. No change to the saved file.

- In memory a region's ring data is held as runs of whole rings in canonical order. A run ends
  after a ring chosen by its content, so adding or removing a ring does not move later boundaries.
- Autosave writes a run once and refers to it afterwards. Undo counts a run once however many
  versions of the region share it. Decoding is cached per run.
- Saving joins the runs into the same bytes as today, so the format, `copperBasis` and older
  builds are unaffected.

Expected: bytes per edit follow the changed rings (hundreds of vertices, not 190,000).

#### Stage 2 as built

- A region the pour engine makes (`regionLike`, or `fromRuns` from the live worker) holds its rings as
  runs: `{key, id, bytes, n, h1, h2, at, arcs}`, interned by id (key: the rings; id: the rings and
  their true arcs, since a region's `arcs` index rings and shift whenever a ring is inserted). Its
  `data` and `arcs` are accessors that join the runs into exactly the text and array they were
  (kept a while, bounded), and writing either makes an ordinary field again. Saving, export, format
  2, signatures, collaboration snapshots and every other reader of the text read it unchanged; the
  edit path reads the runs through the engine instead (`dataKey`, `sameData`, `dataLength`,
  `heldField`, tables and contours from run bytes).
- Live worker: a new region travels as `fieldsOf` and run ids, with only the runs the editor does not
  hold (`runIds`, `runLookup`; regions still held as text name their runs alike, so the first edit
  after opening is not a full send).
- Undo store: `copperOf`/`heldField` give the region's copper in place of its text and arcs
  (`fieldOf`, `setField`, `withCopper`); a record that replaces a region counts `copperDelta`, the
  bytes of runs the old version has and the new one does not, so a run is counted by the one record
  that drops it from the board. Its other changes are only in how pour data is counted and shared.
- Autosave (`save-cache.js` `records`/`texts`, `autosave.js` hooks): a region's copper, and its arcs,
  are segments of their own whose chunk is stored as run ids; each run is a record `r~<id>` written
  once while snapshots refer to it (`meta.runs`, kept by the sweep). A draft reads back as the same
  text; a draft of text chunks (every earlier build) reads as before. Builds before this one cannot
  read a draft with run records.
- Undo and Redo: the pour signatures skip the field check of items the undo journal vouches for as
  unchanged since the last pass, and the copper digest for `copperBasis` is kept by copper, so the
  online DRC's `inspectCopper` after Undo reads what changed.
- Run size: a run ends after a ring whose hash has its five low bits clear (`RUN_BITS` 5: 32 rings on
  average). On a board-80 island of 1.96 MB, twenty small edits made new runs of a median 15 KB at
  3 bits (421 runs), 46 KB at 5 bits (107 runs), 215 KB at 7 bits (23 runs) and 340 KB at 9 bits (10
  runs, the 256 KB cap). Five bits keeps an edit near 2 % of the island while a board holds a few
  hundred runs (records, cache entries, path pieces) instead of a few thousand.

#### Stage 2 results

Benchmark board with pours, 3 runs per side alternating base (`cb612f8`) and branch (stage 2 before
the Undo splice fix), then 2 runs per mode of the final branch for the Undo column; headless Chrome,
CPU raster, MacBook on battery 83–91 % (final runs on AC power). Medians, range.

| | Efficiency always: base | branch | Efficiency off: base | branch |
| --- | --- | --- | --- | --- |
| Longest task after an edit (`editTaskMax`) | 71 ms [67–81] | 0 [0–0] | 68 [65–75] | 0 [0–0] |
| Longest canvas frame | 81 ms | 36 ms | 69 ms | 39 ms |
| Canvas time per edit | 95–203 ms | 73–108 ms | 73–224 ms | 63–124 ms |
| CPU per edit, worst | 532 ms | 348 ms | 553 ms | 359 ms |

| Bytes per edit | base | stage 1 | stage 2 (final) |
| --- | --- | --- | --- |
| Worker to editor (move, bend, add, delete, paste) | 7.2, 4.9, 4.9, 2.3, 7.2 MB | 5.0, 5.0, 5.0, 2.4, 7.3 MB | 94, 82, 37, 26, 132 KB |
| Autosave written (same edits, then undo, redo) | 6.3, 6.3, 6.3, 2.9, 9.2, 9.2, 9.2 MB | the same | 141, 124, 77, 74, 170, 169, 170 KB |
| Undo held (move, bend, add, delete, paste) | 11.9, 8.0, 8.0, 3.9, 11.9 MB | 8.0, 8.0, 8.0, 3.9, 11.9 MB | 86, 74, 30, 22, 119 KB |

Undo depth on this board within the 64 MB budget: base about 5 to 8 such edits; now the 500-step
limit comes first (about 64 MB / 120 KB = 530 edits of the largest kind). The worker's first edit
after opening also sends only the changed runs (96 KB). Autosave's remaining bytes are mostly the
item chunks that hold the edited object, as on the board without pours. In one final run of nine an
Undo had a 64 ms task on a loaded machine (the board without pours had 51 ms in the same session); the
A/B runs had none. The canvas still spends about twice the board without pours (40–52 ms per edit):
the exact idle frame after a batched item patch repaints the whole board, and the Insights and DRC
marker layer is planned again when the copper changes.

### 3. An exact solve that stays local

- Find why a part move makes the area patch fall back to a full solve, and why the patch walks
  every ring of the pour for islands, and fix both so a move costs about what a bend does.
- The tile solve stays a preview. Making it the exact engine needs true arcs, per-island links,
  neck removal, variable connect styles and identical bytes to a full pour, which is a larger
  project with its own design.

This stage is off the main thread, so it changes how soon fresh copper appears and how much CPU an
edit burns, not the longest task.

## Not in this design

- Tile pieces in the saved file.
- Copper in live sessions, which is covered by local copper (`feat/collab-local-copper`).

## Tests

- `tests/pcb/pour-copper-proportional.cjs`: seeded random edits and refills (moves inside and beside
  pours, adds, deletes, paste, net and width changes, outline and clearance edits, a peer's edit, Undo,
  Redo): stored regions equal a from-scratch pour, kept regions equal their fresh encoding, every
  engine cache, run table, LOD level, signature and `copperChange` equals a cold answer, a region
  rebuilt from runs (as the worker sends it, from copper or from text) equals the original, and Undo
  grows by a fraction of the island. `--digest` writes the stored copper per step, to compare with the
  base branch (identical over 250 steps).
- `tests/canvas/browser-pour-damage.cjs`: after every editor frame on the pours benchmark board the
  canvas equals a full paint, with a control that drops the copper damage and must be caught.
  Antialiasing noise of at most 3 levels is allowed: a part fill of a big region can round an edge
  pixel differently from the whole path (it always could; filling the whole path clipped instead is
  exact but costs about 7.5 ms per region and patch).
- `tests/project/autosave-copper.cjs`: drafts of copper held as runs write a run once, read back as the
  project's text, are swept with their drafts; drafts of text chunks, and a draft store written by the
  base branch, read back unchanged.

## Not verified

- Timings on a real GPU in the app. Headless Chrome with the GPU on (`GPU=1 scripts/perf-sch.sh
  --board pours`, ANGLE on Metal, which also turns on the GPU renderer) was tried, 2 runs per side,
  Efficiency always: the longest task after an edit went from 138–196 ms to 74–100 ms and CPU per edit
  from 674–759 ms to 420–530 ms, but those frames are mostly the GPU renderer's scene update
  (`canvas-gpu.js` update, 40–55 ms a frame) and coverage upload, not pour work. The GPU canvas still
  uses one fan buffer per region: its caches do not keep the runs a new region shares.
- WKWebView and the WebAssembly core; neither was available on the measuring machine.
- A draft with run records cannot be read by a build before this one.
- What triggers the full-solve fallback for a part move (stage 3).
