# Importing from other tools

Use **File → Open…** (`Mod+O`), drag files onto the editor, or choose **File → Import → Altium Project / Document…**. Select related files together so the translator can link sheets, boards, libraries and model references. An imported design opens as a project. To bring a document into an open design, use **+ → Add Existing to Project…** on that project’s title row in the Projects panel.

After each import, an **Import Report** tab shows the number of objects **kept**, **approximated** and **dropped**. Expand a row’s **Show references** control for the source file, object and reason. Review the warning totals and translator notes before using the result. Select a design tab to resume editing. Use **Reports → Import Report** or **⋯ → Import Report** on the project’s title row to revisit its report.

Parsing runs in a background worker with input limits, progress and a **Cancel import** control.

At a secure web address, browsers with a system file picker can open several files together. The picker shows all files, and Waffle checks the selection on Open. If you remember an export destination, a browser file handle lets Waffle recognize the same source the next time you open it. The standard file chooser and drag and drop keep the choice for the current editor session.

Waffle implements these formats from design files their owners can share, public specifications and compatibly licensed open-source readers. It does not decompile vendor software ([CONTRIBUTING.md](../CONTRIBUTING.md)).

## Projects from pre-release Waffle builds

Re-import the original Altium, KiCad or other supported EDA files using **File → Open…**. Keep the original source files together so Waffle can resolve their documents and library references. Waffle 0.7.0 Apricot Preview opens and saves native format 2.0.

To reopen a native project, select the project folder or its `.waffle` manifest. Keep the entire project folder when copying or sharing it. [Native format and release support](format-versioning.md)

## Altium Designer® files

**File → Import → Altium Project / Document…** opens a file chooser for `.PrjPcb`, `.SchDoc`, `.PcbDoc`, `.SchLib` and `.PcbLib` files (binary or ASCII). In the desktop app, select the `.PrjPcb` alone. Waffle follows its references to schematic sheets, boards and libraries in the project folder and its subfolders. If a referenced file is elsewhere, select it alongside the manifest. In the browser, choose the project folder when prompted. **File → Open…** accepts the same files.

Opening another design from the desktop file chooser gives it a separate window. Opening only a library adds it to the active project.

