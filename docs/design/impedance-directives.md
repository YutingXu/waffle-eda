# Impedance directives on schematic nets

Original design proposal, 20 November 2026. It targets the [shared signal model](signal-model.md), where nets describe connectivity and signals describe intent. It maps onto conventional net classes, differential pairs and rules when needed.

The idea: a designer drops a small **"90 Ω diff"** or **"50 Ω SE"** marker on a net, pair or bus in the
schematic. Update PCB turns it into a routing constraint. The board's stack-up solves width and gap per layer.
DRC and Design Insights then check the copper against that intent.

## 1. What already exists (and what doesn't)

The PCB half is mostly built. This proposal is mainly about the schematic object, the ECO bridge and the
checks.

| Piece | Where | State |
| --- | --- | --- |
| Closed-form solver (H&J, Cohn, Wheeler, K&J, CPWG), `synthesize` by width or gap | `app/impedance.js` | have |
| Impedance profiles `{id, name, type: single/diff/cpw/cpw-diff, target, tolerance %, stack?, layers:{KEY:{width?, gap?, ground?, reference, etch, enabled}}}` | `app/stackup.js` (`cleanProfile`, `resolveProfileLayer`) | have |
| Per-substack (rigid-flex) resolution: `profileValues(doc, id, key, defs, stackId)`, `profileAlong` | `app/stackup.js` | have |
| Width and Diff Pairs Routing rules can name `impedanceProfile`; the resolver turns it into min/preferred/max width and gap per layer | `app/rules.js` `profileAt` / `constraint` / `resolver` | have |
| DRC "Impedance width" and "Impedance gap" violations, with Z in the message | `app/rules.js` ~1064, `diffPairCheck` | have |
| Interactive router asks for width and gap per layer and `at` (so per region) | `app/router.js` `diffPair()` | have |
| Constraint Manager "Z profile" column | `app/constraints.js` | have |
| Schematic `netClass` / `diffPair` *properties* on labels, ports and wires, turned into `netClass` / `diffPair` ECO changes | `app/eco.js` `directives()` | have, but invisible: there is no placed directive object. It is set by MCP (`sch-author.js`) or import |
| Schematic impedance intent | — | **missing** |
| Profiles created or kept in sync from the schematic | — | **missing** |
| Altium parameter sets (SchDoc record 43) | `app/sch-import.js` | **dropped on import** |
| KiCad `netclass_flag` / `directive_label` | `app/import-kicad.js:610` | **dropped** ("Net class directives omitted") |
| Altium impedance-driven Width / DiffPairsRouting fields, stack-up profiles in PcbDoc | `fromAltium`, `pcb-import.js layerStack()` | **not read** |
| Neck-down budget, reference-plane continuity tied to the profile's reference | partly `insights-pcb.js returnPlane` | **partial** |

**Principle.** The schematic owns *intent*: target Z, kind, tolerance, and optionally which layers or zones.
The PCB owns *geometry*: stack-up, reference choice, gap policy, solved widths. Widths never appear on the
schematic, and solved values are never stored. They are derived from the stack-up on demand, as
`resolveProfileLayer` does today, so a stack-up edit cannot leave stale numbers behind.

## 2. Data model

### 2.1 The impedance spec

The spec is one small, plain object. It sits on a Signal or a tag (Signal model) or on a directive item (schematic):

```js
impedance: {
  target: 90,              // ohms; differential for kind "diff", Z0 for "se"
  kind: "diff",            // "se" | "diff"
  structure: "auto",       // "auto" | "cpw" (coplanar ground): maps to profile type cpw / cpw-diff
  tolerance: 10,           // % spec tolerance (what the fab note says)
  window: null,            // % DRC design window; null = tolerance / 2 (see §5.2)
  layers: null,            // null = every routable copper layer; or ["outer"] / ["inner"] / ["L3","L4"]
  zones: null,             // rigid-flex: null = every substack; or {flex: {...override}} by substack name/flag
  overrides: [             // multiple targets, rare but real
    {layers: ["outer"], structure: "cpw"},
    {layers: ["inner"], target: 85}
  ],
  neck: {maxLength: 2.5, minWidth: null},  // mm of off-target copper per signal end (pad/BGA escape)
  profile: null            // optional: bind to an existing stack-up profile by id/name instead of auto
}
```

