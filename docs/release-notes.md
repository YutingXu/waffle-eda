# Waffle EDA 0.8.1 · Butter

Butter 0.8.1 is a usability and fix release. It opens and saves the same native format 2.0 projects as 0.8.0; nothing in your files changes when you upgrade.

## Install

- **macOS 12 or later, Apple silicon or Intel.** Open `Waffle-0.8.1.dmg`, drag **Waffle** into **Applications**, and follow **Read Me First** for the first launch. The app is ad hoc signed and unnotarized.
- **Windows (Preview).** On Windows 10 (1903 or later) or 11, x64 or Arm64, extract `Waffle-0.8.1-windows.zip` and run `Waffle.exe` from the extracted folder. Keep its accompanying folders together. The unsigned portable app uses .NET Framework 4.8 and the Microsoft Edge WebView2 Runtime.
- **Debian or Ubuntu.** In the download folder, run `sudo apt install ./waffle-eda_0.8.1_all.deb`. Open **Waffle EDA** from the app menu or run `waffle`. The package also installs `waffle-mcp`.

Compare your download’s SHA-256 with the checksum supplied beside it.

## Faster PCB navigation

- Wheel zoom, pan and touch navigation on large boards do less work per frame. On an 11,000-item board, main-thread draw time at the 95th percentile fell from about 66 ms to 24 ms for wheel zoom and from 23 ms to 9 ms for pan on Linux.
- Wheel zoom steps that are still settling are kept when a pan starts.
- Panning uses far less GPU scratch memory, and closing a board or 3D view releases its resources.
- Startup defers styles, the History graph and diagnostics that are not needed yet.
- A board too large for GPU memory falls back to 2D drawing once instead of retrying on every edit.

## Fixes

- **Copper and checks.** Copper no longer shows stale fills after Undo or Redo. Online DRC findings that a manual check leaves out reappear after it, and the manual findings stay visible until then. Clearance, annular ring, slot isolation, drill spacing and short checks cover several more cases, including region cutouts, via drill walls and copper fills on footprints.
- **Placing and selecting.** Drag a library part onto the canvas to place it where you release it; double-click places it too. Picking on PCB arcs, curved regions, flipped boards, schematic wires, dimension leaders and mask openings selects what you see. Active-layer objects win a click in dim layer mode.
- **Schematic editing.** Wires, junctions and power ports stay connected through drags, symbol updates, pin-table edits, sheet entry moves and port synchronisation.
- **Imports.** KiCad, Eagle, Altium, EasyEDA, DXF, IDX and STEP readers skip malformed geometry without shifting the rest. Separately placed KiCad components keep their own footprints, and unspecified KiCad pins import as passive. The Symbol Wizard lists derived KiCad symbols.
- **Outputs.** The KiCad BOM writes negative values as numbers. Panel BOMs keep leading zeros in designators. The listed JLCPCB order job now carries the same Gerber setting as the JLCPCB preset (its output was already correct).
- **Interface.** Menus, dropdowns, tabs, docked panels, History and the bottom bar keep focus, size and position steadily. Controls share one hover and press style. Library search keeps focus when the panel reopens.
- **Analysis and queries.** The field solver reuses one background worker. STEP model reading keeps its worker reliable in the macOS app. `pinCount` counts footprint pads on a board consistently.
- **Settings.** Export and Reset all settings include the review-notes pen and per-sheet note visibility, the print report page and the footprint wizard rounding.
- **Windows (Preview).** Windows draws a single Waffle title bar.
- **Diagnostics.** Crash Diagnostics counts errors over the last seven days, and clearing diagnostics resets them. The desktop apps count uncaught errors again. Reports contain only counts, never file names or messages.

## Known issues

- Large boards still miss the 8 ms per-frame target for dense-board gestures under heavy CPU load.
- On some runs, the GPU view shades lettering and the edges of copper openings slightly differently from the 2D view. This also affects 0.8.0 and is under investigation.
- Extreme-radius arcs and clearance decisions very close to a threshold remain under investigation, as in 0.8.0.
- Physical pen input, foreground 120 Hz Mac input and a native Windows launch remain unverified.

[0.8.0 release notes](../../../releases/tag/v0.8.0)
