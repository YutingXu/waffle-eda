# SPICE models for parts that have none

Original design, 20 November 2026. The first implementation included the
ladder, provenance and coverage report; B sources; the opamp, comparator, ldo, diode, zener, led,
bjt, mosfet, capacitor, inductor, ferrite, crystal, logic, load, switch and ideal templates with
bench checks; the model wizard (no datasheet assist); placeholders by `pin.fn`. Assignments are kept
in the extension's storage until the host grants `propose:edits`; no `ui.decorations` yet.

Most parts in a real design have no SPICE model. Vendors do not publish one, they publish it
encrypted for their own simulator, or the model's licence forbids sharing it. Simulation is useful
only if Waffle still simulates the circuit and is honest about how well. This document proposes a
model ladder: primitives, then generic behavioural models fitted from datasheet values, then
imported vendor models. It also covers a model wizard, pin mapping, a coverage report,
simulate-a-selection, a second engine (ngspice in WebAssembly) and the checks that use the results.

## 1. Decisions in brief

- **Every part gets a model rung.** The rungs are Vendor, Fitted, Generic, Ideal, Load-only,
  Excluded or Missing. The coverage report shows each part's rung. Nothing is silently left out
  of the netlist, as it is today.
- **Generic behavioural models are the backbone, not a fallback.** They are templates in code with
  versions. They turn a few datasheet fields into a subcircuit. They run in both engines.
- **Every model value records where it came from:** datasheet (with page and a quote), user,
  derived, Waffle default, or AI (not verified). A model never presents a default as a datasheet
  value. Waffle never invents part numbers or vendor parameters.
- **Vendor model files are user data.** They are never bundled. They are stored by SHA-256, parsed
  only inside the sandbox, and their `.control` blocks, file includes and code models are never
  run. Encrypted models are detected and refused, with a one-click generic replacement.
- **Two engines:**
  - **Quick** is today's clean-room `AtriumSpice`, extended. It is instant and handles live
    operating points and generic models.
  - **Full** is ngspice compiled to WebAssembly. It loads lazily inside the same extension worker
    and handles vendor models and the remaining dialect features.
  The engine is picked per run, by capability.
- **Placeholders simulate as soon as they are placed.** A placeholder op-amp or regulator carries
  the generic model's fields. When it becomes a real part, the vendor model wins if there is one.
  Otherwise the generic model is kept and marked "from placeholder, not checked against
  <part>".
- **Results feed the single check engine.** OP-derived checks become Design Insights and merge
  with the existing Component Stress check. Examples are LDO dissipation, op-amp headroom and
  MOSFET gate drive. They never trigger a simulation themselves.

## 2. What exists today

| Piece | Where | State |
|---|---|---|
| Solver | `extensions/spice/spice.js` (675 lines) | Clean-room MNA: R C L V I, E/F/G/H, diode (Shockley + RS, CJO, BV), BJT (Ebers–Moll + VAF), MOSFET level 1, `X` subcircuits. Analyses: `.op`, `.dc`, `.ac`, `.tran` (trapezoidal/BE, LTE step control). Dense LU. Limits: 4000 unknowns, 200k elements, 2e7 samples. Missing: no `B` sources, `S`/`W` switches, `K` coupling, `T` lines, `.step`, `.noise`, `.meas`, expressions beyond `{param}`. `.include`/`.lib` are ignored with a warning. |
| Netlister | `extensions/spice/export.js` | Reads part and def parameters: `Spice`, `Spice.Prefix`, `Spice.Pins`, `Spice.Lib`, `Spice.Exclude`, source fields. Aliases accept KiCad-style `Sim.*` names. Templates use `%1`, `%{pin}` and `%ref`. Pin roles are matched by name for D/Q/M/op-amp. The assembly variant is honoured. A table of "generic built-in models: rounded typical values" is keyed by real part numbers (1N4148, 2N3904, BSS138 …), plus a single-pole `OPAMP` subckt. Parts without a model are skipped and noted as `* omitted` comments. |
| Extension | `extensions/spice/main.js`, `manifest.json` | Built-in and enabled by default. Dedicated worker, 120 s timeout. Permissions: `read:project`, `outputs:write`, `ui:panel`, `ui:command`. It **cannot store anything in the design** today. The panel has analyses, net probes, a plot with cursors and zoom, netlist and CSV export, and op values indexed by wire. |
| Menu | `app/sim-menu.js` | Design › Simulate (Mixed Sim, OP/DC/AC/Tran). Calls only the public commands. |
| CLI/tests | `cli.js`, `tests/analysis/spice.cjs`, `tests/analysis/spice-limits.cjs` | Analytic checks per device, the netlister, the extension in a realm host, and fan-out limits |
| SI overlap | `extensions/si/` (`ibis.js`, `solver.js`) | IBIS 1.1–7.x reader and behavioural buffer. Models live in `project.simulation.models` (`kind: "ibis"`) and assignments in `project.simulation.assign`, both written only through reviewed proposals. Read with `api.simulation.get/model`. |
| Stress | `app/stress.js`, MCP `stress_check` | Derating. It already takes a SPICE `.op` via `spice.simulate` |
| Library | `component-families.js`, `generic-parts.js`, `starter-library.js`, [Library management](library-management.md) | Families group parts into family → chip (`member.part`) → package (one def each). Generic parts carry value, tolerance, voltage and dielectric. Library records get `source` provenance and `state` (draft/released). |
| Importers | `app/sch-import.js` | Altium implementations are read, but only `PCBLIB` is used. **SIM implementations are dropped.** |
| Sandbox | `app/extensions.js`, `docs/extension-api.md` | Worker in a CSP `default-src 'none'` iframe, with `wasm-unsafe-eval` allowed. `api.assets.read()` loads `.wasm` from the package (32 MB package cap). `api.transfer` moves buffers. `files.pickText` is available. Dedicated workers get up to 10 min. Storage is 256 KB per value. There is no overlay or decoration API for extensions. |