Rules for the spec:

- `kind` and the Signal must agree. A `diff` spec on a single-ended signal is an ERC error with a fix:
  "Make pair with USB_DN".
- The inheritance order is signal > tag > board default. A signal-level spec replaces a tag spec as a whole.
  The two are never field-merged, because a merged spec is hard to read at a glance.
- Two directives that reach the same signal with different specs give an ERC **error**. Neither spec is applied,
  so the ECO is not ambiguous. The same spec placed twice is fine. Designers often repeat a directive on each
  sheet where the net appears.

### 2.2 The schematic carrier

There are two carriers. Both feed the same collector, an extension of `eco.directives()`.

1. **Directive item** (new `kind: "directive"`). This is a flag on a stick with a hotspot, like Altium's
   Parameter Set. It is electrical only through its hotspot touching a wire, bus, label, port, sheet entry or
   harness entry. It can carry `impedance`, `netClass`/`tags`, `diffPair` and later other rule intent. This
   finally gives the existing `netClass`/`diffPair` properties a visible home.
2. **Property shorthand** on labels and ports (`item.impedance = "90d"`). This is what MCP, KiCad and Altium
   imports produce first. The Inspector offers "Show as directive", which places the flag at the label.

Both carriers use one text grammar. The typed text and the stored text are the same string, so a
copy-paste or MCP call round-trips:

```
50            50 SE            50Ω se ±10%        90d          90 Ω diff ±7%
100 diff cpw  90 diff; inner 85           90 diff; outer cpw; flex 100 cpw
```

Grammar: `number [Ω|ohm] [se|single|diff|d] [cpw] [±N% | +/-N%]`, then `;`-separated
`scope target-or-structure` clauses. A scope is `outer`, `inner`, a layer name or key, or a substack name.
Parse errors keep the raw text and show it in red. Nothing is silently dropped.

## 3. The schematic object

### 3.1 Look

The flag must read at a glance at sheet zoom and never be mistaken for a net label.

- **Shape.** A rounded pill with a small left notch and a 1-grid stick to the hotspot dot. It uses the
  directive colour family, teal by default and themeable, distinct from net labels (black) and ports.
- **Text.** The number is in bold, then a kind glyph, then the tolerance in a lighter weight:
  `50 Ω ─ ±10%` for single-ended, `90 Ω ═ ±10%` for differential. The glyph is one or two short parallel bars.
  CPW adds a small `⊥⊥` suffix. Overrides collapse to `90 Ω ═ +1`, and the Inspector lists them.
- **Status dot**, after the first ECO. It is visible without hover, because this user does not want hover
  pop-ups:
  green = solved on every targeted layer, amber = unreachable or excluded on some layers, red = no
  layer can meet it, hollow = not yet synced to a board. The dot is driven by the linked board. A sheet with
  no board shows hollow.
- **Bus or harness placement** draws the flag with a small `×N` count, for example `90 Ω ═ ×4` on
  `PCIE_TX[0..3]_P/N`.

### 3.2 Placement and what it applies to

| Placed on | Applies to |
| --- | --- |
| Wire / net label / port / power port / sheet entry | The **Signal** containing that net. Across series passives that means the whole xSignal, which is correct for AC-coupled PCIe or a series-terminated clock. |
| One net of a pair, kind `diff` | The diff Signal containing the net. If there is none: an ERC error with the fix "Pair with …" (P/N guessed from names as `directives()` does today). |
| Bus | Every member. A `diff` spec pairs members by index stem (`D0_P`/`D0_N`), and anything unpaired is reported. |
| Harness connector / harness entry | Members of that entry. On a harness the spec flows through the harness type, so it is defined once. |
| Sheet symbol | Not allowed. It is too easy to blanket a whole sub-sheet by accident. Tags cover that case. |

