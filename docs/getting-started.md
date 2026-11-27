# Getting started with Waffle EDA

This guide takes you from an empty project to fabrication files. Menu paths are shown as **Menu → Item**. Key sequences such as `P` `W` are pressed one key at a time. `Mod` means Ctrl on Windows and Linux and ⌘ on macOS. The full list of keys is in [shortcuts.md](shortcuts.md).

**Prefer to learn by doing?** **Help → Your First Board Tutorial** (also on Welcome under **Learn → Your first board · 10 min** and in the command palette) builds the same kind of board interactively in about 10 minutes: an LED, a resistor and a connector, wired with GND and VCC, through ERC, Update PCB, board shape, placement, routing, a GND pour, DRC and fabrication files.

- A small card docked at the top of **Properties** names each command with its menu path and keys (from your key map, so it follows rebinding and presets) and highlights the menu or button. A step completes when the design shows it is done; there is no Next button.
- **Skip: do it for me** performs the step with the same operations the MCP tools use, as one undo step.
- Choose **Coming from Altium?** or **Coming from KiCad?** at the start for notes on the differences (KiCad names, key presets). The KiCad track offers to switch to the KiCad-like keys.
- It runs in a practice project, never yours. If you open another project the tutorial pauses; **Back to the tutorial** returns to the practice board. At the end, **Back to …** reopens your own project.
- Progress is saved: closing the card and choosing the command again resumes it. **Restart** starts over.

**Coming from KiCad?** The default keys follow Altium. Choose **KiCad-like** in **Preferences → Keyboard → Key preset** for W to draw a wire, X to route a track, and M to move. Allegro users can pick **Allegro-like** (F2 zoom fit, F3 add connect, F6 done, F7 oops, F8 cancel, X for typed coordinates), and Mac users who prefer ⌘ and one-letter tools **Modern (Mac)** ([docs/keymap-modern-mac.md](keymap-modern-mac.md)). The command palette (`Mod+Shift+P`) also understands KiCad words: *ERC*, *zone*, *edge cuts*, *gerber*, *netlist* and so on.

## 1. Install and open

- **macOS 12 or later:** open the Waffle disk image and drag the app from the Waffle EDA Installer window into Applications. It currently has an ad-hoc signature, so macOS refuses the first double-click: on macOS 15 and later choose **System Settings → Privacy & Security → Open Anyway**; on macOS 12–14 right-click Waffle and choose **Open**. After that it opens normally. To build it yourself, run `./scripts/build-mac.sh` and `./scripts/build-dmg.sh` (needs Xcode).
- **Windows 10 (1903+) or 11:** extract the Waffle portable ZIP and run `Waffle.exe`. It uses the WebView2 runtime that ships with Windows. The build is unsigned for now, so SmartScreen asks you to confirm the first launch (More info → Run anyway). See [windows.md](windows.md).
- **Debian/Ubuntu:** install the downloaded `waffle-eda_<version>_all.deb` using `sudo apt install` with its path, then select Waffle EDA from the applications menu or run `waffle Design.waffle`.
- **Other Linux:** run `./scripts/launch-linux.sh`. It uses GTK and WebKitGTK when they are present and your browser otherwise.
- **No install:** open `app/index.html` in a current browser.

Choose **File → Open…** to select a native 2.0 project folder or its `.waffle` manifest. To use a design from Waffle 1.x, re-import its original EDA project. Keep the whole native folder when copying the design. [Opening source designs](importing.md)

### Welcome and recent projects

By default, Welcome opens when you start Waffle with an empty editor. On first run, **Coming from** lets you choose a keyboard and mouse preset alongside the starter templates. When you return, use the **Filter** on **Recent projects** to find a project, or start from a featured template. **All templates…** opens the full catalogue.

- **New Project…** opens the project naming dialog. **Open…** opens a saved project. Use **Import from Altium or KiCad…** to start with a source design.
- **Try the Demo** opens the example sensor design. **Recover Unsaved Work…** opens the local recovery list when available.
- **Customise Waffle…** opens the setup walkthrough. **Continue to editor** closes Welcome. Reopen it from **Help → Start Page**. To change when it opens, use **Preferences → General → Show the start page**.

## 2. Schematic