A cross-check
harness against a native ngspice already exists for SI (`tests/analysis/si-ngspice.py`).

**One correction is needed now.** The `MODELS` table in `export.js` attaches approximate values to
real part numbers. That reads as "the 1N4148 model". It must be relabelled **Generic (Waffle
approximation)**, with its provenance shown. The values should then be refitted from public
datasheet numbers through the same fitting code as the wizard (§5), so that each one can say which
datasheet values it reproduces.

## 3. The model ladder

For each placed part, the netlister picks the highest rung that is available and valid:

| Rung | Label in UI | Example | What it is good for |
|---|---|---|---|
| 1 | **Vendor** | TI PSpice subckt for OPA333, hash-pinned | Whatever the vendor modelled. Fidelity is the vendor's. Waffle does not edit it. |
| 2 | **Fitted** | Generic op-amp, every required field from the datasheet, bench check passed | Bias, gain/bandwidth, slew, rails, Iq. Not distortion, temperature drift or EMI. |
| 3 | **Generic** | The same template with some fields at Waffle defaults | Topology and rough levels. The defaults are listed. |
| 4 | **Ideal** | Ideal op-amp, ideal diode, ideal switch | Is the idea right? Gains and polarities. |
| 5 | **Load-only** | MCU, RAM, FPGA bank: Iq per rail plus pin capacitances | Rail loading, LDO dissipation, start-up |
| — | **Primitive** | R, C, L, sources, with value, tolerance, ESR/ESL from parameters | Passives are rung 2 when their parasitics come from data, rung 3 when ideal. |
| — | **Excluded** | Connector, test point, mounting hole, logo | Excluded with a reason. A connector can instead be a boundary port (§9). |
| — | **Missing** | No rung applies, or a vendor file is absent from this machine | Blocks the run, or the user chooses "use generic" for it |

The rule for choosing a rung is **explicit beats inferred, and vendor beats generic**. The order is:

1. The placed part's `sim` override.
2. Legacy `Spice*` parameters on the part.
3. The component's `sim`.
4. Legacy `Spice*` parameters on the def.
5. The chip-level family default.
6. The family-level template.
7. Category inference, from the prefix, the symbol pin names and the generic-part family.

Existing designs keep producing exactly the netlist they produce today. The legacy parameters stay
supported for good. They are also the import target for Altium and KiCad.

## 4. Generic behavioural models

Templates are pure functions: `template(params) → {subckt, ports, provenance, assumptions}`. Each
has a stable id and version, such as `opamp@1`. Every template uses only a **portable subset**:
R C L, E/F/G/H, D, S/W, and `B` with the safe expression grammar of §10. As a result each template
runs in both engines and can be checked against ngspice in CI.

| Template | Required fields | Optional fields (default shown as assumption) | Topology | Not modelled |
|---|---|---|---|---|
| `opamp` | GBW, rail type (RRIO / RRO / neither), supply range | Aol (100 dB), SR (from GBW: 0.5 V/µs per MHz, flagged), Vos, Ib, Ios, CMRR, PSRR, Iq, Isc, Rout (50 Ω), en/in, phase margin (60°), output swing to rails, input CM range | Rin/Cin with Vos and Ib sources. A G stage with a current limit sets the slew rate (`I = limit(gm·v, ±SR·C)`). The dominant pole comes from Aol/GBW, an optional second pole from the phase margin. Output Rout, then diode clamps to rail-minus-swing. Iq between the supply pins. | THD, input-stage nonlinearity, temperature drift, overload recovery, EMI rectification |
| `comparator` | Threshold behaviour, output type (push-pull/open-drain), tpd | Hysteresis, input offset, tr/tf, VOL at IOL, Iq | High-gain tanh B-source, a hysteresis feedback term, a delay RC stage and an output stage | Metastability, overdrive-dependent delay (single tpd) |
| `ldo` | Vout (or Vref plus divider), dropout at Iload | Iq/Ignd(I), current limit, PSRR at one or two frequencies, loop bandwidth (100 kHz, flagged), Cout ESR range, enable threshold | `Vout = min(Vset, Vin − Rdo·I)`. Ground current, foldback limit, and a first-order loop that gives PSRR(f) and a load step. | Stability with real Cout ESR (labelled "load-step shape only"), noise density unless en is given, thermal shutdown |
| `buck`/`boost` (averaged) | Vout, fsw, L, Iout max | Efficiency at 2–3 load points, soft-start time, UVLO | A state-space averaged switch with an efficiency-derived loss. Start-up and load-step envelope. | **Ripple and switching edges** (stated on every plot). A cycle-by-cycle switching model is a later template. |
| `vref`/`shunt` (TL431-style) | Vref, Ika min | Zka, accuracy | Error amp plus a shunt element | Stability region |
| `diode` | Vf at If (one point) | A second Vf/If point (otherwise N=1.8 for Si and 1.05 for Schottky, flagged), Cj, trr, BV/IR | IS and N fitted from two points, RS from the high-current point, TT from trr | Temperature beyond the default TNOM |
| `zener` | Vz at Izt | Zzt, Izk, Zzk | BV, IBV and RS fitted | Noise |
| `led` | Vf at If, colour | A second point, max If | IS/N/RS fitted (colour gives a typical N, flagged) | Optical output (a "brightness" probe is ∝ I only) |
| `bjt` | Polarity, hFE at Ic | Vce(sat), fT, Cob, VAF (100 V) | A Gummel-Poon subset (Quick engine: Ebers–Moll + VAF) | Quasi-saturation, high injection |
| `mosfet` | Polarity, Vth (at Id), Rds(on) at Vgs (and Tj) | Ciss/Coss/Crss at Vds, Qg, body diode Vf/trr, BVdss | Full engine: VDMOS (Rd, Cgdmax/min, Cjo, body diode). Quick: level 1 with `KP = 1/(Rds(on)·(Vgs−Vth'))`, where Vth' is corrected from the datasheet's 250 µA definition. | Avalanche, the thermal Rds(on) coefficient (unless given), the gate plateau shape on level 1 |
| `logic` (gate/buffer, family preset) | Supply, function (AND/OR/NOT/buffer/tri-state), family thresholds | tpd, tr/tf, VOL/VOH at IOL/IOH, Cin, Iq | Smooth B-source threshold, a delay line, a slew-limited output and a Thevenin output impedance. An **IBIS model replaces the output stage** when one is assigned (shared `ibis.js`). | Timing violations, metastability |
| `crystal` | f, CL, ESR | C0 (3 pF, flagged), C1 (from pullability, else 5 fF, flagged) | Butterworth–Van Dyke: L1 = 1/((2πf)²·C1) | Start-up takes millions of cycles. The bench warns and suggests an AC impedance plot instead. |
| `ferrite` | Z at 100 MHz | Rdc, 2–5 points of the Z(f) curve, rated current | Rdc + (L ∥ R ∥ C), fitted to the curve points by least squares. One point gives a three-element default shape, flagged. | **DC-bias loss of impedance** unless a curve at bias is entered |
| `capacitor` | Value | ESR, ESL (from case size, flagged), dielectric, rated V, DC-bias curve | C with series ESR/ESL. MLCC DC-bias: C(V) from entered points, else a **class-generic** X5R/X7R curve labelled "estimate, not vendor data", scaled by rated voltage and case | Ageing, temperature (unless TC is given) |
| `inductor` | Value | DCR, SRF (gives Cpar), Isat (soft saturation via flux B-source) | | Core loss |
| `transformer` | Turns ratio, Lp | k (0.99), DCR, leakage | Coupled L via `K` | Core saturation unless Isat is given |
| `switch`/`relay` | Ron, Roff, threshold | Hysteresis, coil R/L, operate time | S/W element with a `.model SW` | Contact bounce |
| `load` (MCU/RAM/FPGA/sensor) | Iq per supply pin group | Pin Cin, a supply current profile (PWL) | Current sinks and caps per rail | Any logic behaviour |