There are two ways in: **Place › Directives › Impedance** (`P V Z`), which is the Altium-shaped way, and a
right-click "Set impedance…" on a selected net, pair or bus, which places the flag at the clicked point.
Both open an inline field with the last-used text preselected. Enter commits. Pressing the key again
repeats the last spec, which suits a designer who places many directives in a row.

### 3.3 Editing

The **Inspector** has a kind toggle, target, tolerance, structure, an overrides table and the neck budget. The raw text
stays editable. Below them is a **read-only per-layer table** from the linked board: layer, structure,
reference, width, gap and achieved Z, or the reason it cannot be met. The table is computed lazily when the
Inspector opens.

The Inspector also shows the signal's whole membership ("applies to USB_DP, USB_DN, USB_C_DP, USB_C_DN
through R12, R13"), so a directive's reach is never a surprise.

## 4. Propagation through ECO

### 4.1 Signal model path (target)

There is one new change action, `signalImpedance`, in a new **Impedance** group. Its `before`/`after` are the
spec, and the change row text says what it does:

```
Impedance   Signal USB_D     —  →  90 Ω diff ±10%
            ↳ Profile "Z90D" (new): Top 0.110/0.150 · L3 0.089/0.200 · Bottom 0.110/0.150   (w/s mm)
            ↳ L2 GND reference, L4 not targeted (plane)
Impedance   Tag  DDR_DQ      50 Ω SE  →  45 Ω SE ±10%     (16 signals)
```

The **solved per-layer values shown in the ECO preview** are the most useful part for this user. You can
see what the schematic change means in copper before accepting it. The values are derived and only
displayed, never stored in the change.

On execute, the action sets `signal.impedance` (or `tag.impedance`) and ensures a profile exists (§5.1). It
does **not** write Width or DPR rules. Under the Signal model the resolver reads the spec from the signal
directly. Rules scoped to signals or tags still win where the user wrote them.

### 4.2 Degraded path (today's rules)

Without the Signal model, the same directive produces ordinary, Altium-shaped objects:

| Spec | Creates (all tagged `origin: {directive: true}`) |
| --- | --- |
| `50 Ω SE` on nets A, B | net class `Z50` (existing `netClass` action) + Width rule `Impedance Z50`, scope `InNetClass('Z50')`, `impedanceProfile: "Z50"` |
| `90 Ω diff` on pair USB | diff pair `USB` (existing action) + diff pair class `Z90D` + DPR rule `Impedance Z90D`, scope `InDifferentialPairClass('Z90D')`, `impedanceProfile: "Z90D"` |

New actions: `impedanceProfile` (add or modify a profile in `doc.stackup.impedanceProfiles`) and
`impedanceRule` (add or modify a generated rule). Class names include the tolerance only when it differs
from 10 % (`Z90D`, `Z90D_7`), so the common case stays readable.

**Priority.** Generated rules go above every rule of the same type scoped `All`, by net class or by net, and
below rules scoped by component, room or query. In practice those are BGA neck-down and breakout rules, and
they must keep winning. If a user rule still shadows a generated rule, a Design Insight says so by name:
"Width rule *Power* (priority 1) overrides the 50 Ω directive on VBUS_SENSE".

### 4.3 Ownership, renames, removal and the reverse ECO

- **Renames.** The directive is attached to a wire or label, so it follows the net. Class membership
  already follows planned renames in `directives()`.
- **Removal.** Deleting the last directive for a spec proposes removing class membership and the
  generated rule. The profile is removed only if it is generated and nothing else references it. Removal
  rows are pre-ticked only when nothing on the board would lose its constraint while copper exists. If copper
  exists, the row is unticked and explains why. This matches how `removeNet` treats copper.
