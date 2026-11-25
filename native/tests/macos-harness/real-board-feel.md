# Real-board macOS interaction lane

Use a signed `WaffleHarness.app` built by [build.sh](build.sh), a saved format 2.0 project with a populated PCB, and an unlocked display. The project is copied into a new temporary directory and opened through the desktop application. The public Altium sources are pinned in [the fixture manifest](../../../tests/altium-fidelity/fixtures.json). Open and save a source as a project folder to supply a manifest. The runner uses an ephemeral WebKit profile and checks every original file and saved copy against its starting bytes.

```sh
python3 native/tests/macos-harness/real-board-feel.py /path/WaffleHarness.app \
  /path/Project.waffle --display 1 --hz 240
```

Pass the active CoreGraphics display ID and refresh rate. Keep the harness window foreground throughout. The runner checks native visibility, foreground focus, 2× backing, display mode, trusted canvas input, camera and anchor convergence, and exact restoration after Undo. The opt-in lane uses actual wheel, pointer and menu input confined to the harness's AppKit event route.

Use `--repetitions 1 --edit-only` for an open, move and Undo correctness smoke. Use `--private` to suppress native log output, disable window sharing and redact design identifiers from the result. For a public PCB, `--shot redacted-local-path` captures the focused board after all timing samples. The timing and snapshots require a real desktop session, so this lane is separate from the default unit tests. Repeat the command in independent processes for measurements across several fresh editor sessions. Use `--repetitions` to exercise reopens and gestures in the same window.

For investigation, `--drag-diagnostic` records trusted pointer and capture transitions and the move intent. Add `--legacy-drag` to exercise the original single-call drag route. The normal runner sends a separate AppKit press and then the paced movement and release. A rejected diagnostic includes the completed repetitions and exits nonzero. AppKit-generated input can reach the canvas with a zero buttons bitmask. The runner requires the editor to start a move and change part geometry before it accepts an edit.

The workload closes and reopens the project, selects and drags a part, undoes the edit, zooms into the highest-pad usable footprint, pans diagonally through its routing, and sends centre-anchored Control-wheel reversals. The camera work uses the GPU renderer after the initial edit. A separate isolated-notch pass records WebKit's post-draw presentation acknowledgements. Raw event-to-draw samples, animation callback intervals, changed draw intervals, draw CPU, settling and idle counts are included in the JSON output. The probe also measures a trusted schematic-to-board tab switch when both document controls are visible.

The warm-open clock starts before sending the AppKit file-open request and ends after the first populated editor draw. The input clocks use trusted DOM arrival or the window event stamp and end at the first later changed draw. Use presentation acknowledgement only for the isolated notch samples. Physical input and display scanout require a separate measurement.
