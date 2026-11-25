# Generated schematic output cases

These eight directories contain the exact eighteen project, sheet and companion PNG files supplied to the native Designer probe. All inputs are Waffle synthetic engineering examples.

| Case | Source and expected result |
| --- | --- |
| `frames` | The Frame example exported from the browser with one sheet per named frame at `7348ae90`. Assembly links Input and Control. TP1 and TP2 share SIGNAL. The three physical pages measure 173.228 × 110.744 mm, 76.962 × 45.466 mm and 50.800 × 19.812 mm respectively. |
| `rich` | The mixed notebook example passed through the formal Altium project export at `2527a333`. Each of the four field-note frames has a second line with its resolved font sample name and inline fraction. The additional schematic label holds the static display equation. |
| `rc`, `rc-changed` | The public calculation compatibility example passed through the same formal exporter with C3 at 1 nF and 2 nF respectively. Native text should contain 15.92 kHz and 7.958 kHz. Each schematic contains R5 and C3. The example component definitions have zero pins. |
| `clip`, `clip-alt` | The image clip physical export corpus. The project carries a 400 × 200 px PNG. The Altium rectangle measures 40 × 20 mm, from (27.62, 26.20) to (67.62, 46.20) mm in Altium's y-up coordinates. The opaque PNG contains nine disjoint gold pads. The standalone sheet contains the label “Synthetic copper pattern”. |
| `ink`, `ink-alt` | The drawing from `tests/notebook/review-foreign.cjs` at `06564843` passed through the project/standalone browser exporter at `a32870b0`. The 264 × 264 px violet highlighter occupies a 22 × 22 mm rectangle, from (26.78, 25.96) to (48.78, 47.96) mm. The PNG samples at its crossing and a single stroke are both RGBA (108, 72, 136, 71). The standalone label reads “Highlighter stroke, violet, 2 mm”. |

For a bounded verification on a Mac with an already-open Designer session, run `python3 tests/altium-wine/check_schematic_outputs.py --out redacted-local-path`. The probe copies the files to a fresh directory, builds the repository's launcher in that directory, checks the existing application window, opens each generated project, queries its schematics, compiles its flattened netlist and restores the previous active document. Pass `--window-id` with the existing window's macOS ID to capture the native drawings. The resulting `comparison.json` compares native records with the source files. The coordinate checks allow 0.011 mm per edge.

Designer supplies the paper dimensions, rectangle coordinates and flattened pin counts through its native scripting API. [Schematic document API](https://docs.developer.altium.com/ad-sdk-docs/reference/sch/ISch_Document/) · [Image API](https://docs.developer.altium.com/ad-sdk-docs/reference/sch/ISch_Image/) · [Native net model sample](https://docs.developer.altium.com/ad-sdk-docs/samples/NetPinConnection/)