- **Edited on the PCB.** If a user edits a generated rule or profile on the board, it becomes
  **detached**: `origin.detached = true`. ECO stops managing it and lists it once as "kept, edited on PCB".
  It never silently overwrites the edit.
- **Update Schematic from PCB.** A changed target on a generated, non-detached profile proposes the matching
  directive text change. A profile the user created on the PCB never invents schematic directives.
- **Idempotence.** A second ECO right after a first one must plan **zero** impedance changes. Change ids
  use the existing `changeId(action, key)` keyed by profile or signal name, so Never-sync rules work too.

### 4.4 Design diff

Diffs are a major feature, so impedance gets first-class diff kinds in `app/diff.js`:

| Kind | Example text | Severity |
| --- | --- | --- |
| `directive.impedance` | "USB_D impedance 90 Ω diff ±10% → ±7%" (schematic) | electrical |
| `stackup.profile` | "Profile Z90D: L3 gap 0.200 → 0.180 mm; reference L4 → L2" | electrical |
| `derived.solved` (opt-in, *Explain*) | "Z90D on L3: width 0.089 → 0.095 mm, because prepreg L3–L4 0.110 → 0.100 mm" | electrical |

Today `stackupDiff` folds every stack change into one "Stack-up changed" row, and profile edits are invisible
inside it. Profiles should get a keyed diff of their own. The derived row gives a causal chain from a
material change to the copper it moves. That is something neither Altium nor KiCad shows. It is computed only
for profiles the diff touches, so it stays lazy.

## 5. Rule generation: from profile to width and gap per layer

### 5.1 Profile matching and creation

1. If `spec.profile` names one, use it. If it is missing, that is an ECO issue, not a silent fallback.
2. Otherwise reuse an existing profile with the same type, target and tolerance, generated or not. A
   board imported from Altium usually already has "90 Ω USB", and we bind to it rather than duplicating it.
3. Otherwise create a profile with `id = Z90D` and a row for every copper `Signal` layer in `spec.layers`.
   Each row gets `width: null` (solved), the default references (nearest copper above and below, as
   `geometry()` picks) and the board's etch factor if a fab preset sets one.

### 5.2 Gap, limits and tolerance

The current solver picks `gap = clamp(h, 0.075, 0.5)` and solves width with limits 0.025 to 10 mm. That is
fine for a calculator but wrong for generated rules. The proposal:

- **Limits from the fab.** Width and gap bounds come from the board's fab preset (`fab-presets.js` min
  track and space) and the layer's Clearance rule. The hard-coded 0.025 mm does not.
- **Diff gap policy.** First fix the gap at `max(fab min space, clearance, 1.0·h)` and solve the width. If the
  width is below the fab minimum, pin the width at the minimum and solve the gap downward. If the gap then falls
  below the fab minimum space, the layer is **unreachable** (§6). The policy is stored on the profile row
  (`gapPolicy: "auto" | fixed mm`) so a user can pin it.
- **Two tolerances.** The spec tolerance (±10 %) is what the fab controls, and it goes into the fab drawing
  impedance table. If DRC used the whole ±10 % as the width window, it would accept a design that is already
  at +9 % before the fab's own scatter. The DRC window is therefore `window`, by default **half** the spec
  tolerance. Today `minWidth`/`maxWidth` come from `profile.tolerance`. The fix is one extra field. Existing
  hand-made profiles keep their current behaviour (`window = tolerance`) so no stored data changes meaning.

### 5.3 Rigid-flex

`resolveProfileLayer` already re-solves the width on a foreign substack, keeping gap, ground and etch. Rules
pass `stack` through `profileAt`, and DRC splits tracks with `piecesAlong`. What the spec adds:

