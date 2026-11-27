# Net name intent

Status: phases 0–2 implemented (§15, §16); phase 3 creepage and the P1/P2 leftovers (conventions files, Create from nets) in §17, 2026-11-20.

Waffle should understand what a net name *means* — "3V3 is a 3.3 V rail", "nRST is an active-low reset",
"USB_DP and USB_DM are one differential pair, DP positive" — and use it in two places:

1. **Suggestions for the Signal model.** Proposed differential pairs, buses, rails and tags. The user
   accepts or declines them. Nothing is applied silently.
2. **Design Insights.** Hints that need to know a net's role: creepage on a 48 V rail, a swapped USB
   pair at the connector, an active-low net on an active-high pin.

This document covers the classifier, how it uses connectivity evidence, how it fits the Signal model
being built in parallel, the insights it makes possible, and data shapes, module boundaries, incremental
updates, performance, tests and rollout.

## 1. Decisions in brief

- **One classifier, `app/net-intent.js` (`AtriumNetIntent`).** It is DOM-free, lazy, ≤ 14 KB of source
  and adds 0 eager bytes. It replaces three diff-pair suffix lists and about 25 copies of
  `POWER`/`GROUND` regexes spread across the code.
- **Grammar, not one regex.** A name is tokenised, then read as `[modifiers] stem [qualifiers] [polarity]
  [index]`, using small dictionaries. Every result carries the reasons behind it.
- **Four confidence levels:** `user` > `strong` > `likely` > `weak`. Name evidence alone never exceeds
  `likely`. Reaching `strong` takes a second source: connectivity, a power port, or the pair partner
  that matches it.
- **Inferred intent is advice, never a rule.** Insights can use inferred intent at `likely` or above,
  because hints can be dismissed. DRC, the router and ECO use only `user` intent, meaning a confirmed
  Signal, rule or directive.
- **No parallel store.** The classifier is pure and derives everything. Confirmed intent lives on the
  Signal (`signal.intent`). Declined suggestions and project conventions live in the Signal store.
- **Learning is per project and deterministic.** It infers the project's conventions from names the
  user has confirmed and from what they accept or decline. Collaborators see the same results. There is
  no global or ML learning.

## 2. What exists today, and why it needs fixing

I ran the current code against a set of real-world names (JavaScriptCore, functions copied verbatim
from the code).

**Diff-pair detection has three disagreeing lists.**

| Site | Patterns | Misses | False pairs |
|---|---|---|---|
| `rules.js` `detectDiffPairs` (line 593) | `_DP/_DN`, `_P/_N`, `+/-`, bare `P/N` | **USB_DP/USB_DM**, CANH/CANL, CAN_H/CAN_L, CK_t/CK_c, TXP0/TXN0 | **CAP/CAN → pair "CA"**, STEP/STEN → "STE" |
| `diffpair.js` `SUFFIX` (line 16) | adds `_H/_L` | DP/DM, _t/_c, lane-before-polarity | same bare P/N risk; it routes pairs that DRC does not know about |
| `eco.js` `directives()` (line 466) | positive `/(_P\|\+\|P)$/i`, negative `/(_N\|-\|N)$/i` | rejects a `USB` directive on USB_DP/USB_DM ("needs one positive (…_P)…") | — |

The most common USB naming in the world, `USB_DP`/`USB_DM`, is not detected by any of them.

**Power and ground classification is copy-pasted and wrong in predictable ways.** The `POWER` regex in
`insights.js:101` (the same text appears in `si.js`, `return-path.js`, `xsignals.js`, `topology.js` and
`length-tuning.js`) treats all of these as rails:

- `VCC_EN`, `VDD_PG`, `3V3_PG`, `VBUS_DET`, `VIN_SENSE`
- `+IN`
- `VINP`/`VIN_N` (an ADC differential input)
- `24V_RTN` (a return)

It does not see `ISO_GND` as a ground. `pdn.js voltageOf` reads `LDO2VIN` as 2 V, `VDD_CORE_2` as 2 V
and `3,3V` as 3 V.

Downstream this costs us in several ways:

- Decoupling, width and high-speed exclusions misfire.
- `ctx.highSpeed` drops an enable net because it "is power".
- Each module answers "is this ground?" differently. `polygon-pour.js` accepts `X_GND` and `stress.js`
  accepts `PE`; the others accept neither.

**Active-low parsing already exists, but only in the symbol wizard.** `symbol-wizard.js activeLow()` is
good. It handles nRST, RST#, /CS, ~{CS}, R\E\S\E\T\ and combining overlines. It should move into the
shared module so nets and pins are read the same way.

Phase 0 of the rollout (§12) is just this consolidation. It already pays off without any new UI.

## 3. The classifier

### 3.1 Normalisation

These steps run before tokenising. They are cheap and run once per distinct name string.

1. **Unicode NFKC**, so full-width `ＶＣＣ` becomes `VCC`. Case-fold with an ASCII-only `toUpperCase` on
   a copy; never use `toLocaleUpperCase`, because Turkish `i` would break. Keep the original for display.
2. **Strip active-low decoration and record it.** This covers KiCad `~{…}`, Altium `R\S\T\`, combining
   U+0305, and leading `/ ! ~`. `#` is recorded later, as a token.
3. **Strip the hierarchy path.** KiCad `/Power/3V3` becomes `3V3`, with the path kept as `scope`. The
   same applies to Altium sheet-prefixed names when net scope is hierarchical.
4. **Recognise auto-generated names and stop.** These get `role: "auto"` and no intent:

   | Tool | Pattern |
   |---|---|
   | Altium | `NetR1_2`, `NetU3_14` |
   | KiCad | `Net-(R1-Pad2)`, `unconnected-(U1-PA3)` |
   | OrCAD | `N12345` |
   | Eagle | `N$12` |
   | PADS | `$$$1234` |
   | Waffle | its own default net names |

   An auto name can still get intent from connectivity (§4), for example a crystal net.

### 3.2 Tokens

Split on `_ - . space`. Also split on letter↔digit boundaries *only* where a voltage or index grammar
claims them: `3V3` stays one token, while `DQ12` becomes `DQ` + index `12`.

Recognise these token classes, in this order:

| Class | Examples | Notes |
|---|---|---|
| voltage | `3V3`, `1V8`, `0V9`, `12V`, `+5V0`, `-12V`, `3.3V`, `3,3V`, `P3V3`, `N5V`, `24VDC`, `230VAC` | `V` as the decimal point, or a trailing V. `P`/`N` prefixes are the Intel/Apple sign style. A comma is accepted as the decimal separator. |
| ground stem | `GND`, `AGND`, `DGND`, `PGND`, `SGND`, `CGND`, `GNDA`, `VSS`, `VSSA`, `0V`, `COM`, `EARTH`, `PE`, `CHASSIS`, `SHIELD`, `RTN`, `RETURN` | `PE`, `COM` and `RTN` are ground only as the whole name or as a qualifier of a rail (`24V_RTN`). |
| rail stem | `VCC`, `VDD`, `VEE`, `VBAT`, `VBUS`, `VIN`, `VSYS`, `VMAIN`, `VCORE`, `VDDQ`, `VDDIO`, `VCCIO`, `VTT`, `VPP`, `VREF`, `AVDD`, `DVDD`, `PVDD`, `PWR` | `VREF` is a rail of kind `reference` (low current). `VTT` is DDR termination. |
| function | `EN`, `ENABLE`, `OE`, `CE`, `PG`, `PGOOD`, `POK`, `FB`, `SENSE`, `SNS`, `ISENSE`, `DET`, `OK`, `FAULT`, `FLT`, `ALERT`, `SHDN`, `PD`, `STBY`, `SLEEP`, `MON`, `ADC` | A function token **after** a rail makes the net a *rail control/sense* signal, not a rail. |
| reset/irq/cs | `RST`, `RESET`, `MCLR`, `POR`, `INT`, `IRQ`, `DRDY`, `CS`, `SS`, `NSS`, `WP`, `HOLD` | |
| clock | `CLK`, `CLOCK`, `SCLK`, `SCK`, `MCLK`, `BCLK`, `LRCLK`, `REFCLK`, `CK`, `XTAL`, `XI`, `XO`, `XIN`, `XOUT`, `OSC`, `OSC32` | `SCL` is a clock of speed `slow` (I²C). |
| frequency | `25M`, `25MHZ`, `32K768`, `32K`, `100MHZ` | Attached to a clock as `freq`. |
| protocol | `USB`, `PCIE`, `SATA`, `HDMI`, `DP` *as a prefix*, `MIPI`, `CSI`, `DSI`, `LVDS`, `ETH`, `RGMII`, `MDI`, `SGMII`, `CAN`, `LIN`, `RS485`, `485`, `UART`, `I2C`, `SPI`, `QSPI`, `SDIO`, `EMMC`, `JTAG`, `SWD`, `DDR`, `LPDDR` | This is context: it biases pair and role decisions. |
| polarity | `P/N`, `+/-`, `DP/DM`, `DP/DN`, `H/L`, `T/C`, `POS/NEG`, `PLUS/MINUS`, `INP/INN/INM`, `A/B` | §3.4 |
| active-low | leading `n`/`N` before a known control stem, `_N`, `_B`, `_L`, trailing `n`, `#`, leading `X` (Japanese/Renesas negative logic), a leading `\` (single-backslash negation, `\RESET`: "active low by its \ prefix") | `_N`, `_L` and `X` are ambiguous (§3.5); a lone control `X_N` (`RESET_N`) defaults to active-low. |
| decoration | `_R`, `_C`, `_CONN`, `_EXT`, `_ESD`, `_FILT`, `_F`, `_RAW`, `_BUF`, `_ISO` | These mark the same signal on the far side of a series part or a filter. They are stripped for stem matching and feed the Signal model's join (§5). |
| index | trailing digits, `[n]`, `_n` | |

### 3.3 Roles

The output is one primary `role`, plus attributes:

| Role | Attributes | Example |
|---|---|---|
| `ground` | `domain` (`""`, `A`, `D`, `P`, `S`, `C`, `ISO`, `ISO2`, `PE`), `return of` (rail) | `AGND` → domain A; `24V_RTN` → return of 24V |
| `rail` | `voltage` (V, signed), `nominal/max` (`VBUS` 5/20/48 with USB PD), `kind` (`supply`, `reference`, `termination`, `battery`, `mains`), `variant` (`A`, `IO`, `STBY`, `SW`) | `VDD_1V8_A` → 1.8 V, analog variant |
| `railSignal` | `rail`, `function` (`en`, `pg`, `fb`, `sense`, `det`) | `3V3_PG` → power-good of 3V3 |
| `clock` | `freq?`, `speed` (`slow` for SCL), `crystal` (XI/XO) | `CLK_25M` |
| `control` | `function` (`reset`, `enable`, `irq`, `cs`, `handshake`), `activeLow` | `nRST`, `SPI1_CS_N` |
| `data` | `protocol?`, `direction?` (`tx`/`rx`/`mosi`/`miso`), `bus?` | `UART2_TX` |
| `pairMember` | `pair` stem, `polarity` (+1/-1/0 = unknown), `pattern` | `PCIE_TX0_P` |
| `busMember` | `stem`, `index` | `DQ12`, `ADDR3`, `D[0..7]` members |
| `mains` | `line`/`neutral`/`earth` | `AC_L`, `AC_N`, `LINE`, `NEUTRAL`, `PE` |
| `nc` | | `NC`, `DNC` |
| `auto` | | `NetR1_2` |
| `unknown` | | |

`role` stays a single value on purpose, because insights need one answer. Combinations are carried as
attributes. `PCIE_TX0_P` is a `pairMember` with `protocol: PCIE`, `direction: tx`, `lane: 0`.

### 3.4 Pair polarity patterns

Polarity is read from the **last one or two tokens**, never from a prefix. That is why `DP_ML0_P`
(DisplayPort) gives `+` from `_P`, not from `DP`. The partner is the same tokens with only the polarity
token flipped. This handles lane-before-polarity (`TX0_P`), polarity-before-lane (`TXP0`) and mixed
separators.

| Pattern | Examples | Alone | With partner present |
|---|---|---|---|
| `_P/_N` | `LVDS_P`, `PCIE_TX0_P`, `TX_P0` | weak (`_N` may be active-low) | likely |
| `+/-` | `CLK+`, `RX0+`, `HDMI_D2+`, `MDI0+` | weak | likely, but **not** when the stem is a rail (`V+/V-`, `+12V/-12V` are two rails) |
| `DP/DM`, `DP/DN`, `D+/D-` | `USB_DP`, `USB1_D+` | weak (`DM0` is DDR data mask) | likely; strong with a `USB` token or a connector with pins D+/D- |
| `TXP/TXN`, `RXP/RXN` (no separator) | `TXP0`, `SATA_RXN` | weak | likely |
| bare `P/N` (no separator) | `RXP`, `CAP`, `STEP` | never | likely only when the stem is a known serial stem (TX, RX, CLK, REFCLK, D, DQS, DATA, Dn); otherwise none. This kills CAP/CAN and STEP/STEN. |
| `H/L` | `CANH`, `CAN_H` | weak | strong with `CAN`/`LIN` stem; otherwise not a pair (`SPEED_H/SPEED_L` are level selects) |
| `T/C` (true/complement) | `CK_t/CK_c`, `DQS0_t` | — | strong in DDR4/5/LPDDR context; `_c` alone is "AC-coupled" decoration |
| `POS/NEG`, `PLUS/MINUS` | `SENSE_POS` | weak | likely (analog differential) |
| `INP/INN`, `INP/INM`, `AINxP/N` | `ADC_INP`, `AIN0N` | weak | likely, tagged `analog` (no impedance profile) |
| `A/B` | `RS485_A`, `ENC_A`, `MOTOR_B` | never | **likely only with a `485`/`RS485`/`RS422`/`PROFIBUS` stem, or pins named A/B on a part that also has DE/RE pins**. Polarity is set to 0 (unknown): TIA-485 calls A inverting, while most vendor datasheets call A non-inverting. The suggestion asks the user. |

Two firm rules:

- **TX/RX alone are never a pair.** `UART_TX`/`UART_RX` and `TXD`/`RXD` are two signals in opposite
  directions. Likewise `SDA`/`SCL`, `MOSI`/`MISO`, `CTS`/`RTS`.
- **Ambiguity in a group of three or more** (`X_P`, `X_N`, `X_N2`) gives no suggestion. A wrong pair is
  worse than a missing one.

### 3.5 The `_N` problem and other collisions

`RST_N` is active-low, but `CLK_N` is a pair negative. They are resolved in this order:

1. **Partner present** (`CLK_P` exists, or `_t`, `+` …): pair member.
2. **Stem is a control word** (RST, RESET, CS, EN, OE, WE, INT, IRQ, PD, SHDN, …): active-low.
3. **Project convention** (§6.2): if this project uses `_N` only for active-low, the net is active-low.
   If it uses `_N` only for pairs, it is a pair member missing its partner. That is itself an insight.
4. Otherwise: `unknown` with both readings at `weak`.

The same logic applies to the other collisions:

| Name pattern | Readings |
|---|---|
| `_L` | active-low (Apple/Sun `RESET_L`) or CAN low |
| `_B` | bar (`CS_B`) or RS-485 B |
| `_C` | complement or AC-coupled |
| `X` prefix | Japanese negative logic (`XRST`) or crystal (`XIN`) — crystal wins when an `IN`/`OUT`/`I`/`O` token follows |
| `DM` | USB minus or DDR data mask |

### 3.6 Voltage inference rules

| Rule | Result | Confidence (name only) |
|---|---|---|
| `\d+V\d+` token | `3V3` → 3.3, `0V9` → 0.9, `12V0` → 12 | likely |
| `[+-]?\d+([.,]\d+)?V` token | `+5V` → 5, `-12V` → −12, `3,3V` → 3.3 | likely |
| `P\d+V\d*` / `N\d+V\d*` token | `P3V3` → 3.3, `N5V` → −5 | likely |
| `VCC_3V3`, `VDD_1V8_A` | voltage token qualifies the rail stem | likely |
| `VBUS` | 5 V nominal, max 20 V (48 V EPR) when USB PD parts are present | likely |
| `VBAT` | voltage unknown, `kind: battery`; a cell count `1S`/`2S`/`4S` gives a nominal | weak |
| `VCC`, `VDD`, `VIN`, `VDDIO` | rail, voltage unknown | likely (role only) |
| `\d+VAC`, `AC_L`, `LINE`, `MAINS`, `HV` | `kind: mains`, voltage from the token or unknown (treated as ≥ 230 V for creepage) | likely |
| digit without a `V` (`VDD_CORE_2`, `LDO2VIN`) | **no voltage** | — |
| voltage + function token (`12V_EN`) | `railSignal` of 12V; the net itself has no voltage | likely |

Voltage from connectivity (§4) can raise the confidence or contradict the name. A contradiction is an
insight: "3V3 is fed by U5 (AMS1117-5.0)".

## 4. Connectivity evidence

Names lie. Pins and parts are usually right, because they come from a datasheet-derived library.

| Evidence | Source in Waffle | Effect |
|---|---|---|
| Power port object carrying the name | sch items `kind: "power"` / `schPaint.type === "power"`; style `gnd`/`signal`/`earth` | rail or ground → **strong**; port style sets the ground subtype (earth → PE/chassis) |
| Pin electrical type Power (7) on an IC pin | `erc.js pinType` | rail-or-ground; a pin named VSS/GND picks ground |
| Pin names on the net | `defs` symbol pins, parsed with the same classifier | polarity (`D+`, `DM`, `TXN`, `CANH`), clock (`XI`, `CLKIN`), active-low (`nRESET`), rail (`VDD_1V8`) |
| Part kind by designator / library params | ref prefix (`Y`/`X` crystal, `J`/`CN`/`P` connector, `FB`, `L`, `C`, `R`, `U`), `catalogue.js` params | crystal net, connector pin semantics, capacitor voltage rating |
| Regulator output | part value or params (`AMS1117-3.3`, `TPS62133 … 3.3V`), pin named `VOUT`/`SW`/`FB` | rail voltage → strong (phase 3) |
| Decoupling pattern | many 2-pin C to a ground-role net | rail → weak boost |
| Explicit intent | rules (`netClasses`, `diffPairs`, `netCurrents`), ECO directives, confirmed Signals | **user** |

**Combining.** Each piece of evidence is a signed integer weight: +3 strong, +2, +1, −2 contradicts,
−3 contradicts strongly. The total maps to a level:

- ≥ 5: strong
- 2–4: likely
- 1: weak

When any single item contradicts by −2 or more, the reading also gets a `conflict` flag. This
deliberately avoids Bayesian probabilities. Integer weights are explainable ("by name +2, D+ pin on J3
+3"), stable across versions, and easy to put in a "Learn more" panel. Every weight lives in one table
in the module, so tuning it is a one-line diff with a corpus test.

A conflict becomes an insight. "Rail/ground" conflicts are rare and high-value. "Pin name polarity"
conflicts are the swapped-pair check.

## 5. Fitting the Signal model

The other agent's model defines:

- **Net** = physical connectivity (derived).
- **Signal** = intent. It spans nets joined by series passives and has `kind` single/diff/bus, with
  per-member polarity, and `tags`.

Name intent stays a **derivation plus a suggestion source**. It is never a store of its own.

```text
names + pins + parts ──► AtriumNetIntent.read(name)          (pure, memoised)
                     └─► AtriumNetIntent.index(project)       (per-net evidence, incremental)
                              │
                              ├─► suggestions()  ──► Signal panel / "Create from nets" / MCP
                              │       accept ──► AtriumSignals.apply(s)   (one undo step)
                              │       decline ──► signals.declined[key]
                              └─► intentOf(net)  ──► insights, ctx.highSpeed, PDN, pour, autoplace …
