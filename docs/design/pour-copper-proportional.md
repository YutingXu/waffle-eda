# Poured copper that costs what an edit touched

Status: all three stages approved by the owner on 2026-11-27, built and measured (results below).
Stages 1 and 2 are on `perf/pour-copper-proportional`, stage 3 on `perf/pour-solve-local` and its
outline splice on `perf/pour-outline-local`; all are merged with main (`38436d6`) on `integrate/pour`,
where the stage 3, outline and merge numbers below were measured. The
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
  `heldFields`, tables and contours from run bytes).
- Live worker: a new region travels as `fieldsOf` and run ids, with only the runs the editor does not
  hold (`runIds`, `runLookup`; regions still held as text name their runs alike, so the first edit
  after opening is not a full send).
- Undo store: `heldFields` (asked once per object, null for any object without copper) names the
  fields the region's copper holds, and `copperOf` gives that copper in place of its text and arcs
  (`setField`, `withCopper`); neither the undo store nor the save cache names a pour field. A record that replaces a region counts `copperDelta`, the
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

#### Result (branch `perf/pour-solve-local`, 2026-11-27; merged with stages 1 and 2 on `integrate/pour`)

Cause of the fallback: the patch was one box grown in rounds, capped at 8 rounds. In a dense
cluster of pad clearances a part move needed 12, so it gave up and solved the whole pour. A paste
hit the same cap.

Fix, all in `polygon-pour.js`: the patch region is a set of boxes, one per changed input plus
every input its guard reaches, solved per connected group. Islands and island tests are recomputed
only where they can change; unchanged islands keep object identity.

With stages 1 and 2 merged, finish uses that identity too (`areaFinished`, the engine's
`regionAgain`): an island the patch left as it was, in the same frame, keeps the true arcs found for
it when the registered arcs its rings name are unchanged, and is the region made for it while the
pour still holds that region with the same links and arcs. Only the changed islands are scanned for
arcs and encoded, and encoding makes runs (stage 2) instead of base64 text.

Worker time per edit on the benchmark board, JS core in Node, through the live worker's own steps
with area sessions (stage 3's bench). Medians of 9 (3 runs of 3, alternating), total / exact solve /
finish (`tFinish`: true arcs and encoding) in ms, MacBook on battery 71–79 %. Before: `cb612f8`, as
the stage 3 reviewer measured it. Every refill of both builds was compared with a full repour and was
identical (`VERIFY=1`).

| Edit | Before | Stage 3 alone | Stages 1–3 (`integrate/pour`) |
| --- | --- | --- | --- |
| Move a part | 723 / 545 | 190 / 16 / 103 | 110 / 18 / 33 |
| Bend a track | 197 / 74 | 193 / 37 / 79 | 99 / 14 / 36 |
| Move a via | 315 / 163 | 180 / 19 / 98 | 179 / 21 / 105 |
| Add a track | | 85 / 7 / 31 | 65 / 9 / 12 |
| Delete a track | 173 / 66 | 130 / 11 / 68 | 87 / 13 / 29 |
| Paste 4 | 730 / 570 | 193 / 27 / 102 | 111 / 20 / 43 |
| Move a part on two pours | | 272 / 45 / 161 | 139 / 43 / 38 |
| Track crossing a pour outline | | 1,806 / 1,526 / 205 | 1,509 / 1,325 / 122 |
| Pour clearance edit | | 901 / 688 / 100 | 810 / 667 / 59 |
| Repour All | 2,439 | 2,620 | 2,625 |

Finish no longer dominates a local edit. The merge alone (stage 2's runs instead of base64 text, and
kept regions) took a part move's finish from 103 to 43 ms; `areaFinished` took it to 33 ms, and a
part move on two pours from 68 to 38 ms, while bends, deletes and pastes, whose cost is the one large
island they change, stayed within noise. A via move's finish varies from 40 to 140 ms in every build.
What is left of a local edit's total (60–75 ms of a part move's 110) is outside the solve and finish:
the signatures, preparation and the commit plan.