- `zones` lets a directive say `flex 100 cpw`. That generates a per-substack override row, because flex
  commonly uses coplanar or hatched references.
- The ECO preview lists rows per substack ("Rigid · L3 0.089 mm, Flex · L1 0.140 mm CPW").
- **Hatched planes.** The closed-form solver models a solid reference. When the reference in a flex region is a
  hatched pour, the Inspector table and the insight show "≈, hatched reference: verify with field solver" next
  to the value rather than presenting the number as exact.

## 6. When the stack-up can't hit the target

Unreachable is a normal state with a clear explanation, not an error toast. It appears as:

- the amber or red status dot on the schematic flag,
- an ECO row note ("L2: needs 0.041 mm, fab minimum 0.075 mm"),
- a Design Insight with ranked, previewable fixes, each one a single undoable action:

| Suggestion | How it is computed |
| --- | --- |
| Don't route this signal on L2 | generates a Routing Layers rule for the signal (or tag) |
| Change gap to 0.12 mm | `synthesize(vary: "s")` at the fab minimum width |
| Use coplanar ground, g = 0.15 mm | solve with `structure: cpw` |
| Reference L4 instead of L2 (void L2 under the route) | `geometry(layers, key, [null, "L4"])`; insight warns that the void must be poured out |
| Thicken prepreg L1–L2 0.075 → 0.11 mm | new `synthesize(vary: "h")`, a few lines on the existing bisection |
| Change the target to the nearest reachable value (e.g. 95 Ω) | only offered, never pre-selected |

The suggestion list is computed only when the insight is opened.

## 7. DRC and Design Insight checks

| Check | Today | Proposal |
| --- | --- | --- |
| Segment width outside the profile window | yes (Width rule) | uses `window`; message names the directive and the sheet |
| Pair gap outside the window | partial: `gapMax` only for parallel segments closer than 2·gapMax | keep; add gap *min* from profile |
| **Neck-down budget** | any narrow segment fails | segments narrower than the window count against `neck.maxLength` per signal end, measured from the pad; the diff router already reports `necks` with lengths. Over budget → one violation per end, with the total |
| **Missing reference** | `returnPlane` insight (heuristic net set) | for profiled signals, the profile row's reference layer must have copper under the track over `w + 2·3h`. Report the unreferenced length and location |
| **Reference change** at a via | insight, generic | when the reference before and after a layer change is a different layer, require a same-net stitching via (same reference net) or a cap (different nets) within `d = 3h` or a set distance |
| Routed on an un-targeted layer | no | "USB_D on L4: Z90D has no row for L4" |
| Generated rule shadowed | no | insight from §4.2 |
| Spacing to aggressors < 3·w (or 2·s for pairs) | no | insight only, phase 4; it moves Zodd |

All of these run on the incremental DRC path. The reference check uses the pour/plane tiles that live pours
already maintain, and runs only on dirty segments of profiled signals.

## 8. Diff-pair router and length tuning

- **Router.** It already asks the resolver per layer with `at`, so layer changes pick up the new width and
  gap. Two gaps remain. (1) A pair crossing a rigid/flex region boundary mid-segment must insert a
  width/gap transition at the boundary. `sizeProfile` already produces tapers, so the boundary is fed in
  as a zone. (2) The router's auto-shrink should stop at the *window* minimum and record the neck. It should
  not go down to the bare rule minimum.
- **Length tuning.** Accordion spacing should scale with the solved width. A minimum of 3·w for single-ended and 4·w for pairs
  avoids self-coupling. For diff signals, `AtriumStackup.delay()` should use the profile's
  **odd-mode** `eeffOdd` delay. Today it solves a single track of that width, which is a few percent off for
  tightly coupled pairs and matters for delay matching across layers.
- **xSignals.** The impedance spec and the matched-delay spec live on the same Signal. The xSignals wizard
  (DDR presets) should propose both together, for example DQ 40 Ω SE and DQS 80 Ω diff, as editable
  defaults. They are not presented as facts, because the right values depend on the controller.