**Templates are versioned and pinned.** A component stores `template: "opamp@1"`. A new template
version is offered as an ordinary library update, shown as a netlist diff. It is never applied
silently, which follows the rule that upgrades never break data. A bench re-run with old and new
templates can be overlaid as a compare (§11).

## 5. Provenance, confidence and the model wizard

### Per-value provenance

```jsonc
"params": {
  "GBW":  {"v": "350k",  "src": "datasheet", "doc": "opa333.pdf#rev-D", "page": 5, "quote": "Gain-bandwidth product 350 kHz"},
  "SR":   {"v": "0.16",  "src": "datasheet", "page": 5},
  "Rout": {"v": "50",    "src": "default",   "note": "Waffle default for CMOS RRO"},
  "Vos":  {"v": "2u",    "src": "user"},
  "Iq":   {"v": "17u",   "src": "ai",        "quote": "Quiescent current 17 µA", "page": 1}   // unverified until confirmed
}
```

Rules:

- **The rung follows from provenance.**
  - Rung 2 (Fitted) means every required field is `datasheet` or `user`, and the bench check
    passed.
  - If any required field is `default` or unconfirmed `ai`, the model is rung 3 (Generic).
  - A field the user confirms changes from `ai` to `datasheet`.
- **Defaults are visible everywhere.** The coverage report, Properties and the netlist comments
  (`* Rout = 50 (Waffle default)`) all show them.
- **No invention.** The MCP tools and the AI assistant must supply `src` and `quote` for any value
  they propose. A value without them is stored as `ai` and lowers the rung. Waffle never fills in
  a manufacturer or MPN.

### The wizard

The wizard is reached from **Design › Simulate › Model Wizard…**, the coverage report's "Use
generic…", the Properties "Simulation" row, and the library editor. It works like the symbol and
footprint wizards:

1. **Category.** It is preselected from the family, prefix and pin names (`IN+ IN− OUT V+ V−` →
   op-amp, `VIN VOUT GND EN` → LDO).
2. **Fields.** These are the template's required fields, then an "Optional" fold. Each field shows
   a provenance chip and a page box. Values accept engineering notation and units.
3. **Datasheet assist (optional).** Paste datasheet text or open a PDF. The same parser that is
   being built for "Symbol Wizard from datasheet pin tables" finds the electrical-characteristics
   table. The ai-assistant extension may propose values. Each proposal shows its quoted line and
   is unconfirmed until the user ticks it. In one session, one datasheet can fill the pins
   (symbol wizard), the package (footprint wizard) and the model.
4. **Bench preview.** The template's characteristic benches run in the Quick engine, in under
   100 ms:
   - op-amp: open-loop Bode, 1 V step at unity gain, output swing into 10 kΩ
   - LDO: dropout curve and load step
   - diode: I–V on a log axis
   - MOSFET: Id–Vds family and Rds(on) at Vgs
   - ferrite: |Z|(f)
   The entered datasheet points are drawn as markers. The bench check passes when the measured
   GBW, SR, dropout, Vf and so on are within tolerance of the entered values: 5 % by default, or
   1 % for fitted junctions.
5. **Pins** (§7), then **Save** to the component, chip or family through a proposal.

## 6. Placeholders, then real parts

The library design ([Library management](library-management.md)) is adding placeholder components with
dynamic symbols, such as "Op-amp", "LDO", "RAM", "Logic gate", "N-MOSFET", R/C/L. They let you
sketch a schematic before choosing parts. Placeholders simulate out of the box:

- **Each placeholder kind maps to a template** (op-amp → `opamp`, RAM → `load`, gate → `logic`).
  The placeholder's own parameters are the template's fields. A placed placeholder op-amp shows
  `GBW 1 MHz, RRIO, 5 V` in Properties, and editing it is editing the model. The rung is Generic,
  or Fitted only if the user entered every required field as `user`. Sketch intent is a valid
  `user` source.
- **Resolve to a real part** (Bind to Manufacturer Part / Replace with component) keeps the
  binding through these steps:
  1. **If the real component has a Vendor or Fitted model, it wins.** The placeholder's fields are
     compared with it. A difference that matters becomes a note, for example "You sketched
     GBW 1 MHz; OPA333 has 350 kHz". The note links to a bench overlay of both.
  2. **If it has none, the generic model is carried over.** Its fields are marked
     `src: "placeholder"`, and the part shows the badge **Generic (from placeholder, not checked
     against OPA333)**. The coverage report lists these parts as "needs model review". One click
     opens the wizard with the fields prefilled, against the new part's datasheet.
  3. **The pin mapping moves by pin name.** Placeholder pins use canonical role names (`IN+`,
     `VIN`, `EN`). A real part whose pins do not match by name opens the pin mapper (§7).
- **The record keeps the history.** `sim.origin = {placeholder: "opamp", params: {...}}` stays on
  the placed part, so "compare with sketch" remains possible after the part is resolved.

## 7. Pin mapping and family defaults

Subcircuit ports rarely match symbol pins. Waffle maps them in four steps:

1. **By name** after normalising case, `−`/`–`, overbars and `n`/`#`/`_B` prefixes and suffixes.
   Synonym sets cover IN+/+IN/INP/NONINV, V+/VCC/VDD/VS+, OUT/VOUT/O and so on. This extends
   `ROLE_NAMES` in `export.js`.
2. **By the vendor's pin comment.** PSpice and LTspice model files often state the port order in
   comments (`* connections: non-inverting input | inverting input | ...`). The parser reads
   these lines as hints, never as code.
3. **By pin number**, when the port names are numbers and the symbol pin numbers match.
4. **The visual mapper.** Two columns, the symbol preview on the left and the port list on the
   right. You draw lines, or press a key to assign the next unmapped port. Unmapped symbol pins
   default to *not connected*. The other options are *tie to pin …* (EN → VIN, exposed pad → GND)
   or *load* (a resistor to a node). Unmapped ports are an error.

Where mappings are stored:

| Level | What is stored | Why |
|---|---|---|
| Family | Template id and default fields (for example, every op-amp in a family is RRIO CMOS) | Configure once per family |
| Chip (`member.part`) | The model (vendor ref or template + fields) and the mapping **by pin name** | The electrical model is shared by every package of the chip |
| Package (component) | Only exceptions: a pin-name mapping that fails, or package parasitics | Under the "one component = one package" rule, packages with the same pin names inherit for free |
| Placed part | Rare overrides: model corner, Monte Carlo off, "treat as ideal" | Per instance |

**Multi-unit parts.** A dual op-amp maps each unit to one instance of a single-channel subckt.
Shared power pins are wired to every instance. A vendor dual model, with one subckt for both
channels, maps once per part. Mapping by unit is the default because most vendor files are
single-channel.

## 8. Vendor model import

### Flow

Use **Import SPICE Model…** (it uses `files.pickText`) or drag a `.lib`/`.mod`/`.sub`/`.cir`/`.ckt`
file onto the wizard. Then:

1. The file is hashed and parsed **in the extension worker**.
2. The import report lists the subckts and `.model`s found, the dialect detected, every rewrite
   applied, every unsupported construct, encrypted sections, and size and complexity.
3. The user picks the subckt for this part, maps the pins (§7), and chooses where the text lives
   (§9).

### Dialect normaliser

There is one lexer, an AST, and per-dialect rewrite rules. Each rewrite is logged on the model, for
example "E1: PSpice `VALUE={…}` → B-source". The normaliser targets the canonical deck that the
engines accept.

| Dialect | Common constructs and what we do |
|---|---|
| PSpice | `PARAMS:` on `.subckt` and `X` lines. `{expr}`. `VALUE=`, `TABLE`, `LAPLACE`, `FREQ` on E/G. `POLY(n)`. `IF()`, `LIMIT()`, `.FUNC`. `S`/`W` with `VSWITCH`/`ISWITCH`. `.LIB` sections. These map to B-sources and switches. `LAPLACE`/`FREQ` go to the Full engine; ngspice supports some forms in its PSpice compatibility mode, to be verified per construct. |
| LTspice | B-sources with `V=`/`I=`, `table()`, `uplim/dnlim`. `Rser`/`Cpar`/`Lser` on C, L and V become explicit elements. The ideal diode (`Ron Roff Vfwd Vrev`) becomes a smooth switch-diode. `VDMOS` goes to the Full engine. `A`-devices (digital primitives) are **unsupported**: we offer the `logic` template. `.machine` is unsupported. |
| HSPICE | Parameters without `PARAMS:`. `$` comments. `.lib 'file' section`. `.protect/.unprotect` are stripped as markers. `M=` multipliers. `.option` and `.global`. |
| ngspice/KiCad | Native |
| Altium | Altium model files (`.mdl` for `.model`, `.ckt` for subckt) are SPICE text. The pin mapping lives in the library implementation (§13). |

The normaliser decides the **engine**. If every element is in the Quick engine's set, the Quick
engine runs it. Otherwise the deck is marked "Full engine". ngspice's own compatibility modes
(`ngbehavior=ps`, `lt`, `hs`) are used as a second line of defence in the Full engine. They do not
replace the normaliser, because we need the rewrite log and the Quick path.

### Encrypted models

These are detected and refused, with a clear message:
- PSpice `$CDNENCSTART` blocks
- LTspice and ADI encrypted subckts
- HSPICE `metaencrypt` sections
- binary content

