# Waffle EDA 0.8.2 · Butter

Butter 0.8.2 is a fix and polish release, with much more of an Altium or KiCad project kept on import. It opens and saves the same native format 2.0 projects as 0.8.0 and 0.8.1; nothing in your files changes when you upgrade.

## Install

- **macOS 12 or later, Apple silicon or Intel.** Open `Waffle-0.8.2.dmg`, drag **Waffle** into **Applications**, and follow **Read Me First** for the first launch. From 0.8.2 the app is signed with Waffle's own certificate instead of an ad hoc signature, so macOS will recognise later releases as the same app and keep the permissions you grant. The certificate is not from Apple and the app is still unnotarized: a downloaded copy asks for **Open Anyway** on its first launch, and permissions granted to 0.8.1 or earlier must be granted again once.
- **Windows (Preview).** On Windows 10 (1903 or later) or 11, x64 or Arm64, extract `Waffle-0.8.2-windows.zip` and run `Waffle.exe` from the extracted folder. Keep its accompanying folders together. The unsigned portable app uses .NET Framework 4.8 and the Microsoft Edge WebView2 Runtime.
- **Debian or Ubuntu.** In the download folder, run `sudo apt install ./waffle-eda_0.8.2_all.deb`. Open **Waffle EDA** from the app menu or run `waffle`. The package also installs `waffle-mcp`.

Compare your download’s SHA-256 with the checksum supplied beside it.

## Smoother PCB view

- Zooming a dense board draws faster. On macOS, a dense-board zoom frame now takes about 2 ms at the median and 6 ms at the 95th percentile, down from 9 ms and 13 ms. On Linux, text is sharp again after a first zoom in 1.6–2.0 s instead of 2.7–2.9 s.
- Resizing a side panel or the window next to a board no longer repaints the whole board on every frame, whether you drag, use the keyboard or toggle a panel. DRC markers, DNP crosses and other overlays stay on the board while you resize.
- Pinch zooming out of a large board stays smooth instead of redrawing it exactly on every frame.
- Dropping a dragged part, and undoing that drop, no longer freezes on a large board: on an imported Altium board, drop fell from about 400 ms to 100 ms and Undo from about 300 ms to 60 ms.
- The 3D view keeps package markings visible at every distance.
- The board connectivity solver loads when you first open a board, so the Start page and schematic-only work start with less to load.

## Better Altium and KiCad imports

- **Pours** follow Altium's rules. Planes keep their plane clearance, rectangular lands get square clearance corners, and thermal relief spokes have Altium's shape. Islands are removed before spokes are added, so a pour no longer reports a connection its copper doesn't make, and hatched pours connect more lands. KiCad zones import the board's edge clearance and minimum thickness. Repoured copper is much closer to the fill stored in the file: on the MIDAS board, the share of copper that differs fell from 1.4% to 0.2%.
- **Hole clearance** is a new DRC rule. It applies only where a design sets one, and it measures from each land's real outline, slots included.
- **Signal intent.** Altium parameter sets on wires, labels and pins become net classes, differential pairs and tags, and so do KiCad net class flags. Altium export writes them back.
- **Parameters** keep the names the source uses: Altium schematic parameter names are no longer upper-cased, EasyEDA Standard keeps every part attribute, and Eagle schematics bring in technology and part attributes.
- **Curves.** Altium arcs, elliptical arcs, ellipses, circles and Bézier curves stay true curves on schematics.
- **Component classes** from Altium are kept.
- **Web links** on schematic text, Altium hyperlinks and PCB component links survive import, save and Altium export. Properties lists them under **Web links**, and you can add a link to any text.
- **The import report** counts bookkeeping records as not applicable instead of dropped, so the dropped count shows what was really lost.

## A more consistent interface

- **Properties** is rebuilt on one row design. Every value starts in the same column, fields and menus fill it, number fields show their unit inside the box, and settings that apply at once use switches. PCB components and tracks group their properties, and rows keep the same order however the panel loads.
- **Controls.** Disabled fields, switches, checkboxes and radio buttons now look disabled. A locked switch shows a lock and says why. Checkboxes and radio buttons are drawn by Waffle, so they look the same on every platform. Menus, lists, tooltips and hover cards share one corner radius, icons share one optical size, and segmented controls slide to the new choice.
- **Fields.** Invalid fields show their red border again (missing since 0.8.0). Read-only fields are visible in the dark theme.
- **Keyboard Shortcuts.** Conflicts show as a red chip, and the editor's actions are icon buttons.
- **Layering.** File and Edit menus open above floating panels and context menus. Scroll bars, net-name completions, canvas hints, the timing readout and the note editor no longer draw above menus, panels or dialogs that cover them, and they move with a floating panel. A net-name completion follows Properties as it scrolls and is cut off with its field.
- **Scroll bars** animate as they widen under the pointer.
- **Dividers.** Every panel divider and column grip lights the same way on hover, drag and keyboard focus.
- **Motion.** The floating toolbar and switches follow the Reduce motion setting. Panelize presets no longer shrink when pressed.
- **Projects and tabs.** The Projects tree fills its panel, so every document of a large project shows. A tab strip that overflows fades at its edges and lists every tab in a ⋯ menu.
- **Problem markers** are smaller and lighter, and parts that are not fitted fade under a light veil with a thin cross instead of a dark block and a red X.
- **Messages.** Show in Messages selects the exact message and scrolls to it. Filtering is faster, and Fix buttons sit on the rows they fix. "Show history" appears only when the file is in Git.
- **Font.** A Mac or Linux machine that also has Segoe UI installed now uses its own system font.

