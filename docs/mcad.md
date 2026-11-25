# Working with MCAD (IDX, IDF, STEP)

Waffle exchanges the board with mechanical CAD in three ways:

- **IDX** (ProSTEP iViP EDMD XML): the incremental format of SolidWorks PCB, Creo ECAD-MCAD Collaboration, NX, Fusion and Altium MCAD CoDesigner. Changes go both ways, item by item, and each one can be accepted or rejected.
- **IDF 3.0** (`.emn` board and `.emp` library): the older fallback that every MCAD tool reads.
- **STEP**: an enclosure as a reference body, its clearance to the components, and a board shape a mechanical engineer edited.

Everything lives in **File › Import**, **File › Export** and the **MCAD panel** (Window › Panels › MCAD).

## The IDX round trip

1. **File › Export › IDX Baseline…** writes the board for MCAD, and Waffle records it as the baseline. The file contains:
   - the board outline (exact arcs), cutouts and thickness;
   - every component as a placed body: designator, value, package, height, side, a locked flag and its 3D model's file name;
   - plated and non-plated holes: free holes, plus the non-plated holes of footprints (mounting pegs);
   - keep-outs and keep-ins with their heights;
   - rigid-flex bend regions (angle, radius and the bend line);
   - mechanical constraints (maximum component height, top and bottom).
2. MCAD moves, rotates or flips components, changes the outline, and adds holes and keep-outs. It sends a change file back.
3. **File › Import › MCAD Changes (IDX)…** reads it (IDF `.emn` files are accepted here too). The MCAD panel then lists one proposal per change:
   - **Accept** applies it as one undo step. **Reject** leaves the board as it is.
   - Hovering a proposal previews it on the canvas. Clicking it zooms there.
   - **Review…** opens the visual diff of the board with every pending proposal applied.
   - **Accept All** and **Reject All** apply or reject everything in one undo step.
4. **File › Export › IDX Response…** sends the answer back: each change marked accepted or rejected, with the reason you typed.
5. Later Waffle edits go out with **File › Export › IDX Changes…**. This exports only what changed since the baseline or the last change set (added, changed and deleted objects, each a new version of its IDX item).

**Identity.** Waffle keeps IDX identifiers stable across round trips:

- Waffle objects are numbered with their own ids (SystemScope `ATRIUM`).
- Objects MCAD creates keep MCAD's SystemScope and Number, mapped to the Waffle object that was made for them.
- The map, the baseline and the received proposals are saved with the board (`doc.mcad`, project format 1.3).
- Components without a known identifier match by designator; holes and keep-outs match by position.

Accepting a change also records it as MCAD's state, so it is not sent back as a Waffle change.

## IDF 3.0

- **File › Export › IDF 3.0 (.emn, .emp)…** writes:
  - the outline (arcs as included angles);
  - drilled holes (PTH/NPTH, BOARD or the owning designator);
  - place, route and via keep-outs and place regions, with heights;
  - placements (locked parts are ECAD-owned);
  - one `.ELECTRICAL` package per footprint and height.
- **Import.** Choose an `.emn` in File › Import › MCAD Changes (IDX)…. IDF has no identifiers, so components match by designator and holes by position and diameter.

## Enclosures and STEP

- **File › Import › Enclosure (STEP)…** shows the enclosure in the 3D view as a translucent reference body.
  - The MCAD panel places it: an X, Y, Z offset and a turn about Z, in the STEP export's frame (Y up, board bottom at z = 0).
  - Enclosures up to 2 MB are stored in the project; larger ones must be imported again after reopening.
- **Clearance.** Every component body (generated, or the model's box, as Component Clearance uses) is checked against the enclosure's triangles with a GJK distance:
  - Components closer than the clearance are listed and tinted red in 3D, and outlined on the canvas.
  - A component wholly inside a wall is caught by an inside test.
- **Derive** proposes board geometry from the enclosure:
  - **Section** cuts the enclosure at a height (default 0.5 mm above the board). The wall round the board, pulled in by the inset, becomes the outline, and islands inside it become keep-outs.
  - **Face** picks a horizontal face (a boss or rib underside). Its loops become component keep-outs whose height is the face's distance above the board.
- **File › Import › Board Outline (STEP)…** reads a board that MCAD edited and saved as STEP:
  - The board top is the largest upward face. A section half way through the board gives the outline and its inner loops.
  - Round loops up to 6.5 mm become holes; other loops become cutouts.
  - The changes come in as proposals. Plating is not in a STEP file, so new holes are proposed as non-plated.
- **Re-exporting STEP** keeps entity names stable so MCAD can re-link:
  - Each component's product and placement are named by designator, and the placement's description carries `atrium:<id>`.
  - The export is byte-stable for an unchanged design: the header date is fixed unless a date is given, as MCP `export_step` and Output Jobs do.

## MCP

| Tool | What it does |
|---|---|
| `mcad_status` | Read-only. Baseline, changes since it, pending proposals and the identity map. With `enclosure` (a STEP inside the project folder): component clearance, and `derive` proposals. |
| `import_mcad_changes` | Reads an IDX, IDF or STEP file (`path` inside the project folder, or `text`) and returns the proposals. `accept` / `reject` take ids or `"all"`. Finishes as a proposal file, or a write with `mode: "write"` on an `--allow-write` server. |
| `export_idx` | `kind`: baseline, changes, response or idf. Writes into `<project>-outputs/mcad/`. Recording a baseline or change set is a proposal (or write). |

## Security

Imported files are untrusted:

- **XML** is read by Waffle's own reader (`app/mcad-xml.js`):
  - A DOCTYPE or any entity declaration is refused.
  - Only the five predefined entities and character references are decoded.
  - Size, element, depth, attribute and text caps apply.
- **STEP** is read by the bounded reader in `app/step-import.js`.
- **No fetches.** Nothing a file references (3D models, schema locations) is ever fetched.
- **MCP** reads input files only from inside the project folder, and writes only into `<project>-outputs/`.

## Format notes and uncertainty

IDX support was written from public knowledge of the EDMD 3.0 schemas (PSI 5, IDX 3.0/4.0 "simplified" representation), not from the XSDs. Files are checked against a structural schema in `app/mcad-idx.js`: elements, children, required fields, enumerations, unique ids and resolved references. The structure has not yet been verified in a commercial MCAD tool. The details least certain are:

- **Change entries.** Each change is written as one `computational:Changes` element (`NewItem`, `PredecessorItem`, `IsAttributeChanged`, `Comment`). Responses add `Accepted`. The reader also accepts nested `Change` elements.
- **Arcs** are written as `d2:EDMDArc` with start, mid and end points. `Circle3Point` and `Line` are read.
- **Bottom-side components** are written as a mirrored 2D transformation (determinant −1), a zOffset of 0 and a `SIDE` user property. Their bodies extend downward from the board bottom.
- **3D models** are referenced by a `foundation:Model3D` (`pdm:EDMDModel3D`) with the file name only.
- **Keep-outs.** Copper-layer keep-outs are written as `KEEPOUT_AREA_ROUTE` and all-layer keep-outs as `KEEPOUT_AREA_COMPONENT`. Keep-ins are `KEEPIN_AREA_COMPONENT`, for keep-out graphics with `mcadKind: "keepin"`. An unbounded height is written as 1000 mm.