The message reads: "This model is encrypted for <tool> and can only run there. Use a generic
model?" The button opens the wizard prefilled from the component's parameters. Waffle never tries
to decrypt.

### Treated as untrusted

- **No code execution.** `.control … .endc` blocks are stripped and reported. So are `.include`
  and `.lib` paths, which are resolved **only** to other imported model files by name and hash,
  never to the file system. The same applies to `shell`, `source`, `codemodel`, `pre_osdi` and
  `.osdi`. Expressions use Waffle's own parser and evaluator, never `eval`/`new Function`, even
  though the sandbox CSP allows `unsafe-eval`.
- **Limits.** 4 MB per file. 64 models per project (today's `SIM_LIMITS.models`). Nesting depth 10
  and the existing fan-out cap. 10k cards per subckt. An expression depth and length budget. A
  parse time budget of 2 s, after which the file is rejected.
- **The ngspice runtime is shut in.** It runs MEMFS only (no NODEFS or IDBFS), with no network,
  in the same worker, under the same watchdog. The netlist is handed over as a string.
  `.control` is generated by Waffle only from a fixed set of commands.
- **Text scrubbing.** Model names and comments shown in the UI go through the existing
  `untrusted_design_text` path.

## 9. Licensing and storage

Vendor models often forbid redistribution, or allow use only "with <vendor> products". Waffle's
answer:

- **Never bundled, never downloaded from a vendor automatically.** The repo and app ship only
  templates (code, MIT) and Waffle-authored generic fits. Each fit cites the public datasheet
  numbers it used, so it holds no vendor data beyond what a datasheet states.
- **Three stores:**
  1. **User model store** (the default). App data dir: `~/Library/Application Support/Waffle/models/`
     on macOS, or the XDG data dir on Linux. Files are named by SHA-256 and are read-only.
  2. **Project-embedded**, in `project.simulation.models` with `kind: "spice"`. This needs a
     per-model acknowledgement: "I may share this model with everyone who receives this project."
  3. **External folder index.** An example is "Use models from my LTspice installation". It
     indexes locally and read-only, and copies nothing.
  A project always references models by name + SHA-256.
- **A missing model on another machine** shows as Missing (`sha …`). The fix is: import your copy
  of `<file name>`, or use generic. The fixed design never changes on its own.
- **Downloads, if ever:** the allowlist by SPDX licence from `library-management.md` §7 (CC0, BY,
  MIT, BSD, Apache). Quarantine in app data. Parsed in the sandbox under `network:<host>`
  permission, off until allowed. A future community catalogue of *generic fits* fits here.
- **git hygiene.** A pre-save health check warns when an embedded model's acknowledgement is
  missing or its licence field says "no redistribution".

## 10. Engines

### Quick: `AtriumSpice`, extended

The Quick engine stays the default. It is 43 KB, starts instantly, and is already tested,
sandboxed and DOM-free. Additions:

- **New elements:** `S`/`W` switches (smoothed), `K` coupling, `T` lines (reusing the Bergeron line
  in `extensions/si/solver.js`).
- **B-sources** with a safe expression grammar: `+ − * / ^`, `abs min max limit exp ln sqrt tanh
  atan`, `if`/ternary, `uramp`, `table`, `V()`, `I()`, `time`, `temp`. Derivatives are computed
  automatically for Newton. Functions are smooth wherever possible, to help convergence.
- **Expressions:** `.param` expressions, `.func`, `.step param`, `.temp`, `.meas`, `.noise`.
- **A sparse LU,** later. A JS version comes first. Per the language decision, it becomes a Rust/WASM
  kernel if profiling says so. This lifts the 4000-unknown dense limit.

### Full: ngspice compiled to WebAssembly

- **Build.** Emscripten, from a pinned ngspice release tag, through a reproducible
  `scripts/build-ngspice-wasm.sh`. We do not take a third-party prebuilt binary. Shared library
  mode: in-memory netlist in, vectors out.
- **Packaging.** A `.wasm` asset in the SPICE extension package, read with `api.assets.read` and
  instantiated in the existing dedicated worker. It loads lazily on first Full run. Expected size
  is a few MB (to measure; the package cap is 32 MB). Eager JS is unaffected.

**Licence.** I checked ngspice's `COPYING` on master, 2026-11-20. **Verify it again against the
exact tag we build.**

| Part | Licence | Our build |
|---|---|---|
| Core | Modified BSD (3-clause) | Include |
| `maths/sparse` | MIT-style | Include (use it, not KLU) |
| `maths/KLU` | LGPLv2 | **Exclude** (build without KLU) |
| `frontend/numparam` | LGPLv2+ | **Needed** for `.param`/expressions, so the build is LGPL-covered |
| `xspice` | Public domain, except `xspice/icm/table` (GPLv2+) | Include XSPICE, **exclude the `table` code model** |
| `osdi` | MPL-2.0 | Exclude (also needed for safety: it loads compiled models) |
| `tclspice.c` | LGPLv2 | Exclude |
| `ndev` | Public domain | Optional |
| Manual | CC-BY-SA 4.0 | Link only |

Individual device model sources (for example HiSIM or the BSIM variants) may carry their own
headers. I have not verified those. Because numparam is LGPL, ship the `.wasm` as a separately
replaceable asset, with the corresponding source and build script, and list it in
[Third-party notices](../../THIRD_PARTY_NOTICES.md). That keeps relinking possible and is compatible with Waffle's MIT
licence. **Legal review is needed before release.**

### Engine selection and energy

| Situation | Engine |
|---|---|
| Live operating point, wizard benches, generic-only designs | Quick |
| Any vendor deck using constructs outside the Quick set; LAPLACE; VDMOS/BSIM | Full |
| User preference "Always Full" | Full |
| CI cross-check | Both, compared |

Energy and performance rules:
- **No background simulation**, ever. A run happens on a command.
- **Live OP** (opt-in toggle in the panel) re-runs the Quick OP debounced 300 ms after an edit that
  touches a simulated part or net. It uses the undo journal and is skipped for unrelated edits. It
  is cancelled by a newer edit, and only runs while probes are visible.
- **Long runs** (transient, Monte Carlo) are chunked with progress and Esc to cancel. They respect
  the extension watchdog: dedicated worker, up to 10 min.
- The idle worker is torn down after 10 min, as today.

## 11. Analyses, probes, viewer

| Analysis | Today | Proposal |
|---|---|---|
| OP | Yes | Values drawn **inline on the schematic** next to wires and pins, without hover pop-ups (user preference). Node V, branch I, device power. |
| DC sweep | Yes | Nested sweeps, parameter and temperature sweeps (`.step`) |
| AC | Yes | Bode with phase margin and −3 dB measures. Loop-gain probe (Middlebrook injection inserted at a selected wire). |
| Transient | Yes | `.meas`: rise, overshoot, settling, period, average/RMS power |
| Noise | No | `.noise` with input- and output-referred density and integrated noise. Op-amp en/in from template fields. |
| Monte Carlo / tolerance | No | Tolerances come from BOM parameters: generic parts' Tolerance, the capacitor dielectric class, the vendor `DEV/LOT` where present. Default distribution is Gaussian with tol = 3σ, truncated. A "Worst case" mode uses sensitivity-signed corners. The seed is stored in the bench. Results are a histogram of each `.meas` against limits. |
| FFT/THD | No | Later |

**Probes** are simulation overlay objects: voltage on a net, differential across a pair, current
into a pin, power of a part. They are kept in the bench and never become document objects. They
never reach the BOM, PCB or ERC. This **needs a new host API**: `api.ui.decorations.set(doc,
items)`. It is read-only, text-only, capped at 2000 items, and cleared when the extension stops.
The same API serves SI and Thermal.

**Waveform viewer.** It builds on the existing plot view, adding:
- stacked panes
- math traces (`v(a)−v(b)`, `i·v`)
- delta cursors
- decimation in the worker, keeping a min/max envelope per pixel column so the 1 MB view limit
  holds at any zoom
- CSV/PNG export

**Compare** ties in with diff and compare, a major Waffle direction. You can overlay the previous
run, another bench, or the same bench on another git revision of the design. The model hashes and
template versions are pinned in the result, so a difference can be traced to "R5 changed" or
"template opamp@1 → @2".

## 12. Coverage report and simulating a selection

### Coverage report

The coverage report is the first thing Design › Simulate shows when a design has gaps.

```
Simulation coverage — base variant          41 of 52 parts simulate
  Vendor 4 · Fitted 9 · Generic 18 (defaults in 23 fields) · Ideal 2 · Load-only 3 · Excluded 5 · Missing 6
Ref   Value        Model                 Rung      Pins   Action
U3    OPA333       opa333.lib (TI)       Vendor    5/5    —
U5    AP2112K-3.3  ldo@1, 3 defaults     Generic   4/5    Review… (EN unmapped → tied to VIN)
U7    TPS62840     encrypted PSpice      Missing   —      Use generic buck · Import other…
J2    USB-C        —                     Excluded  —      Make port…
```

- **One-click "Use generic"** for each row, and **Use generic for all Missing**. The generic is
  filled from the part's own parameters; anything else goes in as a default, and the rung shows it.
- **Assembly variants are respected.** The report is recomputed incrementally from the undo
  journal, per changed part.
- **MCP and CLI** can read the report as JSON.

### Simulate a selection

Select a region (rectangle or lasso) and choose **Simulate Selection**. Nets that cross the
boundary become **ports**:

- Power and ground nets get DC sources. The voltage comes from Signal intent: a confirmed
  `signal.intent.voltage`, otherwise the `AtriumNetIntent` reading at `likely` or above, which
  the user confirms in the port dialog.
- Nets that only reach inputs inside the region get a source: DC, step, sine, or AC 1.
- Nets driven from inside get a probe plus an optional load (R‖C).
- Other nets: float (1 GΩ) or a user choice.

The choices are saved as a **test bench**: `{scope, ports, analyses, probes, measures, seed}`.
Re-running is one click, and the bench appears in the panel's bench list. Connectors on the
whole-design bench can be turned into ports the same way. Benches are stored in
`project.simulation.benches`, written through proposals. That requires adding `propose:edits` to
the SPICE manifest, as SI has. The extension still never edits the schematic itself.

Altium-style stimulus parts placed on the schematic (VSIN, VPULSE …) keep working, for import
fidelity and for users who prefer them. They are flagged "simulation only" so they are left out
of the BOM, PCB and ERC.

## 13. Fitting the Signal model and the one check engine

The parallel unification gives a Net (connectivity), a Signal (intent, `kind`, `tags`,
`intent`) and one rule/check engine. Simulation plugs in like this:

- **Ports and probes refer to Signals where one exists.** A diff-pair Signal gets a differential
  probe by default. An xSignal through a series resistor is probed end to end. Bench ports read
  `signal.intent.voltage` and `role`.
- **Stimuli can be tagged:** `sim:stimulus=sine 1k 1V` on a Signal is the same as a bench port.
  This is advisory, and the bench stays the store.
- **Simulation-derived checks are Design Insights,** severity tip or advice, never DRC errors.
  They read the **last cached result** for the active variant and never start a run. Each insight
  links to "Re-run" and shows how old the result is.

| Check | Uses | Message, for example |
|---|---|---|
| LDO dissipation | (Vin − Vout)·Iload from OP; package RθJA from the footprint/thermal module | "U5 dissipates 0.62 W; SOT-23-5 at 25 °C ambient allows about 0.4 W" |
| Op-amp output headroom | Vout vs rails − swing | "U3 output sits 20 mV from V− (RRO swing 10 mV): clipping likely" |
| Op-amp input CM range | Vin,cm vs range | |
| MOSFET gate drive | Vgs vs Vgs at the Rds(on) spec | "Q2 gate driven to 3.3 V; Rds(on) is specified at 10 V" |
| Zener/LED current | I vs Izk / If max | |
| Capacitor effective C | DC bias vs the derating curve (estimate label carried) | "C12 is about 40 % of nominal at 4.8 V (X5R 0402, estimate)" |
| Transient overshoot | `.meas` on a bench vs a limit on the Signal | |

**Component Stress merges into this.** `stress.js` already consumes `.op` results. Its
rated-value checks and these simulation checks become one check family in the unified engine
with one Messages group. MCP `stress_check` and the future `list_insights` return the same
records.

## 14. Import compatibility

| Source | What we read | Notes |
|---|---|---|
| **Altium SchLib / SchDoc / IntLib** | SIM implementation records: model name, kind, the referenced `.mdl`/`.ckt` (embedded in IntLibs), the pin map, `Spice Prefix`, netlist templates (`@DESIGNATOR %1 %2 @MODEL …`) | `sch-import.js` currently drops non-PCBLIB implementations. **Keep them raw on the def** (no data loss), then translate. Embedded model files land in the user store, licence unknown, not embedded in the project. Altium's simulation source and generic libraries map to our sources and templates. Exact record fields must be verified against fixtures. The pidp11 fixture has no sim models, so we need a small self-made SchLib. |
| **LTspice** | Model libraries (`.lib/.sub/.mod`), indexed from the user's install. Later, `.asc` testbench import into a bench with pasted parts. | Do not bundle LTspice's shipped libraries. |
| **KiCad 7+** | `Sim.Device`, `Sim.Type`, `Sim.Pins` (`1=+ 2=-` pairs), `Sim.Params`, `Sim.Library`, `Sim.Name` | The aliases exist, but the `Sim.Pins` *pair* syntax is not parsed today (bug). `Sim.Library` paths go through the store, never the file system. |
| **PSpice / OrCAD** | `.lib` model text | `.olb` symbols are out of scope. Encrypted blocks are refused. |
| **Export** | ngspice/LTspice-compatible netlist (exists), plus a model bundle **without** vendor files unless the user includes them | |

## 15. MCP

These follow the `si_simulate` pattern: `OPS.*` in `mcp/headless.js`, modules from
`extensions/spice` loaded by `board_runner.py`, tools in `mcp/automation.py`.

| Tool | Kind | What |
|---|---|---|
| `sim_coverage` | read | The coverage report JSON, per variant |
| `sim_netlist` | read | The netlist, with rungs and provenance comments |
| `sim_simulate` | read | Bench or ad hoc spec (analysis, scope, ports, probes, measures). Returns measures, decimated waveforms (capped) and the engine used. The Quick engine is headless-safe; the Full engine needs the WASM asset. |
| `sim_model_fit` | pure | Template + fields (each with `src`/`quote`) → subckt, rung, bench check |
| `sim_model_import` | read | Parse report for supplied text. Stores nothing. |
| `sim_model_propose` | proposal | Assign a model or template to a part, chip or family. Needs `--allow-write`, as generic parts do. |

Agents may not invent values. A field without `src` is stored as `ai`, the rung drops to Generic,
and the tool result says so.

## 16. Data shapes

```jsonc
// component (library) — additive field, absent = today's behaviour
"sim": {
  "model": {"kind": "vendor", "ref": "sha256:9f2c…", "name": "OPA333", "file": "opa333.lib", "dialect": "pspice"}
        // or {"kind": "template", "id": "opamp@1"}  or {"kind": "primitive"} or {"kind": "none", "reason": "connector"}
  "params": { /* §5 provenance records */ },
  "pins": {"by": "name", "map": {"INP": "+IN", "INN": "-IN", "OUT": "OUT", "VCC": "V+", "VEE": "V-"}, "tie": {"EN": "VIN"}},
  "units": "per-unit",                     // multi-unit: one instance per unit
  "check": {"bench": "opamp-basic@1", "passed": true, "date": "2026-11-20", "atrium": "0.6.0"},
  "origin": {"placeholder": "opamp", "params": {...}}   // placed parts only, after resolve
}
// family: componentFamilies[i].sim = {template, params}; per chip: .chips[part].sim
// project.simulation (version 2; v1 IBIS data unchanged)
{"version": 2,
 "models": {"<key>": {"kind": "ibis" | "spice", "name", "text", "sha256", "licence", "ack": {"by", "date"}}},
 "assign": {...},                                        // SI, unchanged
 "benches": [{"id", "name", "scope": {"kind": "design" | "region", "parts": [...]}, "ports": {...},
              "analyses": [...], "probes": [...], "measures": [...], "seed": 1, "engine": "auto"}],
 "results": {"<bench>": {"hash", "date", "engine", "summary"}}   // summaries only; waveforms stay in extension storage
}
```

Format versioning: every addition is a new optional field, so older Waffle versions keep loading
the file. `project.simulation` goes to version 2 with a no-op migration, and the compat corpus
gains a `v1.x-sim-models.atrium` fixture.

## 17. Phased rollout

Each line is one commit, with its tests in the same commit.

**P1: Honest coverage (no new models)**
1. Netlister returns a rung and a reason per part. `MODELS` is relabelled "Generic (Waffle
   approximation)". Coverage JSON.
