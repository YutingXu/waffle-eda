# Waffle EDA 0.8.0 · Butter

Butter opens and saves native format 2.0 projects. An earlier reader opens a document read-only when it encounters a required feature it cannot edit.

## Install

- **macOS 12 or later, Apple silicon or Intel.** Open `Waffle-0.8.0.dmg`, drag **Waffle** into **Applications**, and follow **Read Me First** for the first launch. The app is ad hoc signed and unnotarized.
- **Windows (Preview).** On Windows 10 (1903 or later) or 11, x64 or Arm64, extract `Waffle-0.8.0-windows.zip` and run `Waffle.exe` from the extracted folder. Keep its accompanying folders together. The unsigned portable app uses .NET Framework 4.8 and the Microsoft Edge WebView2 Runtime.
- **Debian or Ubuntu.** In the download folder, run `sudo apt install ./waffle-eda_0.8.0_all.deb`. Open **Waffle EDA** from the app menu or run `waffle`. The package also installs `waffle-mcp`.

Compare your download’s SHA-256 with the checksum supplied beside it.

## What’s new

- Query designs, follow links, and compare saved and working changes in visual history.
- Work across multiple windows and save views to revisit. Use drag and drop, the PDF reader, notebook tables and slides where their corresponding features are enabled.
- Run repeatable actions with macros and review proposals in Ask AI.
- Use ODB++ alongside Gerber and drill outputs. Check plotted files in an independent viewer before fabrication.

## Editing and manufacturing fixes

- The Problems badge shows **Checking…** while Design Insights checks the active board. Existing findings stay visible, and the badge shows **0 problems** once both DRC and Insights finish without findings.
- Find and Replace opens again after its panel has already been used. Context menus and panel-splitter drags also respond more quickly on the dense-board benchmark.
- PCB zoom keeps the active copper and legend layers visible when the wheel changes direction. The GPU view keeps active-layer guides legible as you zoom out. Stacked pad captions use the same position, orientation and size in the ordinary and GPU renderers.
- Clearance checks, interactive routing and copper refill follow authored track arcs. Printed inner-layer selections include stack-only copper layers. Named copper sheets in Print and PDF show plated slots and blind bores at their physical depths. Reopening a STEP board preserves plated slots, unplated holes and blind-drill depth.
- Exact text queries now count objects that lack the compared field. Case-sensitive matching and its suggested spelling continue to work on indexed boards.
- Folder libraries include components that have both a schematic symbol and a PCB footprint. The desktop app keeps the catalogue across restarts. Rescanning repairs affected entries and reuses healthy entries.
- Moving a schematic component through an extension or Ask AI preserves attached branches, junctions and named nets. The move remains one Undo step.
- Saving the active board avoids refreshing unrelated project-tree metadata when a drawing reader first loads.
- The file-backed PDN and thermal workers now load the material constants they need on first use.
- History clears its unsaved indicator when Save succeeds and when an automatic refresh finishes without changing the document. Its screen-reader label follows the same state.

## Known issues

- In flat on-screen board views, copper belonging to another object can cover a drilling cue. A blind-hole cue can also mark an unaffected layer. The six-fixture checks separately verified the exported copper films, drill spans and represented solid faces.
- Extreme-radius arcs and clearance decisions very close to a threshold remain under investigation. DFM reports when a curve exceeds its supported calculation size. Local refill can clear large arcs and preserve prior copper when a full solve exceeds its budget. Large-board refill and some editing timings still exceed their budgets.
- Physical pen input, foreground 120 Hz Mac input and a native Windows launch of this release remain unverified.

Butter Preview and Butter both report version 0.8.0. To switch from Preview, use the Butter downloads. On Debian or Ubuntu, run `sudo apt install --reinstall ./waffle-eda_0.8.0_all.deb` if Preview is already installed. Experimental features keep their existing preferences.
