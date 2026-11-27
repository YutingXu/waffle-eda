# Thermal checks: current capacity and temperature rise

Waffle has three thermal tools for board layouts:

| Where | What |
|---|---|
| **Tools › Thermal › Current Capacity Check** | Every track segment, pad and via barrel of the nets that carry a current, against an allowed temperature rise (IPC-2152). |
| **Tools › Thermal › Temperature Rise Map…** | An **estimate** of the board's steady-state temperature rise, per copper layer, as a colour map on the board. |
| **Design › Current Capacity Rules…** (and the **Current Capacity** rule type under *Electrical* in **Design › Rules…**) | The design rule that the DRC checks: nets or classes get a required current and an allowed rise. |
| **Tools › Calculators › Current capacity** | The calculator for width ↔ current ↔ rise, with the three methods side by side. |

The MCP server has the read-only tools `current_capacity_check` and `thermal_map`.

## Current capacity (IPC-2152)

### Methods

| Method | Use it for | Source |
|---|---|---|
| **IPC-2152 chart + modifiers** (default) | Sizing to the current standard. | IPC-2152 (2009) universal chart (Figure 5-1) with modifier charts for copper weight, board thickness, a copper plane and its distance, and board thermal conductivity. The curves are G. Hunter's published fits (NinjaCalc, blog.mbedded.ninja). |
| **IPC-2152 (Brooks & Adam fit)** | A closed-form alternative with separate internal and external fits. | D. Brooks and J. Adam, "Trace Currents and Temperatures Revisited" (2015), Table 3-1. These are the coefficients KiCad's calculator uses. |
| **IPC-2221 (comparison)** | Comparison with older designs. | IPC-2221B §6.2, Figure 6-4: I = k·ΔT^0.44·A^0.725, with k = 0.048 external and 0.024 internal. These are the 1956 NBS data. |

- **Board values.** The copper thickness, board thickness and whether a layer is inner or outer come from the stack-up.
- **Planes.** The nearest Plane layer, or the nearest layer with a polygon or pour, counts as the plane, at its distance through the stack.
- **Conductivity.** The default board conductivity is 0.2 W/m·K, the conservative end of the fit's range.
- **Baseline.** The chart's baseline is 3 oz copper, a 1.78 mm board, no plane and still air. Waffle applies it to internal and external conductors alike. IPC-2152 notes that external conductors in still air run cooler, so the result is conservative for them.

### Limits of the fits

The modifier fits cover:

- ½–3 oz copper;
- a 0.72–2.36 mm board;
- a plane 0.144–2.40 mm away;
- k 0.18–0.34 W/m·K.

Inputs outside these ranges are clamped, with a warning. The IPC-2152 test data go up to about 30 A and 100 °C rise.

At high currents, IPC-2221 asks for much narrower tracks than IPC-2152. For example, 10 A at 10 °C rise on 1 oz copper needs 7.2 mm by IPC-2221 and 17.6 mm on the IPC-2152 chart.

### Vias and pads

- **Vias.** A via is checked as its plated barrel, A = π·(d + t)·t, where d is the finished hole and t the plating (25 µm by default). The barrel is checked on the IPC-2152 baseline chart, or as an IPC-2221 external conductor with the IPC-2221 method. This is conservative: the copper the barrel joins cools it.
- **Pads.** A pad is checked at its narrowest cross-section, so a small pad on a wide power track (a neck) is flagged.

Each conductor is treated as **isolated in still air**. Heat from neighbouring parts and copper adds to its rise. Use the Temperature Rise Map for the board as a whole.

### The Current Capacity rule

Each Current Capacity rule has these fields:

| Field | Meaning |
|---|---|
| Scope | Which nets the rule covers: a net, a net class or a query, as for any rule. |
| Required current (A) | The current every conductor in scope must carry. 0 uses the rule file's Net currents or Class currents. |
| Allowed temperature rise (°C) | The rise each conductor may reach; default 10. |
| Method | IPC-2152 chart + modifiers, Brooks & Adam, or IPC-2221. |
| Current | **Required current**, **PDN Analyzer currents** (the current each track and via actually carries in the saved PDN setups), or the larger of the two. |
| Check via barrels / Check pads (necks) | Whether vias and pads are checked too. |
| Via plating (µm) | The barrel plating thickness. |

- **Required current.** The required current is assumed to flow through every conductor of the net, which is conservative for nets that branch.
- **PDN currents.** With PDN currents, each track and via is checked at the current it actually carries. Pads are checked only against the required current.
- **What a violation says.** A violation names the current, the rise it causes, the allowed rise and the current the conductor carries at that rise. For example: "3.00 A raises this 0.25 mm track by 130.5 °C > 10 °C; it carries 924 mA at 10 °C". The DRC lists one violation per track, at its worst segment.

## Temperature Rise Map (an estimate)

The map is a **simple steady-state model**. It shows where heat collects and how vias, planes, heatsinks and air flow change that. It is not a substitute for a thermal simulation of critical parts. Expect about ±30 % on the rise.

### Model

- **Grid.** The board outline is divided into a square grid, with cutouts removed. The pitch is the finest that keeps the grid under 250,000 nodes, and never below 0.25 mm. There is one node per cell per copper layer.
- **In-plane conduction.**
  - Copper conducts at 385 W/m·K. Its thickness comes from the stack-up, scaled by the cell's copper fraction (tracks, pads, vias, fills, polygons and stored pours of every net).
  - Half the dielectric above and below each layer adds to that.