| File | What becomes editable |
| --- | --- |
| `.SchDoc` (binary) | Symbols, pins, wires, junctions, labels, power ports, ports, sheet frames and title blocks, and selected graphics |
| `.PcbDoc` (binary) | Footprints, pads, tracks, vias, arcs, board outline and cutouts, copper layers, nets, polygon pours (editable, with their stored fill as the current copper until you repour), mechanical layer names, source rules |
| `.SchLib` / `.PcbLib` | Symbol and footprint definitions for placement. Opened together, they become complete components (below) |
| `.PrjPcb` | The list of documents, matched against the files selected with it |
| `.RUL` and `Rules6` records | Browsable under **Design → Rules… → Altium Source Rules**. Supported minimums can be applied to the board's active rules. After an import, Messages asks once: *This board has N design rules from Altium. Use them?* with **Use the board's rules** (Replace with supported rules, one undo step; pours the new clearances affect are repoured), **Keep Waffle defaults** and **Review…** (opens Altium Source Rules). **Preferences → PCB → Imported boards** can answer for you (Ask, Always use the board's rules, Keep Waffle defaults); MCP `import_design` takes `source_rules: "use"`. KiCad, Eagle and EasyEDA rules are converted on import, so they are never asked about. |

**Tested on a real project.** `tests/import-altium-real.cjs` imports an open-source Altium project (the PiDP-11 I/O Expander, BSD-2-Clause, in `tests/fixtures/altium/`) and compares an import report with a snapshot: 23 parts on the sheet and the board, 30 nets on both, 194 tracks, 59 vias, and 2 polygon pours whose 5 stored fill regions count for connectivity (unrouted connections drop from 48 to 2; the two left are stub tracks inside a drill hole). The board contains 23 authored 3D bodies referencing eight distinct embedded STEP files. The report also identifies unsupported records, including unions and waived violations.

Board tracks, footprint artwork and board outlines retain their circular arcs. Select a board arc to edit its centre, radius and angles in Properties. Gerber and IPC-2581 use circular commands, DXF uses arcs or bulges, and PDF uses cubic curves tested to a 0.005 mm radial tolerance at 1:1. Tools that need polygons, including copper clearance checks, use sampled points.

**SchLib + PcbLib libraries.** Open one or more `.SchLib` files together with the `.PcbLib` files they use (File → Open…, or MCP `import_design`). Each symbol is joined to the footprint its PCB model names, and Waffle looks for that name only in the files you selected: never along a search path, so there is no "footprint not found" from another folder. Pins and pads match by number. The import report lists what needs a person: a footprint name that two selected PcbLibs define differently (the symbol is kept on its own; attach the right one), a name in none of them, footprints no symbol uses (kept as footprint-only entries), and components whose pins and pads do not match. The same footprint defined identically in several files is used once. Every component starts as a draft and records where both halves came from: `source = {kind: "altium-schlib", file, sha256, entry, footprint: {kind: "altium-pcblib", file, sha256, entry}}`. Importing the same files again leaves the components already in the project alone. Library › Check… then lists missing 3D models and pin/pad problems. A multi-part symbol (a dual or quad op-amp) imports every part as a gate (U1A, U1B), with pins of part 0 on each gate; alternate De Morgan views are left out.

**Classes, pairs and xSignals.** Net classes, differential pair classes, differential pairs, xSignals (with
their series parts) and xSignal classes become signals and tags, and rules scoped to them (for example
`InDifferentialPairClass('HS_PAIRS')`, `InxSignalClass('PCIE_TX_XSIGNALS')`) apply once you use the board's
rules. Export writes them back, keeping Altium's unique IDs. Checked on a board saved by Altium Designer 26
(`tests/fixtures/altium/pairs-xsignals`, `tests/signals-altium.cjs`). Component, pad, layer and polygon
classes are not imported.

Altium's relative PCB origin (**Edit → Origin**) comes in with the board. **Fabrication Outputs** uses that datum by default for Gerber, NC Drill and pick-and-place. Choose **Design origin (absolute)** or **Board lower-left corner** to match an existing job. If the job used a separate Excellon datum, set **NC drill origin** in the **NC Drill** tab or in the **Gerber and drill** job settings. The MCP setting is `drill_origin`. [Altium fabrication setup](https://www.altium.com/documentation/altium-designer/preparing-for-manufacture/output-jobs/fabrication-data)

Use **Profile stroke width (mm)** in the **Gerber** tab or in the **Gerber and drill** job settings to reproduce the aperture of a published profile. The default width is 0.1 mm. The stroke follows the same perimeter and cutout centerlines at every width. MCP `generate_fabrication` takes `profile_width` in millimetres, including for inch Gerbers.

A PCB project with one applicable Gerber setup saved in its `.PrjPcb` can also provide an **Altium board profile** job. Waffle keeps the selected Mechanical 1 or Keep-Out filename and stroke width when the source layer contains only one uniformly drawn copy of the board perimeter and every cutout. Run the job under **Output Jobs**, or with MCP `run_output_job`. For automatically generated Altium profiles and settings held only in a companion `.OutJob`, enter the width in your output settings. PiDP-11 Rev A is one example of a project whose Gerber setup is in its separate `Fabrication.OutJob`.

Waffle links a schematic part to its footprint when the designator, footprint and pin mapping agree; ambiguous links are listed in the report. **Properties → Import report → Restore source appearance** re-applies the original page and symbol styling.

### Exporting an edited copy back

For a binary `.SchDoc` or `.PcbDoc`, **File → Export → Export Design…** with the format **Altium source copy** writes a native copy containing your supported edits:

1. Choose the original file. Waffle checks its SHA-256 against the import.
2. Waffle projects every change, reopens the assembled copy to verify it, and shows the differences before you save. A copy with no changes is byte-identical to the original.

| Document | Edits that can be written to a native copy |
| --- | --- |
| SchDoc | Designators and literal values; translations; wire vertices; junctions; label positions and text. On compatible SchDoc 5.0 sheets, new or split wires and new junctions. |
| PcbDoc | Moving unlocked footprints; standalone copper track endpoints, width, layer and net; simple via position, diameter, drill and net |

If any edit is unsupported (for example a new component, a deleted native component or a rotated footprint), the whole native export stops and the review names the reason. You can still save as Waffle or export to KiCad. After copper edits, repour and rerun DRC in Altium Designer before manufacturing.

## KiCad

- **KiCad 6–9:** `.kicad_pro`, `.kicad_sch` and `.kicad_pcb`. Select them together to keep the hierarchy, symbol-to-footprint links and net classes, which become rules and tags. Repeated sheets import as multichannel. Zones become unpoured polygon pours.
- **KiCad 4/5 files** are not supported. Open and save them in KiCad 6 or later first.
- **KiCad libraries:** `.kicad_sym` symbol libraries (also KiCad 10 `.kicad_symdir` folders, one file per symbol) and `.kicad_mod` footprints from `.pretty` folders. Open them with **File → Open…**, with **Import library files…** in the Library panel's source list (a review table: tick what joins the project), or with MCP `library_import`. As with SchLib + PcbLib, a symbol's Footprint field (`Library:Name`) is looked up only among the files you chose: `Name.kicad_mod` inside `Library.pretty`, or a footprint of that name when exactly one was chosen. Derived symbols (`extends`) draw their parent's body and pins, also from a sibling file of a `.kicad_symdir`. Pins and pads match by number; mismatches are reported, never remapped. Power symbols are skipped (Waffle places power ports). Each component starts as a draft with `source = {kind: "kicad-symbol", file, sha256, entry: "Lib:Name", footprint: {kind: "kicad-footprint", …}}`. 3D models stay references (`${KICAD*_3DMODEL_DIR}/…`, a `.wrl` read as its `.step` twin) with their offset, rotation and scale; KiCad 5 offsets in inches become millimetres.
- **Library folders:** the Library panel's **Add library folder…** shows a folder of library files (Waffle `components/*.json` and `.atrlib`, Altium SchLib/PcbLib pairs, KiCad libraries) beside the project library. Waffle indexes it incrementally: a file is read again only when its size or time changed, and parsed again only when its SHA-256 changed. Rows carry names, pins and pads; a component's symbol and footprint are read when you select, add or compare it. Waffle never writes into the folder unless you save there. **Get KiCad libraries…** downloads the official kicad-symbols and kicad-footprints archives from gitlab.com, only when you ask, into the app's own storage (outside projects and repositories). They are CC-BY-SA 4.0 with the KiCad libraries exception; they are parsed as untrusted data with size and nesting limits.
- **Export:** **File → Export → Export Design…** writes `.kicad_pcb` and KiCad 7+ `.kicad_sch` files, or **KiCad project (.zip)**: the board with its `.kicad_pro` (net classes, board minimums) and `.kicad_dru` (custom design rules), plus every sheet, the root one named after the project. Boards carry zones (polygon pours with priority, connect style, clearance, thermal and hatch settings, island removal and their stored fill), keep-out rule areas, pour cut-outs, teardrops and net-assigned fills (as small solid zones), the stack-up, text, and linear/aligned dimensions. The preview lists anything omitted or approximated (radial/angular dimensions become lines, via stacks, component-scoped rules). Round trips through Waffle's KiCad importer are tested on the example and on six real KiCad designs (`tests/kicad-roundtrip.cjs`).

KiCad design export includes the last zone fill stored in the board. After editing copper or pour settings, wait for live pours to finish or run **Tools → Polygon Pours → Repour All** before exporting. To refill the zones using KiCad’s rules, press **B** in its PCB Editor.

### Altium project (ASCII) — Preview

**File → Export → Altium Project (ASCII, Preview)…** writes one ZIP with a `.PrjPcb`, an ASCII `.SchDoc` per schematic sheet and a `.PcbDoc` per board. Extract the whole archive into one folder and open its `.PrjPcb` in Altium Designer®. Individual sheets also open directly in Designer's schematic editor. Read the export details for converted or omitted items. Schematic components, pins, wires, labels, power ports, sheet symbols and ports are exported. Text frames and embedded sheet images are omitted.

In Altium Designer 26.12.2.9 under Wine, the PiDP-11 I/O Expander schematic exported by Waffle opened with 23 components, 69 wires, 52 net labels and 22 power ports. The licensed original and a native Advanced Schematic ASCII Save As gave the same four counts. Some symbol artwork and layout differ from the original. Waffle's round-trip tests also compare all 96 schematic pin positions and the 30 connected pin groups for this fixture. Earlier Waffle archives declare zero schematic records. Open the earlier `.SchDoc` in Waffle and export again to write its actual record count.

The same native PCB check preserved PiDP-11’s two polygons, five stored copper islands, 45 holes and all 41 design rules. Its 65 PCB text records retained the source height, rotation and visibility. For a board with rounded corners, SNES-Tap’s six perimeter segments and eleven arc objects also matched in Designer. Check the exported layers against the original manufacturing files before using them to make a board.

**3D bodies.** The ZIP includes the STEP files and records their identifiers, placement, rotation, height and outline on the board. In Altium Designer 26.12.2.9, uncached file-based model references in an ASCII board reopened as plain extrusions even when the project included the matching STEP files. For a PCB imported from binary, use **File → Export → Export Design… → Altium source copy** and select the original board. That route kept all 23 embedded PiDP-11 bodies after a supported track edit, including the 28-lead IC and both connector rows. Individual STEP companions can also be selected under **Embed Model** in Altium’s 3D Body properties. [Altium 3D Body documentation](https://www.altium.com/documentation/altium-designer/pcb/3d-bodies)

## EAGLE

- Eagle 6+ XML `.sch` and `.brd`. Each sheet becomes a schematic document, and nets join across sheets by name.
- Binary Eagle files (before version 6) and `.lbr` libraries are not imported.

## EasyEDA

- EasyEDA Standard `.json` documents and EasyEDA Pro `.epro` projects (best-effort; check layers, footprints and labels).
- EasyEDA Pro `.eprj` files are SQLite databases and are not read. In EasyEDA Pro, use File → Save As (or Export) to write an `.epro` project.

## Mechanical and other data

- **DXF:** **File → Import → DXF…** (bulges, nested blocks and splines; layer picker and units) to the board outline or mechanical layers. **File → Export → DXF…** writes R12 outlines and graphics.
- **Images:** **Place → Graphic / Logo from Image…** traces PNG, JPG or SVG files to silk, copper or mask polygons.
- **STEP models:** the footprint editor can embed a `.step` model per footprint. It is written into STEP exports and drawn as a bounding box in the 3D view.
- **VS Code® themes and keybindings:** see [theming.md](theming.md).
- **Supplier part libraries:** the BOM optimiser reads an offline JLCPCB parts CSV.

## Automation

The MCP server imports headlessly with `import_design` (Altium, KiCad, Eagle and EasyEDA files), in a sandboxed child process with time and memory limits ([mcp-and-cli.md](mcp-and-cli.md)). For example: `python3 mcp/server.py --project Board.waffle --cli import_design --args '{"paths": ["Board.PrjPcb", "Board.SchDoc", "Board.PcbDoc"]}'`. The paths are relative to the project folder, and the converted project is written to `<project>-outputs/import/`.

## What is not imported yet

- Altium harnesses and some sheet-entry details. No-ERC markers and `COMPONENTKIND` are not yet kept exactly.
- Cadence® Allegro®/OrCAD®, PADS, CADSTAR and gEDA.
- ODB++ (IPC-2581 rev B output is available).

Missing something? Open a **Parity gap** issue with a small, redistributable sample file.

_Names of other tools are trademarks of their respective owners and are used only to describe file compatibility. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)._
