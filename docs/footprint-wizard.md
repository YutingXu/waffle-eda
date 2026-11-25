# Footprint wizard

The footprint wizard makes IPC-7351B land patterns. It works like Altium's IPC Compliant Footprint
Wizard: you choose a package family, start from a preset or type the package dimensions from the
datasheet, choose a density level, and get a footprint with the following:

- pads;
- the IPC name;
- a courtyard;
- an assembly outline and height for the 3D body;
- exposed-pad lands kept 0.20 mm from the pad (change it with `epClearance`);
- silkscreen with a pin-1 or polarity mark;
- paste and mask settings.

Open it with **Design › Library › IPC Footprint Wizard…**, from the library panel, or with
**T F**.

## Choosing a package

The **Family** box is a search field. Type part of a package or family name, such as `soic-16`,
`to-220`, `0603`, `qfn`, `plcc` or `mounting`. The list shows:

- families, grouped by **Surface mount**, **Through-hole** and **Mechanical**;
- the presets whose names match what you typed.

To pick an entry, use **↑ ↓** and **Enter**, or click it. **Esc** closes the list.

The preview on the right updates as you type. It shows the Z (toe) and G (heel) dimensions, and
the summary under it lists:

- the land size and position;
- the IPC goals used;
- the hole and land sizes;
- the exposed-pad paste windows and thermal vias;
- the courtyard and height;
- the source of the package dimensions;
- any footprint check that fails.

A line marked **⚑** is an assumption you should check against your part's datasheet. For example,
a dimension that has not been checked against the JEDEC drawing, or a land that the wizard made
smaller so it fits.

### Families