## Fixes

- **Checks.** Matched lengths count pad and via entries in full, which cuts most false Matched Length findings on imported Altium boards. Online DRC no longer stays on "Checking…" after you open a board with pours: pour clearance is checked straight away instead of after the next edit.
- **Picking on the board.** A click picks parts on the current layer's side first, as in Altium: with a top layer current, a top part wins over a bottom part stacked under it, and a track on the current layer wins over the other side's pad. A part on the other side is still picked when nothing on the current layer or side is there.
- **Routing.** Pressing Escape or clicking the same point twice while routing no longer leaves a zero-length track in Undo. The first edit after routing is faster.
- **Checks and geometry.** Clearance, short and DFM checks measure plated slots, back-drilled vias, slot rings, copper inside a hole and via stubs on long pads or pours by their real shapes. A track that ends inside a via land gets a teardrop. The GPU view no longer fills a region's cutouts. Resizing or moving the board keeps its cutouts. View history Back restores rotation.
- **Schematic.** Rotating, mirroring, resizing and fitting a part or sheet symbol keep wires, power ports, ports and net labels attached, including from the Properties rotation, width and height fields. Sheet entries using `Repeat()` sync without extra entries.
- **History and merge.** Moving an item to different sheets on two branches, or moving it on one while deleting it on the other, is now a conflict instead of a duplicate or a silent revert. Renaming one automatic net name to another is detected. Certain item orders could make the next insert hang; they no longer do.
- **Paste.** Paste Array places image markups correctly, pasting a part whose footprint already exists keeps its STEP model, and pasting an image note with text no longer fails.
- **Imports.** Eagle `mil` sizes, STEP files in decimetres, feet or mils, short Altium track and pin records, EasyEDA nets listed before their part, and malformed numbers in EasyEDA, IDF and DXF files are read correctly or skipped with a note, without losing the rest of the file.
- **Outputs.** Mirrored parts are exported where the board draws them in IPC-2581, KiCad, STEP, EasyEDA Pro, EasyEDA Standard and Altium. KiCad writes slots as oval drills. Flex through holes are no longer labelled blind. IDX and IDF keep slots, Eagle keeps unnetted vias, and the drill report states the drill origin.
- **Library.** Chip LEDs and tantalum capacitors get pin-1 and polarity marks, and pin-1 marks follow pad number 1. SMD connector pegs pass library health. The Symbol Wizard keeps hidden pins, and library search finds `pkg:qfn`.
- **Calculations.** Absolute temperatures stay in °C through `min`, `max`, `average` and sums, and °C and Δ°C no longer convert into each other. Table cells can read net fields such as `net VDD.voltage`. Copied results paste back as the same value (`1e12` no longer copies as `1 T`).
- **Scripts and MCP.** Script results now carry BigInt (as text), Map and Date values correctly, and no longer fail on self-referencing values. Find and replace on a selection finds its document. Cancelling an extension update keeps the permissions it already had.

## Changed behaviour

- **Unplated lands.** The copper ring of an unplated pad now belongs to the pad's net on each layer, with no connection between layers. Copper of another net touching it is a short and a clearance error, and a land with no net that bridges two nets is a short. A pour never connects to it, and one pad counts as a single ratsnest connection. The router can still route over the ring, and DRC now reports that.
- **Picking.** A click on the board prefers parts on the current layer's side (see Fixes).
- **Altium parameter names** keep the source's spelling instead of upper case, so Properties, BOM columns and Altium export show "Manufacturer Part Number", not "MANUFACTURER PART NUMBER". EasyEDA Standard and Eagle parts bring in more parameters, so BOMs can gain columns.
- **Matched Length** results change, because pad and via entries count in full.
- **Mirrored parts in IDX.** The first IDX change check after upgrading flags existing mirrored parts as changed, once. The drill report now names the drill files' origin, not the Gerber origin.
- **Temperatures.** Mixing an absolute temperature (°C) with a difference (Δ°C) in a comparison, ranking or conversion is now a unit error. `average(20 °C, 30 °C)` now gives 25 °C.
- **v2 API designators.** Setting a duplicate or empty designator through the v2 API or a script transaction is now refused.
- **Rotating and mirroring from scripts and MCP** avoids shorting pins by default, as the editor already did.
- **Multi-gate parts.** Gates of one symbol may share a designator through the v1 API when their units differ, as the editor already allowed.
- **Missing Courtyard** is off by default. When you turn it on, its findings stay in Messages and draw on the board only while one is selected.
- **Efficiency mode.** Automatic now follows the system's power-saving mode, not the battery: Low Power Mode on macOS, energy saver or battery saver on Windows, and Power Saver on Linux. In a browser only **Always** turns it on.

## Known issues

- Altium project variants are not imported yet, so parts that are not fitted in a variant still appear in the BOM.
- Large boards still miss the 8 ms per-frame target for dense-board gestures under heavy CPU load.
- On some runs, the GPU view shades lettering and the edges of copper openings slightly differently from the 2D view. This also affects 0.8.0 and 0.8.1 and is under investigation.
- Extreme-radius arcs and clearance decisions very close to a threshold remain under investigation.
- Physical pen input, foreground 120 Hz Mac input and a native Windows launch remain unverified.

[0.8.1 release notes](../../../releases/tag/v0.8.1)