Still a full solve:

- A track that crosses or touches a pour outline: 1.6–1.8 s on the benchmark board when it
  crosses two large pours, the same as before. Making this local needs an edge-level splice of
  long rings. Approved by the owner on 2026-11-27 and built on `perf/pour-outline-local`; see the
  result below.
- Remove Necks and Outlines Only pours, second stage.
- Pours whose last solve needed snap rounding.
- Pour outline, clearance and rule edits, by nature.

How often the outline case happens: on the benchmark board 3.6% of items lie within 0.2 mm of a
pour outline. A track ending 0.1 mm short of the outline stays local; one that crosses it does
not. So it is rare inside a pour and usual along the split line between two pours.

Correctness: `tests/pcb/pour-area-random.cjs` applies seeded random edits through the undo store
and requires every region to match a full repour byte for byte. It also drives the live worker's
own jobs, including the follow-up jobs for dependent pours, and requires that no pour is left
stale.

Constraint found on the way: reuse inside area sessions relies on the worker's mirror replacing a
changed row with a new object. Calling `repourAll` with `area` on editor objects edited in place
is not safe. Nothing in the editor does that today.

#### Result of the outline splice (branch `perf/pour-outline-local`, 2026-11-27; merged on `integrate/pour`)

A ring much longer than the edit (a pour outline, a large island's outer ring) no longer joins the
patch whole. Only the stretch of it inside the region is solved again and the rest of its vertices
are kept. Cuts are allowed only on axis-parallel edges without arcs, where rounding cannot move a
point off the line; anything else falls back to a full solve with a named reason.

Worker time per edit on the benchmark board after all three merges (`integrate/pour`, with main),
stage 3's bench with `VERIFY=1` (one run each; every refill of all 24 edits identical to a full
repour), total / exact solve in ms, on AC power. "Before" is stage 3 alone in the same session. The
author's and the reviewer's measurements on `perf/pour-outline-local` alone, 29 edit kinds: a track
across two pours 1,922 / 1,666 before, 325 / 65 after; a bend of it 2,016 / 1,722 before, 393 / 70.

| Edit | Stage 3 alone | Merged |
| --- | --- | --- |
| Add a track across two pours | 1,908 / 1,633 | 184 / 52 |
| Bend that track | 1,628 / 1,372 | 193 / 56 |
| Track crossing an outline | 1,644 / 1,392 | 166 / 44 |
| Move a part on two pours | 324 / 55 | 151 / 42 |
| Bend a track inside a pour, for scale | 134 / 12 | 115 / 17 |

These edits run three exact solves (both pours, and the later pour's second stage) where a bend
runs one, so their solve time is several times a bend's while their total is under twice. A pour
outline edit is still a full solve (915 / 754).

Still a full solve after this: Remove Necks and Outlines Only second stages, snap-rounded
overlays, an outline vertex that moves whole long edges, clearance and rule edits, and a cut that
cannot be decided exactly.

## Merged with main (`38436d6`, 2026-11-27)

`integrate/pour` took main after stage 3 and before the outline splice, as its own merge commit.
Main's pour changes (#85: Altium's clearances and thermal reliefs, spokes added after the island
tests, the oracle against stored fill) decide what copper is: the merged branch's stored copper
equals main's own full repour, step for step, over 250 seeded steps (`--digest` against `38436d6`).

Conflicts, each resolved on main's behaviour:

- `drc-pours.js`: main's plane clearance, hole clearance and the internal-plane exception were
  written into the full check only; they now live in the shared `pair()` that the online session
  (from `perf/pcb-edit-proportional`) also uses, with hole violations kept apart.
- `canvas-fast.js`: main's resize path and LOD detail key on stage 1's key (no pours array, no tile
  version, so the camera starts at index 11), and a resize also requires that no copper changed.