## 9. Altium and KiCad mapping

### 9.1 Altium

How Altium does it (as I understand it): impedance profiles are defined in the Layer Stack Manager's
Impedance tab. A Width rule or Differential Pairs Routing rule can switch to impedance-driven widths and pick a profile. On the
schematic, a **Parameter Set** directive can carry a net class (`ClassName`), a differential pair marker
and **rule** parameters. Newer releases also have a Constraint Manager where classes can be given profiles.

What I have **not** verified, and must check against sample files before writing code:

- whether a schematic rule parameter can reference an impedance profile,
- the exact Width and DPR record field names for the impedance link,
- where the profiles live in PcbDoc.

Plan:

- **Import.** (1) Read SchDoc parameter sets (record 43, dropped today): `ClassName` → tag or net class,
  differential pair → pair, rule parameters → rules where `fromAltium` can convert them. (2) Read the PcbDoc
  stack-up's impedance profiles into `impedanceProfiles`, and the impedance-driven Width/DPR fields into
  `impedanceProfile`. Then an Altium board keeps its constraint linkage instead of freezing widths.
- **Export.** A directive becomes a Parameter Set with `ClassName = Z90D` (a pair class for diff) plus a
  custom parameter `AtriumImpedance = 90 diff ±10%`. Altium keeps unknown parameters, so a round trip
  restores the directive exactly. The PcbDoc gets the class, the rule and the profile.
- If Altium cannot express a schematic-level profile link, the export report says so in one line. The intent
  still survives on the PCB side.

### 9.2 KiCad

KiCad 8/9 net classes carry track width and diff-pair width and gap, but **no impedance target**, as far as I
know. Widths are typed by hand or taken from the separate calculator. I believe KiCad 10 added delay-based
("time domain") tuning with per-layer propagation settings. I have not confirmed whether it ties
impedance to width. That should be checked before claiming parity in either direction.

- **Import.** Map `netclass_flag` / directive labels to tags or net-class directives instead of dropping
  them. Read a custom `Impedance` field if present.
- **Export.** Write a `netclass_flag` with `Netclass = Z90D` and a custom `Impedance` field. The net class
  gets the solved width and gap for the *outer* layer, with a note that KiCad net classes are not per-layer
  (as `kicad-export.js` already notes for profiles).

## 10. MCP tools

These stay small and structured, and every write tool has a `plan_only` dry run:

| Tool | Does |
| --- | --- |
| `impedance_set` `{signal \| net \| pair \| bus \| tag, spec \| text, sheet?, place?: {x,y}}` | sets the spec. With `place`, it puts a directive flag there, otherwise it sets the property. Returns the resolved membership |
| `impedance_plan` `{signal \| tag \| spec, document_id}` | per layer and substack: structure, reference, width, gap, Z, `reachable`, `reason`, ranked `suggestions[]`. Read-only |
| `impedance_check` `{signal?, tag?}` | the §7 checks for those signals: violations with lengths and locations |
| `stackup_get` (extend) | includes profiles with solved values |
| `rules` (extend) | accepts `impedance_profile` on width / diffPairsRouting |
| `eco_plan` (existing) | carries the new Impedance rows with their preview values |

`impedance_plan` is the tool an AI assistant needs most. It can answer "can this 4-layer stack do 90 Ω USB
and 100 Ω Ethernet on the inner layers?" without touching the design.

## 11. Undo, incremental, performance

- Placing or editing a directive is one edit. ECO execute stays one edit (existing), with profile creation,
  rules and classes inside the same undo step.
- Nothing derived is stored, so undoing a stack-up change restores every solved width for free.
- **Cache key.** `profileTable` and `signature` run `JSON.stringify(doc.stackup)` on every call to detect
  in-place edits. With regions and many profiles that is the hot cost. It should be replaced with a stack-up
  revision counter, bumped by the Layer Stack Manager's apply and by `plan`/`apply`. The cache is then per
  `(revision, profile, layer, substack)`, which is the same shape as today.