1. Choose **New Project…** and give the project a name. You get one schematic sheet and one empty board; Waffle opens on the schematic, fitted to the whole sheet (press **F** to fit again).
2. **Place → Part** (`P` `P`) opens the **Library** panel with its search focused; select a component and press **Enter** (or drag it onto the sheet) to place it. **Place → Component Catalogue…** opens the catalogue dialog with the symbol editor and footprint wizard. To generate a part with your choice of value and package, use **Place → Generic Part → Choose Generic Part…**. Press **Tab** while a part floats to edit it before placing. Placement stays armed and designators increment (C1, C2, …); press **Esc** to stop.
3. While a part floats, press **Space** to rotate it and **X** or **Y** to mirror it.
4. Draw wires with `P` `W`. Click to add vertices, press Space to change the corner direction, Backspace to remove the last vertex and Esc to finish. Junctions appear automatically at T-joins.
5. Add power ports from **Place → Power Port → GND / VCC / +3V3 / +5V / VDD**, from the **GND** and **VDD** buttons on the Active Bar (or `P` `O`, then **Tab** to name any other net), net labels (`P` `N`) and ports (`P` `R`). Labels auto-increment (D0, D1, …).

   **Active-low names (negation).** Start a name with a backslash to draw it with a bar over the whole name: `\RESET` shows R̅E̅S̅E̅T̅. A backslash after a character bars that character only, as in Altium: `R\E\S\E\T\` or `C\S\`. To show a literal backslash at the start, type two: `\\RESET` shows `\RESET`. This applies to net labels, ports, power ports, pin names, sheet entries and off-sheet connectors, and to PDF output and to PCB text on silkscreen (text imported with an Altium-recorded box keeps its source look). It is display only: the net is still named `\RESET`, so it connects only to other `\RESET` labels, and netlists and exports keep the backslash. **Preferences → Schematic → General → Single “\” negation** turns the whole-name form off (Altium's default); `\RESET` then shows its backslash and only `R\E\S\E\T\` is barred. Altium projects keep their names as written, so a sheet drawn in Altium with the option off can now show `\RESET` barred.
6. **Tools → Annotate Schematics…** numbers the designators.
7. **Project → Validate Project (ERC)** (also on the schematic's **Tools** menu) runs the electrical rules check. Results appear in the docked Messages panel. Click a row to locate the object. **Project → Project Options (Error Reporting)…** sets the severity matrix.

New parts: **Design → New / Edit Symbol…** (`T` `Y`), **New / Edit Footprint…** (`T` `P`) and **IPC Footprint Wizard…** (`T` `F`).

Use the **Library** panel to preview both assets and choose between package variants for the same chip. See [Organize component families and packages](sourcing.md#organize-component-families-and-packages).

For hierarchy, use **Place → Sheet Symbol…** (`P` `S`) and Sheet Entry, and move between levels with **Tools → Up Hierarchy** / **Down Hierarchy**. For multichannel designs, put `Repeat(CH,1,4)` in a sheet symbol's name; see **Project → Multichannel…**.

### Sheet size and frames

Choose **Infinite canvas** from **All templates…** on Welcome, or open **Properties → Document settings → Sheet size** on a schematic and choose **None (infinite)**. The grid continues in every direction. **Fit** includes the drawing and its frames. A title block is optional and sits below the lower-right corner of the drawing. Choose a paper size to restore a border. An imported sheet with recorded paper dimensions also offers **Source sheet**.

On any schematic, choose **Place → Frame**, click opposite corners and enter a name. Drag a border or the title to move the frame with its contents. Hold **Ctrl** on Windows or Linux, or **⌘** on Mac, while dragging to move the frame alone. Drag a corner grip to resize it. Properties lets you edit the name and dimensions.

Frames include complete wires, buses, symbols and nested rectangles. A point annotation belongs to a frame when its anchor is on or inside the border. Objects crossing the border stay in place. A wire connected to a moving symbol follows at that endpoint. Equal-size frames at the same position stay independent, and an object included by several selected frames moves once. Frames leave electrical connectivity unchanged. Click a frame under **Navigator → Frames** to jump to its location from a sheet or board.

## 3. Board

1. Open the board tab. **Design → Board Shape → Board Wizard…** offers rectangles, rounded or circular boards and form factors (Raspberry Pi HAT, Arduino Uno, Feather, M.2, Eurocard and more) with mounting holes. You can also draw lines and arcs and use **Board Shape: Define from Selected Objects…**, or use **File → Import → DXF…**.
2. **Design → Layer Stack Manager…** sets layers, materials, drill pairs, via types and impedance profiles.
3. **Design → Rules…** (`D` `R`, or right-click an object › **Rules for This…**) opens the Rules and Constraints Editor as a tab beside your documents, in the pane you are working in (also when the editor is split). Escape returns to the canvas; the tab stays until you close it. **Design → Fab Profiles…** loads approximate fabrication-house limits; check them with your manufacturer.
4. **Design → Update PCB Document…** adds the footprints and nets from the schematic. The dialog lists the *Engineering Change Order* (ECO): the changes to apply. Review them, then choose **Execute Changes**. The whole update is one undo step, and Waffle switches to the board, fitted so the new parts are in view (**Preferences → Schematic → After Update PCB** can keep you on the schematic instead). Then choose **Define Board Shape…** in Properties if the board has no outline yet.
5. Place parts. Smart guides snap to neighbours' edges, centres and pad rows. Press **L** while moving to flip a part to the bottom side. **Edit → Align…** and **Make Row at Pitch…** help line parts up.
6. To view the schematic and board side by side, choose **Window → Split with Schematic** on a board or **Split with Board** on a sheet. The shortcut is `Mod+Alt+\`. You can also use the button beside Split on the tab bar. With the split open, the shortcut shows the selected part’s counterpart in the other pane.
   - **Follow** is on whenever the other pane shows a document of the other kind. Click a part, pin, wire, track or net and the other pane eases to the matching objects and pulses them briefly; your pane keeps the focus. It does not move when the object is already comfortably in view, and it never zooms in further than about 12 mm of board (60 mm of sheet). Turn it off with the eye on the other pane's tab strip or **Window → Follow in Other Pane**; the choice lasts for the session.
   - Ctrl/⌘+click a board object to highlight its net: the net lights up in both panes. Ctrl/⌘+double-click still cross-probes explicitly (also without a split), and a plain double-click still opens Properties.

### Touchscreen

The same gestures work on every canvas, however dense the design:

- **Tap** selects; tap the selected object again for the next one under your finger. Tap empty space to clear the selection.
- **Drag with one finger** to pan. Drag something already selected to move it.
- **Touch and hold, then drag** to pick up an object and move it, or to draw a selection box from empty space. Touch and hold, then lift, for the context menu.
- **Two fingers** pinch to zoom and pan. **Tap with two fingers** to undo, **with three** to redo.
- With a tool armed, one finger draws or places and two fingers still move the view. A stylus works like a mouse.

## 4. Route

- **Route → Interactive Routing** (`P` `T`): Shift+R cycles walkaround, push and hug modes; Shift+Space cycles corner styles; `*` changes layer; `2` adds a via; Backspace retracts. Ctrl+click auto-completes the connection.
- **Differential pairs** (`P` `I`) show the live skew in the status bar. **Length tuning** (`T` `R`) and **Route → Length Manager…** handle matched groups.
- **Route → Auto Route » All…** runs the autorouter. **Auto Route » Fanout…** escapes BGAs and fine-pitch parts. Choose **Engine v2** in either dialog for a previewed proposal with fewer vias ([autorouter.md](autorouter.md)).
- **Place → Polygon Pour** (`P` `G`): draw the outline, then set its properties. A new pour connects to GND when the board has a ground net (otherwise the net with the most pads). **Tools → Polygon Pours → Repour All** repours them. **Design → Pour Manager…** lists every pour.
- Optional finishing: **Tools → Teardrops…**, **Place → Via Fencing…**, **Tools → Stitching**.

## 5. Check

- Online DRC is on by default. Zoom out on a PCB and nearby violations share a marker for the most severe finding in view. Hover to inspect the group, or zoom in to separate nearby locations. You can also select an individual finding in **Messages → Problems**.
- A badge with a double outline points to a problem on the schematic. Click it to open the finding at its source. Purple diamonds are Design Insights. Both types of marker also group nearby findings as you zoom out on the board.
- **Tools → Run Design Rule Check** (`T` `D`) runs every rule and lists the results in Messages; the rules that passed collapse into one row (click it to list them). Choose **Report…** for an HTML report.
- **Shift+H** toggles the heads-up display (deltas, net and layer under the cursor).
- On a PCB, choose **View → 3D Layout Mode** or press **3**. Use **0** for Top, **9** for Bottom and **F** to flip the view. The toolbar’s **Fit** button shows the active shortcut. Press **2** for 2D or **1** for Board Planning.
- **Mouse or Mac trackpad:** click-drag to orbit. Shift-click-drag or secondary-button drag pans. Two-finger trackpad scrolling pans horizontally and vertically. Use a mouse wheel or a pinch to zoom toward the pointer or pinch midpoint. Click a component to select it, Shift-click to add it, or double-click to centre and zoom to it. The arrow keys orbit, and holding Shift while pressing an arrow key takes larger steps.
- **Touchscreen:** tap a part to select it, or drag with one finger to pan. Two fingers can pan and pinch to zoom together. To orbit with one finger, open **View options → Orbit with one finger**.

## 6. Outputs

- **File → Fabrication Outputs…** (named after the project, for example `My-board.GTL`; change it under **File names**) writes Gerber X2, Excellon drill files, pick-and-place, assembly drawings and a readme, as one ZIP.
- **File → Release…** builds a release package from repeatable output sets: presets for JLCPCB and PCBWay orders, generic fab + assembly, documentation only, or everything. Each output card shows a live preview; the Pre-flight tab runs DRC, ERC, BOM and variant checks, and every override is recorded with its reason; the Releases tab compares two releases.
- **Reports → Bill of Materials…** opens the BOM grid. The **Optimise** tab suggests line merges.
- **File → Export 3D STEP…**, **Print…** and **Export PDF…** cover mechanical and documentation outputs.
- **File → Export → Export Design…** writes KiCad files, or a verified native Altium copy of an imported `.SchDoc` / `.PcbDoc` (see [importing.md](importing.md)).

The same outputs run headless: `python3 mcp/server.py --project board.waffle --cli run_output_job --args '{"job": "JLCPCB order"}'`. See [mcp-and-cli.md](mcp-and-cli.md).

## 7. Save and review

- In a 2.0 project folder, **Mod+S** saves the active document and **File → Save All** saves pending changes across the project. The `.waffle` manifest and its linked files use one JSON record per line for ordinary Git diffs. Autosave keeps local snapshots, which **File → Recover…** can restore.
- **Project → Compare → Compare…** shows a visual diff against Git history or another saved copy. [Git quickstart](../scripts/git-waffle.md)

## Finding things

- **Command palette** (`Mod+Shift+P` or F1): `>` searches commands, `@` finds objects (U1, GND, U1-3) and `:` jumps to coordinates.
- **Help → Keyboard Shortcuts** (Shift+F1) shows a live cheat sheet. **Tools → Keyboard Shortcuts…** rebinds keys.
- **File → Preferences…** (`Mod+,`) opens a searchable window with 15 built-in pages. You can keep editing while it is open. Changes apply as you make them. Close it with the titlebar button or press **Esc** while it has focus.
- Look under a setting’s label for help where available. The field includes that help as an accessible description, and many fields also offer its full text on hover. **Restore Defaults…** at the bottom asks you to confirm a reset for the current page.
- **The Active Bar** over the canvas holds the drawing tools. Hold a tool, right-click it or press ↓ on it for its flyout; the tool you choose there becomes that button until you choose another, for each document kind. On schematic sheets the bar also has **GND** and **VDD** power ports and, with notebook features on, **Widgets**: the text blocks, calculations, images, tables, to-do lists and other sheet widgets the **/** palette can insert, including widgets from extensions. When the canvas is too narrow, the last tools move into a **⋯** menu.
- **View → Customise Active Bar…** (also in the command palette, and on the bar's right-click menu) opens **Preferences → Toolbars**. Pick Schematic, PCB or Drawing, then add commands and saved macros with the search field, drag a button by its handle or select it and press Alt+↑ / Alt+↓ to move it, put a button into the previous button's flyout, add separators, or remove buttons. The bar changes as you edit. **Reset** restores one kind's bar; **Restore Defaults…** restores every bar and forgets the remembered flyout choices. Macros with parameters open their **Run…** dialog from the bar. A button whose command is not available (an extension that is switched off, a macro from another workspace) is kept and comes back with it.
- **Window → Panels** shows and hides editor panels. Use **View → Theme** for appearance changes and **Appearance Settings…** to open that page in Preferences.