- `canvas-gpu.js`: main's `coverageRegion` records keyed by the engine's `dataKey`, with stage 1's
  view damage.
- `pcb-pours.js`: stage 1's LOD trim with main's `redrawPourLOD`.
- `polygon-pour.js`: area sessions keep main's spoke stage (`stage3`) and stage 3's island tests
  (`kept`).

Nothing of the three branches was made unnecessary by main: #83's Undo fix is in online DRC's rule
scope, #69 and #68 in zoom and pane resizing, #82 in markers; none does what these stages do. The
eager budget is now 2 MB (1,037.8 KB used), so autosave's section dividers are back to full width.

The pours board, `scripts/perf-sch.sh --board pours`, 3 runs per side alternating main alone
(`38436d6`) and the merge (before the outline splice), headless Chrome with CPU raster, on AC power.
Medians [range].

| | Always: main | merged | Off: main | merged |
| --- | --- | --- | --- | --- |
| Longest task after an edit (`editTaskMax`) | 441 ms [420–458] | 0 [0–56] | 455 [403–907] | 0 [0–50] |
| Longest canvas frame (`editCanvasMax`) | 75 ms | 40 ms | 73 ms | 41 ms |
| CPU over the edit series (`editSeriesCpuMs`) | 1,192 ms | 309 ms | 1,592 ms | 350 ms |
| Idle wake-ups per second | 102 | 0 | 0 | 0 |

| Bytes per edit (move, bend, add, delete, paste) | main | merged |
| --- | --- | --- |
| Worker to editor | not counted | 88, 93, 32, 25, 138 KB |
| Autosave written | 5.7, 5.7, 5.7, 2.9, 8.5 MB | 135, 134, 72, 73, 175 KB |
| Undo held | 11.4, 7.5, 7.5, 3.9, 11.4 MB | 81, 85, 25, 22, 125 KB |

Main alone spends 300–450 ms in a main-thread task on every edit of this board, and in Efficiency
mode Always its edit pipeline wakes 90–107 times a second while idle (103–129 after the edits; the
sources are `nextTask` timeouts in `edit-pipeline.js` and the idle callbacks of its `deliver`, about
520 each per window), with 66–68 % idle CPU. Main has no `--board` option, so both sides were measured
with this branch's probe (`scripts/perf-sch.sh` and `tests/integration/perf-sch.js`). `9a014f8`, the
main these branches were cut from, measures the same (99 wake-ups a second, 502 ms tasks), and `cb612f8`
(`perf/pcb-edit-proportional`, the base of stages 1 and 2) measured 0: it is fixed by that branch's
insights changes, which main does not have yet, not by these stages. The merged branch passes the pours budgets in
5 of 6 runs; one Efficiency-off run missed `openSettleCpuMs` by 8 ms (1,808 against 1,800).
`EFFICIENCY=always|off` still forces the mode after main's #81 (the probe calls
`AtriumPower.setMode`, which Always and Off override whatever the system reports).

After the outline splice was merged too (the branch's final state), the same comparison, 3 runs per
side: `editTaskMax` 61 ms [50–105] (Always) and 56 [0–56] (Off) against main's 529 and 490;
`editCanvasMax` 42 and 48 ms against 158 and 101; `editSeriesCpuMs` 355 and 481 ms against 1,415
and 3,001; bytes per edit as in the table above. Two of six pours runs passed every budget. The
others missed by little (`openSettleCpuMs` 1,801–1,845 against 1,800, `editSeriesCpuMs` 621 against
550, `editCanvasMax` 51 against 50), except one Always run whose opening took 4.9 s of CPU and whose
Redo had a 105 ms task. Undo and Redo had a 50–61 ms task in most Always runs.

That Undo and Redo task was the copper basis check (`inspectCopper`) hashing the large islands
again on the main thread. It hashed the copper text of regions held as text, and always the islands'
true arcs: about 96,000 numbers and 10 ms for the top ground island. Three engine changes remove it:
- Regions with the same runs share one copper object (`copperFor` in pcb-pours.js), so the refill
  after an Undo has the copper the undo store holds.
- The copper digest is also kept by text, so a text-held island restored by Undo is hashed once.
- A polygon's contours digest is kept for the last four states of its regions (same layer, net,
  count, data key and arcs array).