- Status dots, Inspector tables and suggestion lists are computed lazily, only when visible or opened.
  The ECO plan solves each distinct `(profile, layer, substack)` once per run, not once per net.
- **Budgets.** 2,000 profiled nets and 30 profiles: ECO plan adds < 20 ms, and a DRC re-check after one
  segment edit adds < 1 ms.

## 12. Tests

- **Grammar.** Parse and print round trip for every form in §2.2. Errors keep the raw text.
- **ECO** (`tests/schematic/eco.cjs`): add, change, remove and rename a directive. Change ids stay stable. A second run plans
  **zero** changes. Detached rules are left alone. A shadowing user rule produces the insight. A conflicting double
  directive produces an ERC error and no change.
- **Degraded path.** No Signal model gives exactly the classes, pairs and rules in §4.2, with the priority
  placement checked against component- and room-scoped rules.
- **Solver policy** (`tests/pcb/stackup.cjs`): the gap policy, fab limits, `window` versus `tolerance`, unreachable detection
  and each suggestion's numbers. Golden values come from a common 4-layer 7628 stack (USB 90 Ω, Ethernet 100 Ω, 50 Ω SE)
  and are cross-checked by `impedance-agreement.cjs` against the field solver.
- **Rigid-flex.** Per-substack rows, a flex CPW override, and a boundary transition on a routed pair.
- **DRC.** The neck budget at the edge, a missing reference (a void under a track), and a reference change with
  and without a stitching via.
- **Diff.** The three new kinds' texts, and `derived.solved` naming the causing layer.
- **Import/export.** Altium parameter sets in and out with the custom parameter round trip. KiCad
  `netclass_flag` in and out.
- **MCP.** Schemas, `plan_only` leaving the project byte-identical, and `impedance_plan` on an unreachable spec.
- **Performance.** The §11 budgets in the perf suite.

## 13. Phased rollout

| Phase | Scope | Why this order |
| --- | --- | --- |
| **1. Bridge** | `impedance` property on existing carriers; grammar; degraded ECO path (profile + class + rule); ECO preview with solved values; `window`; fab limits; `impedance_plan` / `impedance_set` (property form) | Smallest step that turns schematic intent into copper rules. Reuses everything PCB-side |
| **2. Object** | Directive flag item (`P V Z`), status dot, Inspector per-layer table; unreachable insight with suggestions; diff kinds; KiCad and Altium *import* of directives / parameter sets | Makes the intent visible and the failures explainable |
| **3. Signals** | Retarget onto the Signal model and tags (`signalImpedance`); reverse ECO; migration that turns generated classes and rules into tags, kept on export | Lands when the Signal model does. Phase 1 data migrates mechanically because generated objects carry `origin` |
| **4. Checks** | Neck budget, reference presence and change, un-targeted layer, router boundary transitions, odd-mode delay in length tuning, stack-up revision counter | The checks that make the constraint trustworthy at review time |
| **5. Round trip** | Altium export (parameter sets, profiles, rule fields), Altium PcbDoc profile import, aggressor spacing insight, optional field-solver synthesis for profiles | Depends on verifying Altium file details |

## 14. Open questions for the user

1. Should the DRC window default to half the spec tolerance (±5 % for a ±10 % spec), or to the full spec?
2. On the degraded path, should a directive generate visible net classes (`Z90D`), or hidden ones that show
   only in the Constraint Manager?
3. Should a directive on one net of an unpaired diff signal auto-create the pair from P/N names, or only offer
   the fix?
4. Default neck-down budget per end: 2.5 mm, or a percentage of signal length?
5. Is a different target per layer (`inner 85`) worth supporting in v1, or should v1 allow structure
   overrides (CPW on outer) only?
