# Altium PCB ASCII polygon and region fixtures

The generated records in [the region test](../../formats/altium-regions.cjs) exercise both kinds of region on a board. A polygon owns its stored copper islands. Independent copper fills, overlays and cutouts have their own role, layer and component or net where applicable. Run the test with `node tests/formats/altium-regions.cjs`.

| Record | Field convention observed in an Altium Designer ASCII save |
| --- | --- |
| Polygon definition | `ID` identifies the owner. `INDEXFORSAVE` is its saved index. `POURINDEX` carries the pour order. `NAME` contains decimal UTF-16 code units. Write the first boundary point again after the last edge. |
| Polygon-owned Region | `POLYGON` references the definition's ID. The island inherits its net. `SUBPOLYINDEX` identifies the island within that owner. An island's layer agrees with its owner. |
| Tessellated Region outer boundary | `MAINCONTOURVERTEXCOUNT` gives the number of `MVXj` and `MVYj` pairs. Omit the `ISSHAPEBASED` key. Altium treats its presence, including `FALSE`, as the signal to read typed edges. Coordinates are Y-up IEEE doubles in units of 0.0001 mil (0.00000254 mm). Preserve fractional ticks. |
| Authored Region outer boundary | `ISSHAPEBASED=TRUE` uses `KINDj`, `VXj` and `VYj` lengths. Circular edges add a centre, radius and start and end angles. Each listed edge starts at its vertex and finishes at the next one. |
| Region holes | `HOLECOUNT` gives the number of holes. For hole `n`, `HOLEnVERTEXCOUNT` gives the number of `HnVXj` and `HnVYj` pairs, in the same native doubles as the tessellated boundary. |
| Source hatch | Track and Arc records carry a `POLYGON` owner. These are physical strokes. The stored hatch can be current even on a board with no polygon-owned Region records. |

The generated test deliberately puts an island ahead of its owner, uses nonconsecutive owner IDs and stores fractional coordinates in the boundary and its hole. A malformed island invalidates the stored fill for that owner. Other complete owners and independent artwork survive. The test also reads Waffle's earlier dimensional hole fields, checks export following an obstacle edit and preserves the empty state of a never-poured outline.

## PiDP-11 native control

The [licensed PiDP-11 fixture](pidp11-io-expander/NOTICE) contains two GND polygons. Altium Designer opens three stored copper regions on Bottom and two on Top. The largest region on each layer contains the holes, with 21 on Bottom and 24 on Top. Nineteen independent regions consist of one Bottom VCC_5V fill and eighteen Top Overlay shapes. The native board object list also includes a Multi-Layer region of kind 3 for the board stack.

The source binary opens as 2 polygons and 25 regions. An Altium-generated Save As ASCII of the source reopens as 2 polygons and 26 regions. The second Multi-Layer board-stack object accounts for the difference. Waffle's editable ASCII writer emits the two polygon definitions and all 24 physical regions. Altium supplies its own board-stack object when opening a board.

In a native Altium reopen of the Waffle export, both polygon names, nets, layers, priorities, hatch modes, 20 mil pitches, 8 mil widths and same-net styles matched the original. The five stored islands and nineteen independent regions retained their native owners, layers, net assignments and bounding rectangles. The generated Multi-Layer board-stack region differed by 0.0000127 mm at each edge. A one-field control that explicitly set `ISSHAPEBASED=FALSE` for the 15 tessellated records retained all object and hole counts while collapsing every one of those outer boundaries.

Saving the corrected open board back to ASCII in Altium allowed a vertex comparison with Altium's own ASCII save of the original. All 93 outer vertices of the five stored islands matched exactly. All 2,544 vertices in their 45 holes agreed within 0.0000011 native coordinate tick at Altium's six-decimal output precision. All 5,095 outer vertices of the nineteen independent regions also matched after aligning their cyclic order and winding.

The [six-project Waffle export and re-import check](../../altium-fidelity/measure.cjs) covers 34 polygon definitions, including two negative split planes, 167 stored positive islands, 1,932 holes and 1,386 source-owned hatch strokes. The check compares each source island's packed-coordinate digest, number of rings, layer, net, owner, priority and island number.