| Group | Families |
| --- | --- |
| Surface mount | Chip R/C/L 0201–2512 · chip arrays (RESCAV/CAPCAV) · MELF · SOD, SOD flat lead (SOD-123F, SOD-323F, SOD-128) · SOT-23/-5/-6/-8, TSOT, SC-70 (SOT-323/353/363), SOT-143/343, SOT-89, SOT-223, SOT flat lead (SOT-563, SOT-666, SOT-23F) · DPAK/D2PAK/D3PAK with tab (TO-252/263/268, 2 to 7 leads) · SOIC, SSOP, QSOP, TSSOP, MSOP/VSSOP, TSOP I and II, with exposed-pad variants · QFP (LQFP, TQFP, PQFP including 14×20, BQFP, CQFP, HTQFP with exposed pad) · PLCC and SOJ (J-lead) · LCC/LCCC · QFN/DFN/SON, PQFN/PSON (pull-back), QFN dual row, LGA perimeter · BGA (full, depopulated, staggered, custom ball map), CSP/WLCSP · LGA grid · molded body (tantalum A–E and T, SMA/SMB/SMC) · aluminium electrolytic SMD cans (CAPAE, 4 to 18 mm) · power and wire-wound inductors · SMD crystals and oscillators (2 and 4 pad) · SMD LEDs (PLCC-2, PLCC-4, 5050) · SMD tactile switches · SMD buzzers · test pads · castellated modules (host lands or the module's own half-hole edge) · SMD headers |
| Through-hole | Axial (DIN 0204–0617 resistors, DO-35/41/15/201AD, lying or standing) · radial (electrolytic cans, ceramic discs, film boxes, round LEDs) · TO-92 · TO-220, TO-247, TO-126 (standing or laid flat, with the mounting hole) · metal cans (TO-18, TO-39, TO-5 8 and 10 lead, TO-3) · SIP · DIP and wide DIP · PGA/SPGA · pin headers, sockets, IDC box headers, wire-to-board, terminal blocks · HC-49/U and HC-49/S crystals · fuse holders (5×20, TR5) · relays, transformers and any part by pin grid |
| Mechanical | Mounting holes (M2–M6, unplated, plated, plated with a via ring) · fiducials · card-edge fingers · net ties |

Headers, sockets, IDC, terminal blocks and card-edge fingers use the same generator as **Place ›
Generic Part › Connector / Header…**. The wizard loads it the first time you pick one of these
families.

## Density levels

The **A · Most**, **B · Nominal** and **C · Least** buttons are IPC-7351B's density levels. They
set the toe, heel and side solder-fillet goals and the courtyard excess, and add the suffix `M`,
`N` or `L` to the name (for example `SOIC127P600X175-8N`).

| Level | Use it for | Courtyard excess |
| --- | --- | --- |
| A · Most | Wave soldering, hand rework, low-density boards | 0.50 mm |
| B · Nominal | Typical reflow (the default) | 0.25 mm |
| C · Least | High-density boards | 0.10 mm |

Through-hole parts use the same levels for the hole allowance and the annular ring.

## Round-off

The **Round** list next to the density buttons sets the grid that the land dimensions Z, G and X
are rounded to. Use it to match your house style or another tool's library.

| Choice | Grid | Use it to |
| --- | --- | --- |
| Round 0.05 (IPC) | 0.05 mm, halves up | Follow the IPC-7351B convention (the default) |
| Round 0.025 | 0.025 mm | Match a house style |
| Round 0.01 | 0.01 mm | Keep the calculated values almost unrounded |
| Round as KiCad | 0.05 mm (0.02 for chips smaller than 0603), halves to even | Match KiCad's generator |

With **Round as KiCad** and the same package dimensions, the wizard gives the same lands as KiCad's
IPC-generated footprints. The test suite checks this to 0.01 mm on 33 KiCad footprints. The
footprint keeps the choice, and the wizard remembers it for the next time you open it.

## Dimensions

Type the dimensions as min, nom and max. Changing nom moves min and max with it. **↑** and **↓**
step a field by 0.01 mm, or 0.1 mm with **Shift**. Units are millimetres, and `mil` or `in`
are converted.

When you change a dimension, the preset changes to **Custom**. Under **Tolerances and outputs**
you can set:

- the fabrication tolerance (F, default 0.10 mm);
- the placement tolerance (P, default 0.05 mm);
- the pad shape;
- whether to also create a schematic symbol.

Some fields take text:

- **Depopulate** (BGA, LGA, PGA): `A1, C3-C5` or `center:4`.
- **Ball map**: one line per row, `X` for a ball and `.` for none.
- **Pins** (pin grid): `1 0 0; 2 5.08 0; …` in mm.
- **Terminals** (crystals, LEDs, buzzers): `number x y length width [x|y|none]`.
- **Pads per side** (castellated modules): `14, 10, 14`.

## What every footprint gets

- **Lands** from the IPC-7351B equations:
  - Zmax = Lmin + 2·JT + √(CL² + F² + P²)
  - Gmin = Smax − 2·JH − √(CS² + F² + P²)
  - Xmax = Wmin + 2·JS + √(CW² + F² + P²)

  Lands are rounded to 0.05 mm. They are never wider than the pitch minus 0.10 mm, and at the
  corners of quad packages they stay 0.15 mm from the next side's lands.
- **Through-hole lands:** the hole is the lead (or its diagonal) plus the density allowance. The
  annular ring is at least 0.20 mm, which is above JLCPCB's 0.18 mm minimum, even on 1.27 mm
  headers.
- **Exposed pads** have:
  - paste reduced to 60 % in a grid of windows (change the coverage, or set `pasteWindows`);
  - an optional array of thermal vias (0.30 mm drill, 0.70 mm land), kept inside the pad.
- **Courtyard** on Mechanical 15, around the pads and the body, rounded out to 0.05 mm.
- **Assembly outline** on Mechanical 13, with the height. The 3D view and STEP export build the
  body from it; round outlines become cylinders.
- **Silkscreen** at 0.18 mm, kept 0.2 mm from every pad, with a pin-1 dot or polarity mark.
- **Mask and paste:**
  - BGAs get 0.05 mm of solder mask expansion, reduced at fine pitch so a 0.1 mm mask web
    remains.
  - Fiducials get a mask opening 2–3 × the dot and no paste.
  - Test pads and net ties get no paste.

Every preset is DFM-clean on the JLCPCB 2-layer preset (Tools › DFM Check) and passes the
library footprint checks.

## Batch generation

**Batch…** in the wizard takes CSV or TSV text: one footprint per line, under a header row.

```csv
family,preset,density,pins,pitch,L
sop,SOIC-16,B
qfn,QFN-20 4×4 0.5,C
gullwing,,B,24,0.65,6.2..6.6
chip,0805,A
```

- **Columns** are `family`, `preset`, `density`, `name`, `roundOff` (0.05, 0.025, 0.01 or `kicad`), and then any dimension key: `L`, `W`,
  `T`, `D`, `E`, `H`, `pins`, `pitch`, `EP.D`, `thermalVias.drill`, and so on.
- **Ranges** are written `5.8..6.2`, or `6±0.2`. An empty cell keeps the preset's value.
- **Comments:** lines that start with `#` are skipped.

**Generate** lists every row with its footprint name or the reason it failed. **Add all to
library** adds the good rows.

## From an AI assistant (MCP)

| Tool | What it does |
| --- | --- |
| `footprint_wizard` | Read-only: `list`, `describe`, `generate` and `batch`, with `round_off`. It never changes the project. |
| `create_footprint` | Takes any family with `preset`, `density` and `dims`, or a `batch` CSV. The result is a proposal unless writing is allowed. |

See [mcp-and-cli.md](mcp-and-cli.md).

## Limits

- **Dimensions to check:** JEDEC documents need a login. Common presets were checked against
  makers' public outline drawings that cite the JEDEC outline, such as NXP's SOIC, TSSOP, LQFP,
  HVQFN and PLCC drawings. Each preset names its source; values that no public drawing confirmed
  are marked ⚑. Before you
  order, check exposed-pad sizes, SOT-89/DPAK tab sizes, tactile switches, buzzers, relays and
  transformers.
- **Recalled goal tables:** most IPC-7351B goal tables were checked against the tables KiCad
  publishes. A few were taken from memory and are marked ⚑:
  - chip array;
  - bottom-only terminations;
  - MELF and BGA;
  - through-hole allowances.
- **Example layouts:** the relay, transformer, castellated-module, dual-row QFN and buzzer presets
  are example layouts. Enter the real pin positions from your part's datasheet.
- **M6 mounting holes** use a 6.3 mm drill, the largest on the JLCPCB presets, instead of ISO
  273's 6.4 mm.
- **Castellated half-holes** are a separate fab option. On JLCPCB the holes must be 0.5 mm or
  larger and at least 1 mm from the board edge.