Nothing is hashed on a commit that was not hashed before, and the digests are the same values.

After those changes and the damage fix below, on AC power, 3 runs per mode, every pours run passed
every budget. `editTaskMax` was 0 in all six runs, including Undo and Redo. Medians, Always / Off:
`editCanvasMax` 40 / 44 ms, `editSeriesCpuMs` 366 / 324 ms, `openSettleCpuMs` 1,387 / 1,520 ms.
Idle wake-ups were 0, and bytes per edit are as in the table above. `--board` passed in both modes.
`--board nets` passed in Always and failed once in Off at 54 ms on a part move; that board has no pours.
The pours budgets are unchanged; `editTaskMax` could go from 70 to 50 on these numbers.

Missed damage found by the pixel test after this merge, and fixed. The pour outline edit left a
one-pixel column along the border between the two top-layer pours (x = 180 mm) stale: 152 pixels up
to 6 levels off, on every later frame until a full repaint, in both modes and every run. The pixels
lay outside every repainted box. Cause: the frame draws pours at a display LOD level, and `simplify()`
chooses the kept vertices over a whole ring, so when one edge of a ring changes, its simplified outline
can move anywhere along it. Damage was the boxes of the changed edges only. Main's #85 refills the
dependent pour's whole border ring after this edit, which made it visible. Now `copperChange` also
gives the box of each changed ring, and `viewDamage(a, b, k)` returns those when `k` (device pixels
per mm) draws at a LOD level; canvas-fast and canvas-gpu pass `k`. A ring that is a pour's whole
outline then damages the pour's box, so that edit repaints in full; a hole changed by a part move
still damages only its own box. `pour-copper-proportional.cjs` (e) fails without this and passes with
it, and browser-pour-damage passed 60 runs of 60 afterwards (30 Always, 30 Off).

Before the fix, one Always run in four also left one frame with 50,391 pixels off by up to 52 over
the whole Top/GND pour. Its pictures were not saved. The same edit moves the GND pour's outer ring,
whose simplified outline then moves along the whole pour while its changed edges' boxes cover only
the moved top edge, which fits that frame. It did not recur in the 60 runs after the fix.

## Accepted by the owner (2026-11-27)

- A build from before stage 2 cannot read a recovery draft written by a build with it, and reports
  the snapshot as incomplete. Nothing is backported, so downgrades are not a supported path. Drafts
  written by older builds still read.
- A partial repaint of a large pour may differ from a full repaint by up to 3 of 255 antialiasing
  levels at edge pixels. The pixel test allows exactly that.

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
  base branch (identical over 250 steps, against `cb612f8` and, after the merge, against main
  `38436d6`). Also: regions with the same runs share one copper (f), and damage at a display LOD
  level covers a changed ring's whole simplified outline (e).
- `tests/canvas/browser-pour-damage.cjs`: after every editor frame on the pours benchmark board the
  canvas equals a full paint, with a control that drops the copper damage and must be caught.
  Antialiasing noise of at most 3 levels is allowed: a part fill of a big region can round an edge
  pixel differently from the whole path (it always could; filling the whole path clipped instead is
  exact but costs about 7.5 ms per region and patch).
- `tests/pcb/pour-area-random.cjs` (stage 3): seeded random edits through the undo store, every
  refill (area sessions, and the live worker's own jobs with their follow-up jobs) equal to a full
  repour byte for byte; `--large` adds the benchmark board.
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
- Stage 3 on a real board, and with the WebAssembly core doing the full solves; its numbers are the
  JS core in Node.