2. Coverage report panel, "Exclude with reason", and inline OP labels via a new
   `ui.decorations` host API (plus a security test).
3. Manifest gets `propose:edits`. `project.simulation` v2 with benches. Compat fixture.

**P2: Quick engine growth**
4. Safe expression parser and B-sources, with automatic derivatives.
5. S/W switches, K coupling, T line (shared with SI).
6. `.param` expressions, `.func`, `.step`, `.meas`.
7. `.noise`.

**P3: Templates and fitting**
8. Template framework, provenance records, bench-check harness.
9. diode / zener / LED / BJT / MOSFET fitters, and a refit of the old `MODELS` table.
10. opamp and comparator.
11. ldo, vref, averaged buck/boost.
12. capacitor (ESR/ESL/DC-bias), inductor, ferrite, crystal, transformer, switch, logic, load.

**P4: Wizard, mapping, placeholders**
13. Model Wizard UI with bench preview.
14. Pin mapper and the family/chip/package store.
15. Placeholder → template mapping, and resolve handling (§6). This is done jointly with the
    library agent.
16. Datasheet assist hook: shared parser, AI proposals unconfirmed until ticked.

**P5: Vendor import**
17. Lexer/AST, PSpice/LTspice/HSPICE rewrites with a log, encrypted-model detection, limits.
18. User model store, project embedding with acknowledgement, missing-model flow.