- **Through-plane conduction.**
  - Between adjacent copper layers, heat crosses the dielectric.
  - Vias and plated holes also carry heat as copper barrels, k·π(d + t)·t/Δz, so thermal-via arrays count.
- **Materials.** FR-4 is 0.3 W/m·K through the plane and 0.8 in-plane; you can change both. Polyimide, PTFE/Rogers-type, ceramic and metal materials are recognised by name.
- **Boundaries.**
  - **Faces.** Convection plus radiation as one h per face: natural air 10 W/m²·K, forced air 25–80, or custom values.
  - **Heatsinks.** A heatsink region (top or bottom, over a selection) either adds its own h (default 1000) or holds the face at a fixed rise, like a cold plate.
  - **Edges.** Board edges are insulated, convective or held at ambient.
- **Heat sources.**
  - **Component power.** Parts take their power from the parameter **Power Dissipation**, **Pd**, **Thermal Power** or **Power** (W; "500 mW" works), or from a value typed in the panel.
    - The active variant's parameters and fitting count.
    - On passives (R, C, L, F…), "Power" reads as a rating and is ignored; use "Power Dissipation".
    - The heat enters the board under the part's pads, spread by pad area.
  - **PDN losses.** I²R losses come from the PDN Analyzer's current distribution of the saved setups.
- **Solver.** The PDN Analyzer's MIC(0)-preconditioned conjugate gradients, in a Web Worker.

### Not modelled

- Component bodies and their own convection and radiation. All of a part's heat goes into the board under its pads, so parts with big bodies or their own heatsinks read hot.
- Air heating and flow direction.
- Enclosures.
- Transients.
- Temperature-dependent resistance (no self-heating loop).
- Contact resistance and solder voids.
- Leads inside plated holes (only the plating conducts).

### Reading the map

- **Overlay.** The overlay shows the active layer, or a layer you choose. Colours run from the coolest to the hottest cell of the board, with one scale for all layers.
- **Palette.** The palette is a single orange hue whose lightness changes steadily. Low values recede into the canvas: dark to light on dark canvases, light to dark on light ones. The order reads without colour vision, and the legend and readout carry the numbers.
- **Readout.** Hovering shows the layer, the rise and the absolute temperature, both in the panel and as a small label by the pointer.
- **Hotspots.** The local maxima, each with the nearest part, go to **Messages** (group *Thermal*). Double-click one to zoom to it. Hotspots at or above 100 °C are Warnings.
- **Hidden overlay.** When the panel is closed or the map is off, the overlay costs nothing per frame.

## Validation

`tests/analysis/ipc2152.cjs` and `tests/analysis/thermal.cjs` (`scripts/test-jsc.sh ipc2152 thermal`) check the following.

| Check | Result |
|---|---|
| IPC-2152 fit against NinjaCalc's published example: 1 A, 40 °C, 1 oz, 1.6 mm board, plane at 1.6 mm, k 0.2 | area 3361 µm², modifiers 0.903 · 1.092 · 0.602 · 1.032, width 0.0588 mm: all within 0.3 % |
| Baseline (3 oz, 1.78 mm, no plane) | modifiers ≈ 1 |
| IPC-2221 external, 1 A, 10 °C, 1 oz | 11.83 mil (11.8 is the classic chart value) |
| Brooks & Adam external, 1 A, 10 °C, 1 oz | 10.92 mil |
| Width ↔ current ↔ rise round trips, all methods, inner and outer layers | 1e-6 |
| Modifier directions (plane, closer plane, thicker board, higher k, 2 oz) | correct |
| Uniformly heated plate with convection: ΔT = P/((h_top + h_bottom)·A) | error below 1e-6 % |
| Two layers through 1.5 mm FR-4, heat on top only (closed form) | error below 1e-6 % |
| 1D convecting fin, held base, insulated tip: θ = θb·cosh(m(L−x))/cosh(mL) | worst point within 0.005 % of θb |
| Thermal-via array (16 vias) under a 1.5 W part to a bottom plane | peak rise 208 → 94 °C, and the bottom layer gets hotter |
| Cold plate, forced air | both lower the peak |
| PDN I²R | total equals the PDN Analyzer's power |
| Current Capacity rule, negative and positive | a 0.25 mm track fails 3 A at 10 °C and 2.5 mm passes; 0.6 mm pads and a 0.3 mm via fail and a 1 mm via passes; scopes; Net currents; with PDN currents only the branch that carries 3 A fails |

## Speed

| Case | Where | Time |
|---|---|---|
| 100 × 160 mm, four layers, 251 k nodes, 192 CG iterations | Chrome Web Worker | about 1.2 s round trip warm (1.7 s for the first run, including worker start-up); the UI frame gap stays at 20 ms |
| same | JavaScriptCore | 0.67 s |
| A real board (the 48–17 V buck converter, four layers), 117 k nodes | Chrome | 0.48 s |

The conjugate-gradient loop accounts for about 95% of the measured solve time. It runs in JavaScript. [Thermal solver](../app/analysis/thermal.js)
