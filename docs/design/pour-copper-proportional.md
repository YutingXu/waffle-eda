# Poured copper that costs what an edit touched

Status: all three stages approved by the owner on 2026-11-27 and being built; no results yet.
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

### 2. Region data in content-addressed runs

Needed only if stage 1 leaves a task over 50 ms. No change to the saved file.

- In memory a region's ring data is held as runs of whole rings in canonical order. A run ends
  after a ring chosen by its content, so adding or removing a ring does not move later boundaries.
- Autosave writes a run once and refers to it afterwards. Undo counts a run once however many
  versions of the region share it. Decoding is cached per run.
- Saving joins the runs into the same bytes as today, so the format, `copperBasis` and older
  builds are unaffected.

Expected: bytes per edit follow the changed rings (hundreds of vertices, not 190,000).

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

## Not verified

- Timings on a real GPU; every number is headless Chrome with CPU raster.
- Bytes autosave actually writes; inferred from its layout.
- Solve times with the WebAssembly core; the engine was not built on the measuring machine.
- That Undo history is shortened in practice by the 64 MB budget on boards like this.
- What triggers the full-solve fallback for a part move.