**P6: Full engine**
19. ngspice WASM build script, licence notices, asset loading, MEMFS-only runtime.
20. Engine selection and the ngspice cross-check suite.

**P7: Benches and analyses**
21. Simulate Selection, ports, benches.
22. Probes on the schematic, viewer panes, math traces, compare runs.
23. Monte Carlo and worst case from BOM tolerances.

**P8: Checks and MCP**
24. Simulation insights, merged with Component Stress.
25. MCP tools.

**P9: Imports**
26. Altium SIM implementations kept and translated.
27. KiCad `Sim.Pins` pairs.
28. LTspice install index.
29. LTspice `.asc` bench import.

P1–P3 give most of the user value: "my design simulates, and I can see how well". They need no
WASM and no vendor files.

## 18. Tests

- **Fitting.** Each fitter reproduces its inputs. Diode Vf at both points within 1 %. Op-amp GBW
  and SR measured on the bench within 5 %. LDO dropout at the given load within 2 %. MOSFET
  Rds(on) at the given Vgs within 3 %.
- **Template goldens.** Netlist text per template version. A changed golden needs a version bump.
- **Dialect corpus.** Self-written CC0 snippets, one per construct per dialect. No vendor files in
  the repo. Each has an expected rewrite log and expected engine choice.
- **Security.**
  - `.control` and `shell` are stripped.
  - `.include` cannot reach the file system.
  - Encrypted blocks are refused.
  - Expression and nesting fuzzing under the time and memory budgets. This extends
    `tests/analysis/spice-limits.cjs`.
  - ngspice MEMFS has no `NODEFS`.
  - The decorations API caps and scrubs input.