```

- **Suggestions** have kind `diff`, `bus`, `rail`, `ground`, `tag` or `join`. A `join` is "USB_DP and
  USB_DP_R are one signal across R12". Its decoration token and the series-part topology agree, which
  gives the Signal model's join a name-side confirmation.
- **Accepting** writes a Signal with `intent` fields: `{role, voltage?, domain?, activeLow?,
  polarity?}`, `source: "name"`, `confirmed: <date>`. From then on the intent is `user`, and
  DRC/router/ECO may use it.
- **Proposed tags** use the names Altium users already have as net classes: `Power`, `GND`,
  `Clocks`, `USB`, `DDR_DQ_BYTE0`. Altium export then maps them to classes without inventing
  vocabulary. Intent fields stay structured; tags remain free-form user grouping.
- **Declines** are stored as `signals.declined = {<key>: {date, kind}}`. The key is a hash of the
  suggestion's kind and sorted members, the same scheme as `insights.js keyOf`. A decline survives
  renames of unrelated nets. It comes back if a member is renamed into a new pattern.
- **Overrides** are a Signal with `intent.role` set explicitly, for example
  `{role: "data"}` on `VCC_SEL`, meaning "this is not a rail". There is no per-net override map
  outside the Signal store.
- **Ask of the Signal agent:** reserve `signal.intent` (structured) and `store.declined` and
  `store.conventions` in the Signal store's schema. Accept suggestion objects in the shape in §8.

The Altium round trip works like this. Imported diff-pair classes and net classes arrive as `user`
intent. The classifier then only suggests what Altium did not define. The ECO `diffPair` directive
reads polarity through `AtriumNetIntent.polarity()`, which fixes the USB_DP/USB_DM rejection.

## 6. Overrides, learning and conventions

### 6.1 Overrides

These come in three tiers, highest first:

1. **Per signal.** The Signal's `intent` (above).
2. **Per project.** `signals.conventions`:
   ```js
   {activeLow: ["_N", "n"],          // styles this project uses for active-low
    pairs: ["_P/_N", "DP/DM"],       // pair styles this project uses
    stems: {rail: ["VPROG"], clock: ["SYSREF"], ground: ["GND_MOT"]},
    never: {pair: ["A/B"], rail: ["VSEL"]}}
   ```
3. **Built-in tables.**

Conventions live in the project so every collaborator gets the same answers. A personal or company
dictionary can be exported and imported as a JSON file ("Copy conventions from project…"). It is
never applied implicitly from Preferences, because then two people would see different insights on
the same file.

### 6.2 Learning

Learning is explicit and inspectable, never ML.

- **Convention inference.** On the first full index, count the styles in use. Only `strong`/`user`
  evidence counts, so inference does not feed on its own guesses. Examples: "`_N` appears 14 times,
  always with a `_P` sibling"; "active-low written as `n` prefix 9×, `_N` 0×". When a style has
  ≥ 5 uses and ≥ 90 % agreement, it resolves the §3.5 collisions for the project. These inferred
  conventions are shown in the Signals panel's "Naming" section and can be pinned (written to
  `conventions`) or cleared.
- **Accept/decline counters per pattern.** Declining the same pattern (say, `A/B` pairs) three times
  in one project offers "Stop suggesting A/B pairs here", which adds it to `never.pair`. It never turns
  itself off silently.
- **Stem learning from confirmation.** Tagging `VPROG` as a rail makes `VPROG_A` and `VPROG_EN` read
  as a rail variant and a rail signal.

### 6.3 Case, locale and tool conventions

- **Case.** Matching is case-insensitive, except where case carries meaning:
  - `_t/_c` (lowercase by JEDEC)
  - the `n` prefix (`nRST` is active-low; `NRST` only when the stem is a control word)
  - trailing `n` (`RSTn`, but never `TXn`/`Dn`, which are lanes)
- **Decimal comma** (`3,3V`) is accepted. Units in other scripts (Cyrillic `В`) are folded only after
  NFKC and only when the token is otherwise numeric.
- **Non-ASCII names** get `unknown` and no intent. They are never guessed.

| Tool | Conventions to honour |
|---|---|
| Altium | `NetXn_m` auto names; overline `R\S\T\` and single-backslash `\RST` (Waffle draws both, the second on by default: [getting started](../getting-started.md)); power ports as rails; diff-pair directive (`_P/_N` required by Altium itself); `+3V3`/`GND` defaults |
| KiCad | `Net-(…)`, `unconnected-(…)`; `/sheet/NET` paths; `~{CS}` overbar; power symbols `+3V3`, `+5V`, `GNDA`, `GNDD`, `Earth`, `PWR_FLAG` (not a net); diff pairs need `+/-` or `_P/_N` |
| OrCAD/Allegro | `N12345` auto names; `*_P/*_N`; `#` suffix active-low |
| Eagle | `N$12`; `!` overline prefix |
| Intel/Apple style | `P3V3`, `PP3V3_S0` (Apple: `PP` = power plane, `_S0` = power state, so `PP3V3_S5` is the standby rail) |
| JEDEC DDR | `CK_t/CK_c`, `DQS_t/DQS_c`, `DM`/`DBI_n`, `RESET_n` |

## 7. Design Insights it enables

All checks follow the existing rules:

- They are advice and never fail DRC/ERC/Release.
- They are dismissable, with `sig` chosen to survive moves.
- They stay quiet where an enabled rule already covers the case.
- They use the existing small animated markers, with no new hover pop-ups.
- Every message says the basis ("by its name", "by pin D+ on J3"), so a wrong guess is obvious and
  cheap to dismiss.

The checks are ordered by value ÷ false-positive (FP) risk, which is also the rollout order.

| Check | Kind | Evidence needed | What it says | FP risk | Mitigation |
|---|---|---|---|---|---|
| `pairSwap` | sch + pcb | pair member (likely) **and** a pin whose own name has the opposite polarity | "USB_DP lands on J3 pin D− (polarity swapped?)" | low | quiet for protocols that allow lane polarity inversion (PCIe, SATA, SGMII, MIPI C-PHY n/a) unless the pin is a connector |
| `pairOrphan` | sch | pattern + project convention says this is a pair style | "PCIE_TX1_P has no PCIE_TX1_N (found PCIE_TX1_M)" with a rename fix | low | only when ≥ 2 complete pairs of the same pattern exist in the project |
| `pairUnassigned` | pcb | pair suggestion ≥ likely, not a Signal, routed as two single tracks | "USB_DP/USB_DM look like a pair but are routed separately" with a "Make pair" fix | low-med | suppressed for `analog` pairs |
| `railConflict` | sch | two names on one net implying different voltages, or power port vs label | "This net is both 3V3 and +5V" | very low | none needed |
| `railPinMismatch` | sch | pin name with a voltage (`VDD_1V8`, `VCCIO_3V3`) on a rail of another voltage | "U4 pin VDD_1V8 is on 3V3" | low | pins without a voltage token never fire; ranges (`VDDIO` 1.8–3.3) are not used |
| `capRating` | sch | rail voltage ≥ likely + capacitor voltage rating (`catalogue.js voltageOf`) | "C12 (10 V) on 12V: under 1.5× derating" | low | silent when the rating is unknown; the derating factor is a setting (ceramic vs electrolytic) |
| `activeLowPull` | sch | control role, activeLow, only input pins, no resistor to a rail or ground | "nRST has no pull-up: it floats until the driver is up" | med | like `i2cPullup`: "pull-ups inside an IC are not seen; dismiss" |
| `activeLowMismatch` | sch | net activeLow ≠ pin activeLow (from pin names) on a non-driver pin | "Net nEN (active low) drives U7 pin EN (active high)" | med | skipped when the net passes an inverter or transistor (Signal join); skipped for pins whose name has no control stem |
| `txToTx` | sch | two pins named TX (or two RX) on one UART net, both on ICs | "U1 TX and U9 TX are joined; UART TX goes to RX" | med (DTE/DCE, modules named from host side) | ICs only, never connectors; tip severity |
| `busGap` | sch | bus member stem with ≥ 4 members and one index missing | "D0–D7 has no D5" | low-med | only contiguous ranges with exactly one or two holes |
| `decoupling` (existing) | sch/pcb | rail role instead of the regex | (unchanged) | lower than today | `VCC_EN`, `3V3_PG` stop counting as rails |
| `widthCurrent` extension | pcb | rail ≥ likely, **no current set**, track < 0.25 mm on a net with ≥ N power pins | "3V3 runs 0.15 mm wide; set its current to check the width" | med | a tip that links to the current field; never claims a current |
| `creepage` | pcb | rail/mains voltage ≥ 30 V (strong or likely) against other nets | "48V is 0.4 mm from GND; IPC-2221B B2 suggests 0.6 mm (external, uncoated)" | med (voltage guessed) | off below 30 V; the message states the assumed voltage; mains gets "advice"; DRC rule present → quiet |
| `isolationBridge` | pcb + sch | two ground domains, one `ISO`/numbered, joined directly or by copper/pour | "GND_ISO touches GND at U3: isolation is bridged" | low | only `ISO`-class domains; A/D/P domains are expected to meet once |
| `splitGroundJoin` | sch | `AGND` and `DGND` both exist and never meet (no net tie, 0 Ω, FB) | "AGND and DGND never connect" | med | tip; an intentionally floating domain → dismiss |
| `splitCrossing` | pcb | a signal whose driver pins reference domain A routed over domain D plane | extends `returnPlane` | med-high | phase 4; needs pin-to-domain mapping |
| `clockEdge` | pcb | clock role ≥ likely or crystal, track within X mm of the board outline | "CLK_25M runs 1.2 mm from the board edge (radiates)" | low-med | threshold setting; quiet for edge connectors' own pins |
| `crystalFar` | pcb | crystal net (role or Y/X part) longer than ~10 mm, or a via in it | "Y1 is 18 mm from U1's XI/XO" | low | crystal ≤ 50 MHz only |
| `highSpeed` (existing context) | pcb | pair/clock/protocol role | (feeds `returnPlane`, `stub`, `crosstalk`) | lower than today | `ctx.highSpeed` uses roles, not `FAST` |

What I'd skip, and why:

- **"Clock without series termination."** Too design-dependent; most hints would be wrong.
- **"Name suggests a high current."** A name like `MOTOR` says nothing reliable about amps.
- **"VBAT needs reverse-polarity protection."** That is a design review, not a hint.

## 8. Data shapes

```js
// AtriumNetIntent.read(name) -> frozen, memoised by name string
{name: "PCIE_TX0_P", norm: "PCIE_TX0_P", tokens: ["PCIE","TX","0","P"],
 role: "pairMember", level: "likely",            // name-only ceiling is "likely"
 stem: "PCIE_TX0", polarity: 1, pattern: "_P/_N", partnerName: "PCIE_TX0_N",
 protocol: "PCIE", direction: "tx", index: 0,
 alt: [{role: "control", activeLow: true, level: "weak"}],   // competing readings (collisions)
 why: [["name", "_P suffix", 1]]}

// intentOf(net) from the index: name reading + evidence
{net: "USB1_DP", role: "pairMember", level: "strong", polarity: 1, pair: "USB1",
 why: [["name", "DP suffix with USB", 2], ["pin", "J3.D+", 3]],
 conflict: null,                                   // or {with: "pin", detail: "J3.D-"}
 source: "inferred"}                               // or "signal" (confirmed)

// suggestion (to the Signal model)
{key: "diff:6a1f…", kind: "diff", name: "USB1", members: [{net: "USB1_DP", polarity: 1}, {net: "USB1_DM", polarity: -1}],
 tags: ["USB"], intent: {role: "pairMember", protocol: "USB"}, level: "strong", why: […]}
{key: "rail:…", kind: "rail", members: [{net: "3V3"}], intent: {role: "rail", voltage: 3.3}, tags: ["Power"], level: "strong"}
{key: "join:…", kind: "join", members: [{net: "USB1_DP"}, {net: "USB1_DP_R", through: "R12"}], level: "likely"}
```

## 9. Module boundaries

| File | Global | Contents | Deps | Size target |
|---|---|---|---|---|
| `app/net-intent.js` | `AtriumNetIntent` | normalise, tokenise, `read(name)`, `voltage(name)`, `polarity(name)`, `partner(name, has)`, `activeLow(name)` (moved from symbol-wizard), `pairs(names, {conventions, existing})`, `isRail`/`isGround`/`isClock` shims, the weight table | none | ≤ 14 KB source |
| `app/net-intent-index.js` | `AtriumNetIntent.index` | per-project evidence index, `intentOf(net)`, `suggestions()`, convention inference; reads pins via `Atrium.pins`, defs, connectivity | net-intent, Waffle core | ≤ 12 KB |
| insights checks | in `insights-sch.js` / `insights-pcb.js`, or a new `insights-intent.js` to keep those files reviewable | the §7 checks | AtriumNetIntent | — |

Migration of the existing consumers, all in phase 0:

- `rules.detectDiffPairs` becomes a wrapper over `AtriumNetIntent.pairs`. Same signature, and the test
  in `tests/checks/rules.cjs:90` is extended rather than replaced.
- `diffpair.pairs` drops its own `SUFFIX` loop and calls `R.detectDiffPairs` only.
- `eco.directives` gets polarity from `polarity()`.
- `xsignals`, `si`, `return-path`, `topology`, `length-tuning`, `insights`, `autoplace`, `autorouter`,
  `pdn`, `plane-planner`, `support-placement`, `via-fence`, `stress` and `polygon-pour` replace their
  local `POWER`/`GROUND` regexes with `AtriumNetIntent.isRail`/`isGround`.
  - Where a module must stay standalone (worker bundles, headless runners), it keeps a fallback regex
    behind `globalThis.AtriumNetIntent?.isRail ?? localRegex` for one release.
  - The `library-panel.js` and `symbol-wizard.js` regexes classify **pin** names, not nets. They move
    to `read()` too, since the grammar is the same, but last.
- `lazy.js`: `register("AtriumNetIntent", {scripts: ["net-intent.js", "net-intent-index.js"]})`. Add it
  to the deps of `AtriumRules`, `AtriumInsights`, `AtriumXSignals`, `AtriumECO` and the symbol wizard.
  `mcp/board_runner.py` and the test loaders add the file to their script lists.

## 10. Incremental update strategy

- **`read(name)` is pure.** It is memoised in a `Map` keyed by the raw string, capped at 50k entries
  with clear-on-overflow. Renaming a net costs one parse.
- **The index keeps** `net → {reading, evidence[], level}`, `stem → Set(net)` (pair, bus and decoration
  buckets) and `def → pinReadings`.
  - On each pass it asks the undo store for `changed(doc, since)`. For each changed item it takes the
    old and new nets, as the insights engine already does (`commit`/`views` in `insights.js`), and
    recomputes evidence for those nets only.
  - Pair and bus suggestions are recomputed only for the stem buckets of touched nets.
  - `ids: null` (an unknown or large change) triggers a full rebuild in idle slices: a generator that
    yields every 2k nets, like `engine().update`.
- **Library changes** invalidate `pinReadings` for the changed defs, then the nets on parts of those
  defs. Defs carry a generation through `documentVersions().library`.
- **Lazy.** Nothing is built until a consumer asks:
  - Insights builds the index when markers are on.
  - The Signals panel builds it when opened.
  - `detectDiffPairs` needs only `read()`, never the index.
  - Suggestions are computed only while their panel or Insights is visible.
  - Convention inference runs once per full rebuild and after accept/decline.
- **Determinism.** The output never depends on iteration order. Nets are sorted with the natural
  comparator before pairing, and ties resolve alphabetically, as today's `detectDiffPairs` does.

## 11. Performance budget

| Item | Budget | Notes |
|---|---|---|
| Eager JS | **0 bytes** | everything is lazy; `AtriumRules` and `AtriumInsights` already are |
| Source size | ≤ 14 KB + ≤ 12 KB | tables are compact arrays; no regex per stem |
| `read()` cold | ≤ 2 µs/name median, 20k names ≤ 40 ms total, sliced | one tokenise pass + `Set` lookups; at most 3 regexes per name |
| Full index, 20k nets / 100k pins | ≤ 30 ms, sliced into ≤ 8 ms idle chunks | one pass over `pinNets` |
| Incremental edit (1–50 items) | ≤ 1 ms | touched nets and stem buckets only |
| Suggestions refresh | ≤ 2 ms per touched stem bucket | |
| Memory | ≤ 3 MB at 20k nets | readings are shared frozen objects |

This is not a Rust/WASM candidate: there is no hot loop, and the cost is dominated by `Map` lookups.
Add `tests/perf-net-intent.cjs` to the perf stage with the 20k-net synthetic board, failing at 2× the
budget.

## 12. Tests

- **`tests/checks/net-intent.cjs` golden corpus.** A table of about 500 names with the expected role,
  voltage, polarity, partner and activeLow. It deliberately includes:
  - every name in §2's table
  - negative cases: `CAP/CAN`, `STEP/STEN`, `VCC_EN`, `3V3_PG`, `LDO2VIN`, `VDD_CORE_2`, `DM0`
    (DDR), `ENC_A/ENC_B`, `UART_TX/UART_RX`, `V+/V-`, `+12V/-12V`, `SPEED_H/SPEED_L`, `XRST` vs `XIN`
  - each tool's auto-names
  - `~{CS}`, `R\S\T\`, overline, `/Power/3V3`, `3,3V`, full-width
- **Real-world corpus.** Run over the net names in `scripts/compat-corpus.py`'s project set. The test
  asserts no regressions against a checked-in snapshot of results; a diff must be reviewed and
  re-snapshotted, like the compat guard.
- **Property tests.** For every `pairMember`: `partner(partner(n)) === n`, and polarity flips sign. For
  every rail: `voltage(read(n))` is stable under case changes and separator swaps (`3V3` = `3v3`;
  `VCC_3V3` = `VCC-3V3`).
- **Consumer consistency.** `rules.detectDiffPairs`, `diffpair.pairs` and the ECO directive polarity
  agree on one fixture board. This is the regression test for today's three-list bug.
- **Old-regex audit.** For each migrated module, list the corpus names whose power/ground answer
  changed. Every change must appear in an allowlist with its reason, for example "VCC_EN: railSignal,
  not rail".
- **Index incremental equivalence.** After a random sequence of edits, rename, add-pin and library swap,
  the incremental index equals a fresh full build. This mirrors the insights engine's tests.
- **Insights tests** in `tests/checks/insights.cjs`, one positive and one negative fixture per new check,
  including the FP mitigations: PCIe polarity inversion quiet, inverter in path quiet, unknown cap
  rating quiet.

## 13. Phased rollout

| Phase | Scope | User-visible |
|---|---|---|
| **P0 Unify** | `net-intent.js` (`read`, `pairs`, `voltage`, `activeLow`, `isRail`/`isGround`); migrate the three pair sites and the regex copies; the corpus and consistency tests | USB_DP/USB_DM, CANH/CANL, CK_t/CK_c and TXP0/TXN0 detected; CAP/CAN no longer paired; ECO accepts USB_DP/USB_DM; decoupling stops treating `VCC_EN` as a rail |
| **P1 Suggestions** | `net-intent-index.js`; suggestions into the Signal model; accept/decline; Altium "Create from nets" uses it; MCP `net_intent` tool (headless parity) | "Suggested pairs, rails and buses" in the Signals panel; no canvas UI |
| **P2 Insights, low FP** | `pairSwap`, `pairOrphan`, `railConflict`, `railPinMismatch`, `capRating`, `busGap`, `isolationBridge`; `ctx.highSpeed` uses roles | new hints, on by default |
| **P3 Insights, geometry/med FP** | `creepage`, `clockEdge`, `crystalFar`, `activeLowPull`, `activeLowMismatch`, `txToTx`, `splitGroundJoin`, the widthCurrent extension; regulator-output voltage evidence | new hints, the medium-FP ones at `tip` |
| **P4 Learning, domains** | convention inference UI ("Naming" section), never-lists, import/export of conventions, `splitCrossing` with pin-to-domain mapping | |

P0 does not depend on the Signal model and can land now. P1 depends on the Signal agent reserving
`intent`, `declined` and `conventions`.

## 14. Open questions for the user

1. **RS-485 A/B polarity.** Default to the vendor convention (A = non-inverting, the common
   datasheet usage), or always ask?
2. **Inferred intent in insights.** OK for insights to act on inferred intent at `likely` without
   confirmation, as long as messages say "by its name"? The alternative is strong-only, which is
   quieter but misses most name-only boards.
3. **Company naming dictionary.** Do you want one shared across projects, as an explicit import into
   each project, or is per-project learning enough?
4. **Creepage defaults.** Which standard and conditions: IPC-2221B B2 external uncoated, or IEC 62368
   / 60950 for mains products? Should mains detection (`AC_L`/`N`/`LINE`) be on by default?
5. **`_N` default.** For a project with no convention evidence yet, should a lone `X_N` default to
   active-low (my proposal, for control stems only) or stay unknown?

## 15. Phase 0: implementation and integration notes

Phase 0 has landed as new files only: `app/net-intent.js` (`AtriumNetIntent`),
`tests/checks/net-intent.cjs` and `tests/fixtures/net-intent/corpus.json`. No existing module calls it yet.
Line numbers below refer to the working tree used for the 20 November 2026 design and
may drift.

### What shipped versus §3–§11

- **API:**
  - `read(name)` returns a frozen reading: `role`, `level`, `explain[]`, `tokens` and the role's
    attributes from §3.3.
  - `pairs(nets, existing, {min})` keeps the `detectDiffPairs` contract and adds the fields
    `pattern`, `level`, `known` and `explain` to each pair.
  - `orient([a, b])`, `polarity(name)`, `voltage(name)` and `explain(name)`.
  - `isGround`, `isRail`, `isSupply` (rail or ground), `isClock` and `isHighSpeed`.
  - Every result is memoised by string, with a 50k-entry cap and clear-on-overflow, and is
    deterministic.
- **Roles.** `pairMember` readings are `weak` alone and `likely` once `pairs()` finds the partner.
  RS-485 `A/B` pairs come back only with `{min: "weak"}`, as `known: false`. A control stem followed
  by `_N` (`RST_N`, `SPI1_CS_N`) reads as active-low `control` and keeps a `pairMember` reading in
  `alt`. It becomes a pair only when its `_P` exists.
- **Not in phase 0:**
  - The connectivity index (`net-intent-index.js`), suggestions, learning and conventions (§4–§6).
  - `activeLow(raw)` for pin names. `symbol-wizard.js` keeps its own; net names get active-low
    through `read().activeLow`.
  - Leading-sign analog pairs (`+IN`/`-IN`).
  - Integer-only rail voltages (`VCC5`, `VDD33` stay `voltage: null`, on purpose).
- **Size.** 16.2 KB of source (6.9 KB gzipped), against the 14 KB target. The dictionaries and the
  `explain` text are most of it. It adds 0 eager bytes. If 14 KB is firm, dropping the mains and
  frequency grammar saves about 1 KB.
- **Cost** (`tests/checks/net-intent.cjs`): 20k distinct names read cold in 41 ms under Node and 52 ms under
  JSC, about 2–2.6 µs each. A warm re-read takes 0.6 ms, and `pairs()` over 20k names about 10 ms.

### Loading

| Where | Change |
|---|---|
| `app/lazy.js:123` | `register` or add `AtriumNetIntent: {scripts: ["net-intent.js"]}`, and add `"AtriumNetIntent"` to the `deps` of `AtriumRules` (line 123), `AtriumECO` (133), `AtriumXSignals` (238) and `AtriumInsights` (243). `AtriumRouter` inherits it through `AtriumRules`. |
| `mcp/board-runner.js:97`, `mcp/headless.js` `need(...)` sites, `app/release.js:232` | `require("../app/net-intent.js")` before `rules.js` (or add `["AtriumNetIntent", "net-intent.js"]`). |
| `app/route-suggest-worker.js:15`, `app/diff-worker.js:11` | add `"net-intent.js"` before `"rules.js"` in `importScripts`. |
| `types/baseline.json` | add `app/net-intent.js` with `// @ts-check` once the JSDoc pass is done. It is not type-checked today. |

Every replacement below should keep a fallback, `globalThis.AtriumNetIntent?.x(...) ?? <old code>`,
for one release. Worker bundles and old headless lists then keep working.

### Diff-pair sites

| Site | Replacement | Behaviour change |
|---|---|---|
| `app/checks/rules.js:592–607` (`SUFFIXES`, `detectDiffPairs`) | `function detectDiffPairs(nets,existing=[]){const N=globalThis.AtriumNetIntent;if(!N)return legacyDetect(nets,existing);return N.pairs(nets,existing).map(({name,positive,negative})=>({name,positive,negative}));}`. Keep only the three fields so "Create from nets" never writes `explain`/`level` into `rules.diffPairs`. | **New pairs:** USB_DP/USB_DM, CANH/CANL, CAN_H/CAN_L, CK_t/CK_c, DQS_t/DQS_c, TXP0/TXN0, TX_P0/TX_N0, `…_P_C`/`…_N_C`, SATA_RXP/RXN, SENSE_POS/NEG, ADC_INP/INM. **No longer paired:** CAP/CAN, STEP/STEN, or any bare P/N whose stem is not serial (TX, RX, CLK, REFCLK, CK, D, DQS, DATA, LANE, ML, MDI, LVDS, IN, AIN, VIN, VREF). **Ambiguous** (USB_DP with both USB_DM and USB_DN): no pair, where the old code took the first. `tests/checks/rules.cjs:89–91` passes unchanged. A duplicate name now gets `_1` after the cleaned stem (`USB_1`), where the old code produced `USB__1`. |
| `app/diffpair.js:16` (`SUFFIX`) and the loop at `:36–44` | Delete both. The `R.detectDiffPairs(...)` call at `:31–35` already covers name pairs. | `_H/_L` pairs are now only CAN (CAN_H/CAN_L, CANH/CANL). LED_H/LED_L and SPEED_H/SPEED_L stop routing as pairs. Router and DRC now agree on which name pairs exist. |
| `app/eco.js:494–495` (`directives()` pair polarity) | `const list=[...nets],o=list.length===2&&globalThis.AtriumNetIntent?.orient(list);` then `if(!o){cx.issues.add(…same message…);continue;}` and `after={name,positive:o.positive,negative:o.negative}`. When `o.known===false` (A/B), also add an issue: "Differential pair NAME: A taken as positive; check the transceiver's datasheet." | A `USB` directive on USB_DP/USB_DM, a CANH/CANL directive or a CK_t/CK_c directive is now accepted (today it is rejected). `SIGP`/`SIGN` and `X+`/`X-` directives still work through the final-letter fallback. |

### Net-class sites (the POWER/GROUND regex copies)

The old `POWER` regexes included grounds, so `POWER.test(n)` maps to `isSupply(n)`. `isPower` (power
and not ground) maps to `isRail(n)`.

| Site | Replacement |
|---|---|
| `app/insights.js:101–104, 107, 263, 494` | `const NI=G.AtriumNetIntent; isGround=n=>!!n&&NI.isGround(n); isPower=n=>!!n&&NI.isRail(n);` `fastName`: `!NI.isSupply(n)&&(NI.isHighSpeed(n)\|\|FAST.test(n)\|\|…)`; line 263: `if(!net\|\|NI.isSupply(net))return false;`. Keep exporting `POWER`/`GROUND` as `{test:NI.isSupply}` / `{test:NI.isGround}` for one release (line 212 `ctx`, line 494 `nets`). |
| `app/si.js:58` / `:727` | `!NI.isSupply(n)` |
| `app/return-path.js:23` / `:66` | `!NI.isSupply(i.net)` |
| `app/xsignals.js:32` / `:120, :135` | `NI.isSupply(net)` |
| `app/topology.js:27` / `:170, :261` | `NI.isSupply(n)` |
| `app/length-tuning.js:628` / `:653, :663` | `NI.isSupply(net)` |
| `app/autoplace.js:48–51` | `isGround=n=>NI.isGround(n\|\|""); isPower=n=>!!n&&NI.isRail(n);` (drop the `AtriumAutorouter.POWER` fallback) |
| `app/autorouter.js:1394` (exported `POWER`, used by `fanout.js:139, :318` and autoplace) | `const POWER={test:n=>globalThis.AtriumNetIntent?.isSupply(n)??OLD.test(n)};` so `AU.POWER.test` callers keep working |
| `app/pdn.js:691–692, 779, 792` | `isGround=n=>NI.isGround(n\|\|""), isSupply=n=>!!n&&NI.isRail(n)`; `rank` at 779 uses them |
| `app/pdn.js:794` (`voltageOf`) | `const voltageOf=name=>NI.voltage(name);`, plus a rail's `nominal` (VBUS → 5) for the PDN default: `NI.voltage(n)??NI.read(n).nominal??null` |
| `app/plane-planner.js:28–33` | as pdn: `isGround`→`NI.isGround`, `isSupply`→`NI.isRail` |
| `app/support-placement.js:34–37` | `isGround=n=>NI.isGround(String(n\|\|""))`, `isPowerName=n=>!!n&&NI.isRail(String(n))` |
| `app/via-fence.js:41` / `:500, :502, :505, :1095` | `GROUND.test(x)` → `NI.isGround(x)` |
| `app/stress.js:71` / `:76` | `NI.isGround(n.replace(/^[\\/]/,""))` (`PE`, `COM`, `SHIELD`, `EARTH`, `0V` are covered; `COM` reads as a `weak` ground) |
| `app/polygon-pour.js:1082–1083` / `:1152, :1158` | `ground=NI.isGround(net)`, `!ground&&NI.isRail(net)` |
| `app/arrange.js:29` / `:175` | `!NI.isSupply(net)` |

Keep as they are: `insights-sch.js:148 POWER_PIN`, `library-panel.js:32–33` and `symbol-wizard.js:61`.
They classify **pin** names. Also keep `route-planner.js:29 POWER_CLASS`, which classifies net-class
names.

### Expected behaviour changes from the net-class swap

- **These now count as signals.** Insights, SI, return-path, xSignals, topology and length tuning start
  to see them:
  - rail signals: VCC_EN, VDD_PG, 3V3_PG, VBUS_DET, VIN_SENSE, 12V_EN, VBAT_SENSE
  - ADC inputs: VINP, VIN_N
  - `+…` names that are not rails, such as `+IN`
- **They also stop counting as rails.** `decoupling` and `widthCurrent` no longer treat them as
  supplies, and `pdn.guess` stops proposing them.
- **These become grounds:**
  - grounds that are not first in the name, such as ISO_GND and MOTOR_GND (two regex copies already
    took `X_GND`)
  - returns, such as 24V_RTN
  - `PE`, `COM` (weak) and `SHIELD`, in the modules whose regexes lacked them
- **Voltages:** `3,3V` becomes 3.3 V; LDO2VIN, VDD_CORE_2 and 12V_EN have no voltage. The values in
  `tests/analysis/pdn.cjs:111` are unchanged.
- **Rails that are no longer rails** in `polygon-pour.js` only: `VOUT`, `VS`, `VDC` and `VSUPPLY`
  (its regex accepted them). The pour "power net name" hint stops firing for them; DAC_VOUT is the
  reason. If that matters, add `VOUT`/`VDC`/`VSUPPLY` to `RAIL` in net-intent.js; it is a one-word
  change plus a corpus case.
- **Tests to re-run after the swap:** rules, pdn, insights, si, return-path, xsignals, length-tuning,
  topology, autoplace, plane-planner, support-placement, via-fence, stress, polygon-pour, arrange,
  fanout, eco and diffpair. Fixtures with names like VCC_EN or VINP are the likeliest to change counts.

## 16. Phases 1 and 2: implementation notes

Landed 2026-11-20 as new files plus small hooks. No `signals.js` change: the store edits go through
`AtriumSignals.edit`, and suggestions read `effective` / `fromLegacy` for the nets signals already hold.

| File | Global | Contents |
|---|---|---|
| `app/net-intent-index.js` | `AtriumNetIntentIndex` | `facts` (per document on the undo journal: a board part is patched alone, a sheet is re-read only for an electrical edit; names, pins with names, two-pin parts, two names on one net), `conventions` (learned styles, §6.2), `classify` (the reading with the project dictionary and choices), `suggest` (diff / bus / rail / ground, recomputed per stem bucket whose names changed), `complete`, `accept` / `decline` / `restore`, `conventionEdits`, MCP `conventions` / `complete` |
| `app/insights-intent.js` | `AtriumInsightsIntent` | `pairSwap`, `pairOrphan`, `railConflict`, `railPinMismatch`, `capRating`, `busGap`, `isolationBridge` (+ `isolationBridgeBoard`), `nameSuggestion`; registered with `AtriumInsights`, so the check registry lists them as `schematic.hint.*` / `layout.hint.*` |
| `app/naming.js`, `naming.css` | `AtriumNaming` | the Naming view (Signals panel › Naming) and inline name completion |

Loading: `AtriumNetIntent` now loads `net-intent-index.js` too; `AtriumInsights` loads
`insights-intent.js`; `AtriumNaming` is registered on its own. Eager JS is unchanged (lazy.js comments
were shortened to pay for the three entries).

**Store shapes.** `signals.declined[key] = {date, kind, name, pattern?}`; keys are
`diff:<hash of the sorted nets>` (as before), `bus:…`, `rail:…`, `ground:…`. A dismissed
`nameSuggestion` hint counts as a decline. `signals.conventions`:

```js
{keep: {rail: {stem, sign, mark, zero, id}, activeLow: "n", pair: "P/N", bus: "n", case: "upper"},
 forget: ["rail"],                                  // learned styles not to apply
 stems: {rail: ["VPROG"], ground: ["GND_MOT"], clock: ["SYSREF"]},
 never: {pair: ["A/B"], bus: ["LED"], rail: ["VSEL"], kinds: ["rail"]},   // never.rail: "not a rail"
 loneN: "activeLow" | "pair", rs485: "B",           // absent: active low; A is non-inverting
 tally: {"diff:A/B": [accepted, declined]}}         // three declines, no accept: "Stop suggesting?"
```

Accepting writes the Signal with `intent: {role, …, source: "name", confirmed: <date>}` (rails and
grounds: a single-ended signal with `span: false` and the tag `Power` / `GND`; a bus: single signals for
its members and a `bus` signal). Only those confirmed fields are `user` intent.

**Decisions applied.** Insights act on name-only intent and say so ("by its name", "by pin D+ on J1");
all are hint tier. RS-485 A is non-inverting unless the Naming view says otherwise; a suggestion asks only
when two parts on the A line name it differently. A lone `X_N` control name is active low unless the
project chooses otherwise (or shows five `_N` names that all have a `_P`). Creepage (P3) is not built yet.

**Completion.** Net label, power port, port and off-sheet names complete in the placement popover (Tab
while placing) and in Properties: the best name is drawn as faint text after the caret (the field keeps
only what was typed), Tab takes it, ↑/↓ choose another, a line under the field says why. Candidates:
existing names by use, the missing partner of a pair member, the next or missing bus member, a typed
voltage in the project's rail style (2.5 → 2V5), a control word in its active-low style (wp → nWP).

**Cost** (Node, 20k names, no journal): facts 40–60 ms, suggestions 130 ms, completion 50 ms; with the
journal an edit re-reads one sheet or patches one board part, and suggestions recompute touched buckets.
Intent insights on 2000 nets: about 40 ms cold.

**Not done (in P1/P2).** Altium "Create from nets", the P3 checks and import/export of conventions:
see §17. Regulator-output voltage evidence is still open.

## 17. Phase 3: creepage and clearance by voltage; conventions files; Create from nets

Landed 2026-11-20. New: `app/creepage.js` (`AtriumCreepage`, loaded with `AtriumRules`, 0 eager bytes
beyond its 15-byte entry in `lazy.js`), `tests/checks/creepage.cjs`. Small hooks: `rules.js` (the `creepage`
rule type, its DRC hook line, no default rule), `checks.js` (`layout.creepage` in the registry),
`drc-view.js` (online DRC's window grows by the rule's reach), `insights-intent.js` (the
`isolationRating` hint; installs the layout hint), `net-intent-index.js`, `naming.js`, `signals-panel.js`,
`mcp/board_runner.py` and `mcp/automation.py` (the module for `check`, `run_drc` and `list_insights`).

### Working voltage per net

`AtriumCreepage.voltages(project, board).of(net)` returns `{dc, ac, mains, ground, earth, domain, iso,
level, basis}`, memoised on the project facts (net-intent-index.js), the conventions and the signal model.
First match wins:

| Level | Source | Basis text |
|---|---|---|
| user | a tag on the net with a `Voltage` parameter (`"400"`, `"230 VAC"`), or `Mains: yes`, or a tag named as a voltage or mains (`400V`, `230VAC`, `Mains`) | "by tag HV" |
| user | the net's signal: a `Voltage` parameter, or `intent` confirmed as a rail (with a voltage), ground or mains | "by signal BUS12" |
| strong | a mains connector: a connector part (J, CN, CON, X, XS, TB, PL, SK, K) with pins named L and N, or whose value or library text says AC inlet, IEC 60320, C13/C14, power entry …; its PE / E / EARTH pin is earth | "by pin L on J1", "by connector J2" |
| strong | a power port carrying the name | "by its power port" |
| likely | the name (net-intent.js with the project dictionary): rails with a voltage (or VBUS's nominal 5 V), grounds (PE, EARTH, CHASSIS are earth), mains names (AC_L, LINE, 230VAC; AC under 100 V is not mains) | "by its name" |

Nets without a voltage (signals, VCC, sense lines) get none. An isolated domain (GND_ISO, a rail with the
ISO variant) has no common reference with the main one.

### Pairs and requirements

`pairOf(a, b, settings)`: mains against mains (L–N) and against earth is basic insulation; mains against
any other circuit is the rule's *Mains to other circuits* (reinforced by default), at the mains voltage
plus the other net's (named mains voltage, else the rule's *Mains voltage when not named*, 250 V RMS);
other pairs are functional insulation at basic values (or not checked), from the rule's *Check from*
voltage (30 V). Two grounds, or nets in different isolation domains, are not compared by voltage.

`required(settings, {rms, peak, mains, insulation, surface})`:

- **IEC 62368-1 (default)**: creepage from Table 17 by RMS working voltage, pollution degree and material
  group (IIIb default), doubled for reinforced; clearance from the required withstand voltage (the mains
  transient of Table 12 for the overvoltage category, II default, or the peak working voltage, at least
  330 V) in Table 14; reinforced takes the larger of twice the basic clearance and the next impulse step.
- **IEC 60664-1**: the same, with Table F.5's printed-wiring columns at pollution degree 1 and 2, and
  reinforced clearance one step up the preferred series (or 160 %).
- **IPC-2221B**: Table 6-1 by peak voltage; B1 on inner layers, the rule's column (B2 default; B3, B4,
  A5) outside; clearance and creepage are the one spacing.
- Creepage is never below the clearance. Values between rows step up to the next row (both IEC standards
  also allow linear interpolation; stepping up is conservative). Inner layers: no clearance requirement,
  creepage at pollution degree 1 (a cemented joint, approximated).

### Geometry and the approximation

Clearance is DRC's own geometry (`AtriumRules.kit`: extract, closest segments, convex containment), plus
Waffle polygon pours as regions (`AtriumPCBPours.contours`). Creepage is a surface path: the straight
gap, unless the straight segment between the closest points crosses a board cutout at least the groove
width X wide (IEC 60664-1 Table 2: 0.25 / 1.0 / 1.5 mm at pollution degree 1 / 2 / 3; the cutout's width is
its convex hull's). The path then goes round the cutouts through their corners (Dijkstra over the corners;
chords that cross a cutout are not taken). The legs from each copper feature to the first and from the last
corner are not tested against other cutouts, so the path is a lower bound of the true one (conservative).
A cutout narrower than X, slots inside pads, V-grooves and conformal coating are not modelled; IPC-2221B
takes no slot credit. Pairs on opposite sides of the board are through solid insulation and not checked.

### Rule and hint

- **Rule** `creepage` (Design › Rules › Electrical › Creepage Distance; two scopes; in the project rule
  book, so its severity, standard, pollution degree, material group, overvoltage category, insulation,
  mains detection, check voltage, IPC column and the treatment of nets without a confirmed voltage are
  edited in the Rules and Constraints Editor). DRC reads confirmed (user) voltages only: a pair is checked
  when one net's voltage is user intent; grounds count as 0 V, other nets as 0 V (or not checked). Per-net
  overrides are tags (`Voltage` parameter or a voltage name), and the rule's scopes can narrow it to tags.
  Violations are DRC's shape (`type: "creepage"`, `what: Creepage | Clearance`, measure, both objects),
  so the unified violation (`layout.creepage`), markers, the inspector, cross-probe, waivers, Problems and
  MCP `check` / `run_drc` take them as they are.
- **Hint** `layout.hint.creepage`: the same question where the voltage comes from names, power ports or
  connectors (pairs a rule checks with a confirmed voltage are left to DRC); always the hint tier, `tip`,
  or `advice` for mains, confirmed voltages and isolation barriers; every message names the standard, the
  insulation, the conditions and each net's basis. Nets without a voltage are not guessed.
- **Isolation barrier**: `schematic.hint.isolationRating` asks for a `Creepage` parameter on a part with
  three or more pins on an isolated and another ground domain. With it, the layout hint holds copper of
  the isolated domain to that rating against the main one ("across the isolation barrier of U1, rated 8 mm
  by its parameter").

### Incremental and lazy

Nothing runs at startup. The hint is an `area` check with a small registered reach (0.5 mm): an edit
re-checks the pairs of the changed objects against anything within the board's reach (computed once per
set of facts from the voltages present), and the unchanged pairs whose finding lies in the edit's window;
everything else is kept. An edit away from every high-voltage net extracts nothing. In DRC, online runs
re-check the edit's neighbourhood grown by the rule's reach. Measured (`tests/checks/creepage.cjs`, Node, an
800-feature board): full pass 234 candidate pairs in about 3 ms; an edit next to the 400 V net 24 pairs in
about 1.5 ms; an edit away from it 0 pairs. The 20k-feature figures are in the cost test.

### Table values read with less certainty

All values come from the published tables as recalled; none was invented. These readings are marked in
`AtriumCreepage.tables.UNCERTAIN` and chosen to be conservative:

1. IEC 62368-1 Table 17 is taken as IEC 60664-1 Table F.5's general columns (same values), without the
   printed-wiring reduction.
2. IEC 62368-1 Table 14 clearance is taken as IEC 60664-1 Table F.2 case A; reinforced is the larger of
   twice the basic value and the next impulse step.
3. IPC-2221B above 500 V: the 500 V value plus the per-volt figure for the volts above 500 (the B1, B4 and
   A columns' per-volt figures do not continue their 500 V rows).
4. Beyond the tables (creepage above 1000 V, impulse above 12 kV): in proportion to the voltage.

### Conventions files

Signals › Naming › Share: **Export…** writes `<project>.atrium-naming.json`
`{format: "atrium-naming", version: 1, project, conventions: {keep, forget, stems, never, loneN, rs485}}`
(no tallies, no declines). **Import…** reads one, validates and cleans it (words upper-cased, junk and
duplicates dropped; a newer version is refused), and previews the merge: words added, kept styles and
choices added or replaced (or kept: "Where the file and this project differ: use the file's / keep this
project's"). Import applies it as one undo step (`net-intent-index.js` `exportConventions`, `planImport`,
`importConventions`). The group-wide dictionary will reuse the file through the shared library.

### Create from nets

Signals panel › **Create from nets…** (Altium's Create From Nets): an inline chooser (no pop-up) of the
board's nets, checked from the selection, with a filter; Differential pair (two nets, polarity by name or
as chosen; or every name pair among more nets), Bus (natural order) or Tagged group; a live preview; Create
is one undo step through `net-intent-index.js` `createFrom`, which writes the same records and tallies as
accepting the matching suggestion (`intent.source: "user"`, confirmed today). The Rules editor's
Differential Pairs "Create from nets…" keeps its classic behaviour for boards without a signals store.