- **Cross-engine.** Quick vs ngspice native (`tests/spice-ngspice.py`, which skips without
  ngspice, like `si-ngspice.py`) and vs ngspice WASM in CI on the macOS and Linux runners.
  Tolerance is 0.5 % on OP and AC magnitude, 1 % on transient waveforms after alignment.
- **Provenance.** Defaults lower the rung. AI values without a tick never reach Fitted. Resolving
  a placeholder keeps `origin` and the right badge.
- **Coverage.** Variant-aware. Incremental results equal a full recompute after random edits.
- **Performance budgets.**
  - Coverage under 20 ms for 500 parts.
  - Quick OP under 50 ms for 200 parts.
  - Live OP adds no work on unrelated edits.
  - Full-engine cold load under 1 s on Apple silicon, measured and recorded.
  - Eager JS unchanged.
- **MCP.** Each tool, including refusals without `--allow-write` and the `src` rule.

## 19. Risks

| Risk | Mitigation |
|---|---|
| Users trust a generic model like a vendor one | The rung and default count are shown everywhere: plots carry a watermark-style footnote ("3 parts generic, 23 assumed values"), insights carry the rung |
| Licence breach through git-shared projects | User store by default, an acknowledgement to embed, a health check, no bundling |
| ngspice licence surprises (LGPL numparam, device headers) | Exclusion table above, replaceable asset, source plus build script, legal check per tag |
| Convergence trouble in behavioural models | Smooth functions only, gmin and source stepping (already present), bench checks catch it before use |
| The dialect translator becomes a long tail | Rewrite log plus the Full engine's compatibility modes; unsupported constructs give a clear message and the generic button |
| WASM size and memory | Lazy loading, a single instance, freed on idle. Measure before committing to it. |
| Altium SIM record formats are under-documented | Keep the raw records (no loss), translate what is verified, build our own fixtures |
| Scope creep into a full simulator UI | Benches, coverage and insights first. Schematic-level mixed-signal digital (XSPICE) is out of scope until asked. |

## 20. Open questions for the user

1. **Vendor models in projects.** For the group's shared repos, should the default be "user
   store, re-import per person" (safest) or "embed with acknowledgement" (convenient)?
2. **Monte Carlo default.** Gaussian with tolerance = 3σ, or uniform within tolerance? Do you want
   worst-case corners as the default review mode?
3. **Stimuli.** Test benches stored beside the schematic (proposed), Altium-style source parts on
   the sheet, or both?
4. **Live OP.** Is an opt-in live operating point with inline labels on the schematic useful, or
   do you only want runs on command?
5. **Engine.** Is it acceptable to ship an LGPL-covered ngspice WASM asset, as a replaceable file
   in the extension, with legal review? Or do you prefer to invest further in the clean-room
   engine only?
6. **Which part categories matter most** in your group's designs (analog front ends, power,
   sensors, RF)? That sets the template order in P3.
7. **Mixed-signal.** Do you need digital simulation (MCU/FPGA behaviour), or is "Load-only" plus
   IBIS edges enough?
8. **LTspice.** Do you have LTspice testbenches (`.asc`) you would like to import, or only model
   files?
