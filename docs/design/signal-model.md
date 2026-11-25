# Signals: one model for nets, pairs, xSignals and classes

Original design, 20 November 2026. Section 13 outlines the implementation phases. [Net name intent](net-intent.md) covers the `AtriumNetIntent` classifier and pair recogniser. [Unified rules and checks](unified-rules-and-checks.md) extends the scope interface in section 6 to cover rule editing and the shared check engine.

## 1. Decisions in brief

- **A net is physical connectivity and nothing else.** On a board it is the set of pads, copper and
  `pinNets` entries with one name. It is derived and never declared. Nets keep names and nothing more.
- **A signal is intent.** It is a user-confirmed declaration with `kind` `single`, `diff` or `bus`.
  Its legs are seeded by one or more nets, and each leg is **spanned** across two-pin series
  elements (R, C, L, FB, links, resistor-network elements, mapped choke windings). An AC-coupled
  PCIe lane is therefore one signal of four nets, with polarity `+1`/`−1` per leg. There is no naming
  requirement, and polarity is a stored field that can be flipped.
- **Tags replace net classes, diff-pair classes and xSignal classes.** A tag is a free-form label on a
  signal, on a single net (exact legacy membership), or on a measurement path (xSignal). Rules scope
  to signals or tags. `InNetClass`, `InDifferentialPair`, `InDifferentialPairClass`, `InxSignal` and
  `InxSignalClass` keep working: they are views over the same model.
- **Spanning only applies to declared signals.** A net that nobody declared is its own implicit
  single-net signal. An op-amp's output and inverting input therefore never merge through the
  feedback resistor behind the user's back. Name-based recognition only produces **suggestions**
  (through `AtriumNetIntent`). DRC, routers and ECO use only confirmed signals.
- **Storage:** there is one versioned store, `project.signals`, which sits beside unified-rules'
  `project.rules` v3. It holds:
  - declarations, each optionally scoped `boards: [docId]` like v3 rules;
  - tags;
  - net-level tags;
  - series overrides;
  - `conventions` and `declined` (their schema is owned by net-intent.md).

  The old keys (`rules.netClasses`, `rules.diffPairs`, `rules.diffPairClasses`,
  `lengthTuning.xSignals` and `lengthTuning.xSignalClasses`) stay readable forever. Once a store
  exists, they are written as a derived **mirror** into each board's v2 `doc.rules` mirror and
  `lengthTuning`. That way 1.3 builds, external tools and code that has not been ported yet still
  see correct classes and pairs.
- **Directives are a derived source, not a copy.** This matches unified-rules §1.5. Signal and tag
  intent placed on the schematic (on the `kind: "directive"` item from impedance-directives.md, or on
  the legacy label/wire properties) is collected from the sheets whenever the model compiles. It is
  never copied into the store. ECO keeps parts, nets and footprints. This depends on the user's
  answer to unified-rules Q1, and section 8 has the ECO fallback.
- **No load-time migration.** A file without a store is modelled from the legacy keys by a pure
  function and saves byte-identical. The store is created the first time the user edits signals.
  It rides in the **same format 1.4 bump** as rules v3 (one coordinated minor bump; section 15).
- **Diffs compare models, not stores.** A 1.3 file and the same design adopted into 1.4 diff as
  empty. Span changes caused by topology edits show as derived changes.
- **Incremental:** the model is rebuilt from `AtriumUndoStore.changed(board, since)`, recomputing only
  the spans that touch changed parts. Everything is lazy (`app/signals.js` and
  `app/signals-panel.js`). The eager budget gains only a menu stub.

### The user's question

Does a diff-pair directive cover the whole net when there is a series resistor? In Altium it does
not. A pair is a pair of *nets*, so every AC-coupling cap, series R or common-mode choke splits it
into two pairs, and you need an xSignal per leg to length-match end to end. In Waffle the directive
declares a *signal*. It spans the series parts, so one directive on either side covers both stages,
`InDifferentialPair('PCIE_TX0')` matches all four nets, and the Altium exporter writes the two pairs
and two xSignals Altium needs.

## 2. What exists today (and why it confuses)

There are five stores and four recognisers that disagree:

| Concept | Where | Notes |
|---|---|---|
| Net classes | `rules.netClasses {Class:[net]}` (`rules.js:9`, validated `:342`) | design data inside the rule set; `rule-sets.js:184` has to special-case it (`DESIGN_KEYS`) |
| Diff pairs | `rules.diffPairs [{name,positive,negative}]` | one pair per net pair; a net in two pairs is rejected (`:351`) |
| Pair classes | `rules.diffPairClasses {Class:[pairName]}` | separate namespace from net classes |
| Ad-hoc pairs | `board.diffPairs` (read by `diffpair.js:28`) | undocumented second store |
| xSignals | `board.lengthTuning.xSignals [{name,from:{ref,pin},to,through,nets,class}]`, `xSignalClasses` (`xsignals.js:8`) | ref-based endpoints; refs are not updated on re-annotation |
| Auto xSignals | `length-tuning.js:652 seriesXSignal` | point-to-point nets through `SERIES_PART` (`:627`) |
| Directives | `netClass` / `diffPair` strings on schematic labels, ports and wires (`sch-author.js:203`); no UI except MCP | `eco.js:494` hard-requires `_P/_N`, `+/−` or `P/N` suffixes |

There are three implementations of "the pin across a series part": `xsignals.js:102 across`
(`SERIES` without JP/NT), `length-tuning.js seriesOther` (with JP/NT), and the planned spanning.
There are four pair recognisers: `rules.js:592 SUFFIXES`, `diffpair.js:16 SUFFIX` (adds `_H/_L`,
drops `_dp`), `length-tuning.js:1519 pairPartner`, and the `eco.js:494` regex. Net-intent.md lists
the names they miss (USB_DP/DM, CANH/L, CK_t/c, TXP0/TXN0) and the false pairs they make (CAP/CAN,
STEP/STEN).

Rules see four parallel scope families: `netclass`, `diffpair`, `diffpairclass` (`rules.js:486
compile`), and `InxSignal*`, which works by name through a separate index (`query.js:124 xsIndex`)
and a separate DRC path (`xsignals.js drc`, called from `rules.js:1216`).

Imports lose data:

- The Altium PcbDoc importer ignores `Classes6`, `DifferentialPairs6` and `SignalClasses`. The
  PiDP-11 fixture has a net class `1A = {VCC_5V}` (`KIND=0`) that disappears on import today.
- KiCad import flattens net classes into per-net v1 overrides (`import-kicad.js:269`, `:740`), so the
  class identity is lost.
- Altium export only reports "recreate the classes" (`altium-export.js:465`).

## 3. Data model

### 3.1 The store

```js
project.signals = {
  version: 1,
  signals: [
    { id: "s-7f3a1c", name: "PCIE_TX0", kind: "diff",
      boards: ["d-board1"],          // optional; absent = every board (as rules v3 `boards`)
      legs: [ {polarity: 1,  nets: ["PCIE_TX0_P"]},          // seeds; the span is derived
              {polarity: -1, nets: ["PCIE_TX0_N"]} ],
      tags: ["PCIe", "HS"],
      exclude: ["p-c12"],            // part ids this signal must not cross (split)
      through: ["p-l3"],             // part ids it may cross although the heuristic would not
      paths: [ {name: "TX0_P_U1_J1", from: {part: "p-u1", pin: "A12"}, to: {part: "p-j1", pin: "B14"}, tags: ["PCIe_TX"]} ],
      stages: ["PCIE_TX0", "PCIE_TX0_C"],   // pair name per series stage (Altium round trip); optional
      intent: {role: "pairMember", protocol: "PCIE"},   // structured, from net-intent (reserved)
      impedance: {target: 85, tolerance: 10},           // reserved for impedance-directives.md (also on tags)
      params: {current: 0.1},                           // reserved for unified-rules §1.5 (replaces netCurrents)
      origin: "user",                // user | altium | kicad | suggestion (directive-derived ones are never stored)
      altium: {uniqueId: "XIUSNMOO", xSignals: "stored"},   // round-trip identity; optional
      comment: "" },
    { id: "s-19aa02", name: "CLK_25M", kind: "single", legs: [{nets: ["CLK_25M"]}], tags: ["Clocks"] },
    { id: "s-77b0e1", name: "DDR_BYTE0", kind: "bus", members: ["s-…", "s-…"], tags: ["DDR"] }
  ],
  tags: [ {name: "PCIe", color: "#4cc9f0", comment: "",
           as: {net: "PCIe", pair: "PCIe", xsignal: null},      // legacy class names; null = not exported as that kind
           altium: {net: {uniqueId: "…"}, pair: {uniqueId: "…"}}} ],
  nets: { "VCC_5V": {tags: ["1A"], boards: ["d-board1"]} },   // net-level tags: exact legacy class membership
  series: { "p-l3": [["1","4"],["2","3"]], "p-r9": false },  // per-part series pin map (part ids are project-unique); false = never series
  conventions: {…}, declined: {"diff:6a1f…": {date, kind}},   // net-intent.md §5–6
  mirror: {"d-board1": "h1:9c03e2…"}         // per board: hash of the legacy mirror last written (section 5.3)
}
```

A board's model is the declarations whose `boards` is absent or names it, plus the directive
source (section 7), resolved against that board's nets.

Rules for the store:

- **Shared record shapes.** Every list holds keyed records (`id` for signals, `name` for tags),
  so `diff.js keyedDiff` and `merge3.js` work unchanged.
- **Part references are part ids, not designators.** Re-annotation, ECO `ref` changes and board
  re-annotate cannot stale them. The exporter, the panel, MCP and diffs resolve them to designators.
  A path endpoint keeps `ref` only when an import could not resolve it, which keeps the data
  lossless.
- **Leg nets are seeds, not the full membership.** The span is derived (section 4). The
  derivation result is never stored, except in the legacy mirror.
- **Names are unique** case-insensitively within signals and within tags, as Altium classes are
  unique per kind. A signal and a tag may share a name. `stages` names must not collide with other
  signals' names.
- **Polarity is `1`/`−1`**, matching `AtriumNetIntent` suggestions. Single legs have none. A diff
  signal always has both legs with opposite polarity. "Flip" negates both legs.
- **A bus** is an ordered list of member signal ids. Its tags apply to its members. A signal may be
  in more than one bus (a DQS pair in a byte lane and in "all strobes").
- **Validation is `AtriumSignals.validate(store, invalid, lenient)`.** It is strict on unknown keys
  in a 1.4 file. In a newer-minor file it keeps unknown keys on records, in the same way as
  `AtriumRules.setAside`. A store with `version > 1` is set aside whole by `compat.js` (as a newer
  drawing body is) and restored by `forSave`.

`conventions` and `declined` are defined by net-intent.md §6. Here they are only reserved and
validated as JSON. `impedance` and `params` are reserved for impedance-directives.md and
unified-rules §1.5.

### 3.2 Why the project, and not the rules

- **Not inside `rules`.** Signals are design data. `rule-sets.js` already has to carry
  `DESIGN_KEYS` across set switches, and rule files (`.atrium-rules.json`) should not contain a
  design's nets. Rules reference signals and tags by name through `scopeEnv` (section 6). They never
  embed membership.
- **In the project, beside `project.rules` v3.** Intent has no side (unified-rules §1.2). The
  schematic and the board read the same declarations, and one Signals panel edits them from either
  editor.
  - Multi-board projects use `boards`, exactly as v3 rules do.
  - Net names are matched per board. A declaration naming a net that a board does not have (yet)
    simply has no members there. The panel shows "not on Board 2" rather than failing.
- **An earlier draft put the store on the board.** That draft followed today's `doc.rules ??
  project.rules` owner, and was dropped once unified-rules moved rules to the project. If the user
  rejects that move, the store can live per board with the same record shapes: only `boards` goes
  away and the mirror key changes. Every other section is unaffected.

## 4. Derivation

### 4.1 Series elements

`AtriumSignals.series(part, def, store)` returns the pin pairs a signal may cross, or `[]`. One
implementation replaces `xsignals.across` and `length-tuning.seriesOther`. It tries these in
order:

1. **`store.series[part.id]`**: an explicit map, or `false`.
2. **The `SeriesPins` parameter on the part or its library definition**, written `"1-4,2-3"`.
   This is a plain parameter, so it needs no schema change, survives Altium import/export as a
   component parameter, and a library author sets it once for a common-mode choke.
3. **Heuristic:**
   - A part whose designator class is series-capable (`R C L FB JP NT Z F`, from the superset of
     today's two regexes) and that has exactly two connected pins crosses as `[[a, b]]`.
   - Resistor and capacitor networks (`RN RA RP RR CN`) with an even pin count N ≥ 4 map i ↔ N+1−i
     (as today).
   - Four-pin chokes get no default, because pinouts differ by vendor (1–2/3–4 or 1–4/2–3).
     Instead, a structural detector suggests a map: a 4-pin `L/FL/T/CMC` part whose pins land on
     both legs of a declared diff signal is paired by which pins touch which leg.

A crossing is refused when either net is a rail or ground. That test is `AtriumNetIntent.isRail` /
`isGround`, which by then has confirmed `intent.role: "rail"` overrides; the regex is only a
fallback while the module is absent. This is what keeps pull-ups, terminations to VTT, decoupling
and dividers out of spans.

### 4.2 Spanning a declared signal

All declared signals are spanned together, by **multi-source breadth-first search** from every
leg's seed nets over the graph `net —(series part pins)— net`:

- **Seeds are fixed.** A search never enters a net that is a seed of another signal. Two imported
  Altium pairs joined by caps therefore stay two signals until the user merges them.
- **Ties at the same depth go to the lower signal id**, which keeps the result deterministic. The
  loser gets an issue: "R5 joins USB_D and DBG_D. Exclude it from one."
- **Exclusions:** `exclude` parts are never crossed by this signal. `through` parts are crossed
  even when the heuristic says no (with their pin map, or both pins of a 2-pin part).
- **Bounds:** at most 3 crossings from a seed (as today) and at most 32 nets per leg. Beyond that the
  span stops and reports "span truncated".
- **Output per leg:** `nets` (ordered by depth, then name), `parts` crossed (id, pins, depth), and
  `ends`. Ends are pins on the span that are not on crossed parts; they are the source and load
  candidates.

Unseeded nets are not spanned. Length tuning keeps its *own* policy for automatic xSignals:
point-to-point nets only, from `seriesXSignal`, so lengths and DRC results do not change. It now
calls `AtriumSignals.series()` for the pin map, so there is one definition of "series part".

### 4.3 Stages and pairs

Routers, SI, the autorouter, via fences and the diff-pair DRC all work on **net pairs on copper**,
so the model also derives **stages** for a diff signal. Stage *k* pairs the leg-plus net at depth
*k* with the leg-minus net at depth *k*. Stage names are `stages[k]` when stored (imports, merges),
otherwise the signal name for stage 0 and `NAME.k` after it.

If a depth has more or fewer than one net on either leg (an irregular topology, such as a stub
through a series R on one leg only), that stage is skipped with an issue. This view is what
`AtriumRules.diffPairs(board)` returns, so every existing consumer keeps its
`{name, positive, negative}` contract.

### 4.4 Paths (xSignals)

A signal's measurement paths are either its stored `paths` (wizard, import, MCP) or, when there
are none, one **auto path per leg** from the leg's two ends. The source is the end on the part with
more pins, as `seriesXSignal` decides today. Auto paths are named after the leg's source-side net.
`InxSignal('X')` matches path names. Matched-length groups measure paths through
`AtriumLength.xSignalLength` as before. DDR fly-by stays per load: the wizard stores one path per
(source pin, load pin) on the same single-net signal, exactly as Altium does.

### 4.5 Tag resolution

The tags of a net are the union of:

- its net-level tags (`store.nets`),
- its signal's tags, and
- the tags of any bus that contains that signal.

The tags of a path are its own tags plus its signal's tags. All of these are precomputed into
`Map(net → Set(lowercase tag))` per model revision, so a rule matcher costs O(1) per object.

## 5. Legacy data, adoption and the mirror

### 5.1 Reading a legacy project (no `project.signals`)

`AtriumSignals.fromLegacy(project)` is pure. It reads each board's `doc.rules` (or the project's
v2 rules fallback) and `lengthTuning`. Entries from one board get `boards: [thatBoard]`, the same
rule unified-rules §1.6 uses for rules. Identical entries from several boards are folded into one
unscoped record.

| Legacy | Becomes |
|---|---|
| net class C = {nets} | tag C (`as.net = C`); every member gets the net-level tag C. If the members cover exactly the full span of one declared signal, the tag is promoted to that signal |
| diff pair {name, +, −} | `diff` signal `name`, legs seeded `+` (1) and `−` (−1), `stages: [name]` |
| pair class C = {pairs} | tag C (`as.pair = C`) on those diff signals. If a net class with the same name has exactly their nets, it is the same tag. Otherwise a separate tag `C (pairs)` with `as: {net: null, pair: "C"}` is created, so the export is exact |
| xSignal {name, from, to, through, nets} | a path on the signal that contains `nets[0]`. If none is declared, a new `single` signal seeded with `nets` and `origin: "altium"` or `"user"` is created. Endpoint refs are resolved to part ids |
| xSignal class C | path-level tag C (`as.xsignal = C`), promoted to signal level when it covers all of a signal's paths |
| `board.diffPairs` (ad hoc) | the same as a rules pair, `origin: "user"` |

**The test for losslessness:** `toLegacy(fromLegacy(x))` deep-equals `normalize(x)`, with members
in sorted order, for every corpus file and for synthetic edge cases. Edge cases include a net class
that covers half a span, a pair class with a name clash, an xSignal whose part is missing, and empty
classes.

### 5.2 Adoption

The first time anything writes through the signals API (the panel, ECO, MCP, the wizard, an
import), `AtriumSignals.edit(project, fn)` does three things in that one undo step:

1. creates `project.signals` from `fromLegacy`,
2. applies `fn`, and
3. rewrites the mirror.

Reading never adopts. Opening and saving an untouched 1.3 file therefore gives the same bytes
(`tests/compat-corpus.cjs` keeps passing).

### 5.3 The mirror

After adoption the legacy keys are **derived output**. `toLegacy(project, board)` writes them per
board:

- `rules.netClasses`, inside the per-board v2 `doc.rules` mirror that unified-rules §1.6 already
  writes (one mirror writer, which calls this function to fill the class and pair keys): from the
  net-class view of each tag, i.e. all nets of tagged signals plus
  net-level members;
- `rules.diffPairs`: stages;
- `rules.diffPairClasses`;
- `lengthTuning.xSignals` and `xSignalClasses`: stored paths, with `{ref, pin}` resolved for older
  readers.

`store.mirror[boardId]` is set to a hash of what was written. Topology edits can change spans
without a signals edit, so the mirror is refreshed on save. `AtriumCompat.forSave` calls
`AtriumSignals.forSave(copy)`, which writes into the saved copy only, so saving never dirties the
undo store.

**What it buys:**

- A 1.3 build opening a 1.4 file sees correct classes, pairs and xSignals. It keeps
  `project.signals` as an unknown top-level field and preserves it.
- External scripts reading `.atrium` JSON keep working.
- Consumers not yet ported keep working during phase B.

**Edits made by an older build.** On load, if `hash(legacy keys of board B) ≠ store.mirror[B]`, a
1.3 build edited classes or pairs on B. This runs with the rules-mirror delta in unified-rules
§1.6, so there is one Messages row for both. `AtriumSignals.reconcile` re-reads the legacy keys as the user's latest
intent:

- net-level tags and pairs by name are replaced;
- store-only data that does not conflict (merges, exclusions, intent, paths) is kept;
- the Messages panel says once: "Net classes on Board were changed in an older Waffle; Signals were
  updated from them."

### 5.4 Format

Format **1.4** is shared with rules v3 and the directive item. One bump: whichever lands first
moves `CURRENT`, and the others join the same unreleased 1.4. Signals add `project.signals` and the
directive fields `signal`, `polarity` and `tags` (section 7).

- `model.js` validates them through `AtriumSignals.validate`. This is a guarded validator change,
  so `compat-guard.py --update` runs with the bump.
- `compat.js CURRENT = "1.4"`. `AtriumLazy.validatorsFor` loads `AtriumSignals` when either store is
  present.
- The corpus gains `v1.4-signals.atrium`: an AC-coupled pair, a CMC with `SeriesPins`, a bus,
  net-level and signal-level tags, paths, intent and declined. It also gains a synthetic
  `v1.5-newer-signals.atrium` with an unknown store key, an unknown signal field and a version 2
  store.
- No migration is registered.

## 6. Rule scopes (the seam for unified rules)

### 6.1 One scope environment

`AtriumSignals.scopeEnv(board, project)` returns a memoised object that rules, queries, DRC,
Insights and the future unified check engine all bind to:

```js
{ signalOf(net) -> {id, name, kind, polarity?, stage?} | null,
  tagsOf(net) -> Set,  pathTags(pathName) -> Set,
  netsOfTag(tag, as?) -> Set,          // as: "net" | "pair" | "xsignal" | undefined (any)
  netsOfSignal(name) -> Set,           // stages, legs and bus members included
  pairOf(net) -> {name, positive, negative, signal}   // stage view
  paths() / pathOf(name), revision }
```

`rules.js compile()` replaces its private `classes`, `pairs`, `pairOfNet` and `pairClasses` maps
with this object. `query.js context()` replaces `rulesOf()`, `c.netClass`, `c.pairs` and `xsIndex`
with it. A schematic context gets the same interface from the directive model (section 7). The
unified-rules design only needs `scopeEnv`, so it never has to know how signals are stored.

### 6.2 Keywords

| Keyword | Meaning in the new model |
|---|---|
| `InNet('x')` | the object's net is x (unchanged) |
| `InNetClass('x')` | net ∈ `netsOfTag(x, "net")`. `'All Nets'` is built in as today |
| `InDifferentialPair('x')` | net is in diff signal x (all its stages) or in stage named x |
| `InDifferentialPairClass('x')` | the net's diff signal has tag x (pair-capable) |
| `InxSignal('x')` / `InxSignalClass('x')` | path x, or a path tagged x. An object carrying `xSignal` matches by name; any other object matches by net, as now |
| `IsDiffPair` | the net is a leg of a confirmed diff signal |
| **`InSignal('x')`** (new) | net ∈ `netsOfSignal(x)` (any kind, bus members included) |
| **`HasTag('x')`** (new) | x ∈ `tagsOf(net)`, or ∈ `pathTags` for path objects |
| **`Signal`**, **`Polarity`** (new properties) | the signal name, and `'+'`/`'-'`/`''`, for queries such as `HasTag('USB') And Polarity = '+'` |

One semantic change is deliberate: after a user *merges* two imported pairs,
`InDifferentialPair('PCIE_TX0')` covers both stages. That is the point of the merge. The stage name
`PCIE_TX0_C` still matches only its own stage, so imported Altium rules written against stage
names keep their exact meaning.

### 6.3 Stored scopes

The scope kinds `signal` and `tag` are added (`scopeQuery` → `InSignal(...)` / `HasTag(...)`).
`netclass`, `diffpair` and `diffpairclass` stay valid and are what Altium import produces, so the
source text round-trips. A 1.3 build reading a rule scoped `{kind: "tag"}` in a 1.4 file sets that
rule aside and preserves it (`rules.js setAside`). It is kept, not applied, and that limitation is
documented.

Renaming a signal or tag rewrites rule scopes in the same edit. Plain kinds compare values
directly. Query scopes are rewritten on the AST through `AtriumQuery.parse` / `print`, touching only
the string arguments of the class, pair, signal and tag functions.

### 6.4 Matching paths and DRC

`XS_SCOPE` (`rules.js:569`) generalises to "path-scoped" (`InxSignal*`, or `HasTag` on a tag with
path members). Those rules keep going to the per-path DRC in `xsignals.js drc`. `matchedGroups`
gains signal awareness: a diff signal in a matched group contributes its *paths* (one per leg)
rather than its four nets, which removes the double counting that the auto-xSignal folding in
`length-tuning.js groups` works around today.

## 7. Schematic directives (a derived source)

Directive intent can sit in two places. The first is the new `kind: "directive"` item, the visible
flag defined by impedance-directives.md, which unified-rules §1.5 generalises. The second is the
legacy properties on a net label, port, power port, off-sheet connector or wire. The collector reads
both:

| Field | Meaning | Since |
|---|---|---|
| `netClass: "A,B"` | net-level tags A and B on the touched net (exact legacy semantics) | 1.0 |
| `diffPair: "USB"` | the touched net is a leg of diff signal USB | 1.0 |
| `signal: "USB"` | the touched net seeds signal USB. With a `polarity` it is a diff leg, otherwise single | 1.4 |
| `polarity: 1 \| -1` | the leg polarity, needed only when the name does not tell | 1.4 |
| `tags: ["HS","USB"]` | **signal-level** tags: they follow the span across series parts (unified-rules §1.5 uses the array form) | 1.4 |

`AtriumSignals.directives(project)` is the collector. It is cached per sheet and invalidated
through `hierarchyVersion` and the per-sheet journal. It returns
`[{sheet, itemId, net, signal?, polarity?, tags[], netTags[], impedance?, rules?, params?}]`.

- The **Signal model** consumes `signal`, `polarity`, `tags`, `netTags`, `diffPair` and `netClass`.
  It merges them into each board's model as declarations with `origin: {kind: "directive", doc,
  item}`. These are **derived and never copied**. Deleting the directive removes the intent.
- **Detach** turns a derived declaration into a stored one.
- When a stored declaration and a directive name the same signal, the stored one wins and an
  insight flags the double source (unified-rules 7a).
- `impedance`, `rules`, `params` and `waive` are passed through untouched to rule sources
  (unified-rules §1.5, impedance-directives.md). That compilation belongs to those docs. Their rules
  scope `{kind: "signal", value}`, and the touched signal is resolved here.

**Polarity without suffixes.** For a two-net pair with no explicit `polarity`, the collector asks
`AtriumNetIntent.polarity(name)` for each net. If that is undecided (two arbitrary names), the pair
is still declared. The first net in natural order is `+1`, and a *warning* (not an error) says
"Polarity of USB was assumed (+ = D_A). Set polarity on the directive or flip in Signals." This
removes the hard `_P/_N` requirement of `eco.js:494`.

## 8. ECO

Following unified-rules §1.2, signal and tag intent reaches the board **without an ECO**. Derived
directives are live, and stored declarations are project data that both editors read. Concretely:

- `eco.js directives()` stops planning `netClass` and `diffPair` changes. It keeps only one issue
  line: a directive whose net is not on the board yet will apply after Update PCB adds the net.
- Saved ECO reports and `mcp/automation.py` filters that name `netClass` or `diffPair` still parse,
  and they plan nothing.
- **Renames.** `renameInRules` (`eco.js:643`) becomes `AtriumSignals.renameNet`. A schematic net
  rename that ECO applies to the board renames leg seeds, net-level tag keys and path caches in
  stored declarations, in the same apply step as the copper. Derived declarations need nothing,
  because they follow the sheet.

**Fallback, if the user answers unified-rules Q1 with "keep ECO for rules".** The collector output
is not applied live. ECO plans `signal` changes (add/update/remove a directive-origin declaration)
and `tag` changes (net-level deltas) in a reviewed "Signals" group, and applies them through
`AtriumSignals.edit` in its one undo step. Ownership rules apply: ECO never edits a declaration with
another origin, and a stale directive declaration is proposed for removal. The collector, record
shapes and every other section are identical in both answers. Only `eco.js` changes (C5a vs C5a′).

## 9. Diff, compare and merge

`diff.js` gets `signalsDiff(a, b)`, which compares `AtriumSignals.model()` on both sides and never
the raw stores:

- **`signal.added/removed/changed`** (keyed by id, falling back to name across files without ids).
  Fields are kind, legs and polarity, tags, exclude and through, paths, and intent. The text reads
  "Signal PCIE_TX0: polarity flipped", "tags +PCIe", "no longer crosses C12".
- **`tag.*`** covers the tag registry and colour.
- **`signal.span`** (derived, `severity: "electrical"`) reports that the span of a signal changed
  because of a topology edit: "PCIE_TX0 now also spans PCIE_TX0_P_C (C14 added)". This is
  invaluable in review and costs nothing extra: it is a set difference of derived spans.
- **`net.tags`** covers net-level membership.

`rulesDiff` skips `netClasses`, `diffPairs` and `diffPairClasses` when either side has a signal
model to compare. A board with only legacy keys is modelled through `fromLegacy`, so an adopted
board versus its 1.3 original diffs as empty (this is tested). `merge3.js` needs no new code
because the records are keyed. One test checks that two branches tagging different signals merge
cleanly and that two branches renaming the same signal conflict on that record only.

## 10. UI

### 10.1 One Signals panel

Window › Panels › Signals replaces the separate editors (`signals-panel.js`, a lazy dock panel). It
is the only place where membership is edited. The Constraint Manager and the rules editor keep
showing *constraint values* per signal and tag, and link here for membership.

- **Header:** a search box; chips for kind (All · Single · Diff · Bus); tag chips;
  "Suggestions (n)"; "Issues (n)".
- **Tree.** A signal row shows the name, a kind glyph, polarity badges, tag chips, the net count
  and a compact span ("PCIE_TX0_P ─C12─ PCIE_TX0_P_C"). Length and skew columns are computed only
  for rows that are painted. Expanding a row shows legs, then nets, then crossed parts. Every node
  cross-probes (click selects, double-click zooms).
- **Actions** (toolbar, context menu and keys; no hover pop-ups):
  - New signal from selection: nets, tracks or pads selected on the board or schematic.
  - Make differential: two nets or two single signals.
  - Flip polarity.
  - Split at part: adds the part to `exclude`.
  - Cross part: adds it to `through`.
  - Merge: two diff signals become one, with `stages` keeping their names.
  - Tag, Rename, Remove.
  - Accept or decline a suggestion. Accept all strong suggestions is one undo step.
- **Tags section:** colour (it feeds the Nets panel's "colour by class", which now colours by
  tag), member count, the rules that reference the tag (a link to the rules editor), and the Altium
  class names (`as`).
- **Suggestions section:** pairs, buses, rails and joins from `AtriumNetIntent.index().suggestions()`,
  plus CMC pin-map suggestions from section 4.1. Each shows its *why*.
- **Issues:** span conflicts, truncated spans, irregular stages, assumed polarity, and series
  parts with no pin map.

### 10.2 Elsewhere

- **Rules editor** (`rules.js`, panes at `:1556`): the Net Classes, Differential Pairs and Pair
  Classes panes become one "Signals and tags" entry that opens the panel. The scope chooser offers
  Signal and Tag alongside the Altium kinds. The rest of the editor belongs to the unified-rules
  doc.
- **Constraint Manager** (`constraints.js:95`): "Net Classes", "Differential Pairs" and "xSignals"
  become "Tags" and "Signals" rows that are views over the model. ECSet templates become "tag
  templates", with the same mechanics on `{kind: "tag"}` scopes.
- **Nets panel:** the "Net class" column becomes "Signal · Tags".
- **Schematic:** the inspector for labels, ports and wires gains Signal, Polarity (Auto/+/−) and
  Tags fields. Place › Directives › Signal… applies them to the selection. A small `+`/`−` badge is
  drawn beside directive labels. The Signals panel is the same in
  both editors (it edits the project store). Directive-derived signals show a flag glyph and are
  read-only there: "Go to directive" and "Detach" are offered instead.
- **Board context menu:** Signal ▸ New from net / Make differential with… / Tag… / Show in Signals.
- **Routing:** interactive diff-pair routing on an *unconfirmed* name match offers
  "Declare PCIE_TX0 as a differential signal" in the route bar. That is one click and its own undo
  step. It no longer silently routes as a pair: inferred intent is advisory, which is also what
  Altium users expect.

## 11. MCP

The new tool `signals` (`mcp/headless.js OPS.signals`, schema in `mcp/automation.py`) has these
actions:

| Action | Purpose |
|---|---|
| `list` | filter by kind, tag or name; `spans`, `stages` and `paths` optional; lengths optional |
| `get` | one signal |
| `suggest` | net-intent suggestions plus join and pin-map suggestions |
| `declare` | `{name, kind, legs:[{nets, polarity}] \| members, tags}` |
| `update` | rename, tags, exclude/through (by designator), paths, intent |
| `flip` | flip polarity |
| `merge`, `split`, `remove` | edit declarations |
| `tag` | add or remove tags on signals, nets or paths |
| `accept`, `decline` | act on suggestions |
| `legacy` | the netClasses, diffPairs and xSignals view, as Altium or 1.3 sees it |

Designators are accepted and resolved to part ids.

Existing tools keep their contracts:

- `rules` actions `set_net_class`, `remove_net_class`, `set_diff_pair` and `remove_diff_pair`
  route through the signals API.
- `xsignals` writes paths.
- `add_net_label` gains `signal`, `polarity` and `tags`. Its description drops "(…_P / …_N)".
- `run_eco` filters accept `signal` and `tag`.

`docs/headless-parity.json` and `mcp/README.md` are updated.

## 12. Incremental strategy and performance

- **Index:** `net → [{part, pin}]`, `part → series pin pairs`, `net → signal id`, and per-signal
  spans, stages and paths. This is kept per board in a WeakMap with
  `{seq, outer, library, storeJSON}`.
- **On access:**
  1. Read `AtriumUndoStore.documentVersions(board, project)`.
  2. If `outer` moved (store or rules edits), re-read declarations. Only signals whose JSON changed
     are re-spanned.
  3. If `items` moved, `changed(board, since)` gives the touched items. Only parts matter (spans
     use `pinNets`, not copper). The affected nets are the old nets (from the journal's `was` JSON)
     plus the new `pinNets`. The signals whose span or seeds intersect them are re-spanned.
  4. If `library` moved (SeriesPins on defs), spans crossing parts of changed defs are re-spanned.
  5. When the journal returns `ids: null`, or there is no undo store (MCP, tests), it falls back to a
     full rebuild, memoised on `items` identity and length, as `pinsOfNets` does.
- **Laziness:** nothing is computed until a consumer asks (rule compile, panel, DRC, export, diff).
  Suggestions are computed only while the panel is open or on MCP `suggest`, through net-intent's
  own incremental index. Tag maps and the stage view are built on first use per revision.
- **Cost:**
  - A full build on a 10k-part, 30k-pin board is one pass over pins plus a bounded BFS per declared
    signal, estimated at well under 10 ms in JS. The incremental path matters for online DRC on
    every edit, not for correctness.
  - Rule matching gains no per-object work beyond today's map lookups.
  - Mirror hashing happens only on save and on signals edits.
- **Bytes:** `signals.js` ~28 KB, `signals-panel.js` + css ~35 KB, both lazy. Eager additions are a
  lazy.js registration and menu entries, under 1 KB. The router, length and xSignals modules
  *shrink*, because their recognisers and `across` copies go away.

## 13. Implementation plan (phase B)

Each commit passes the full suite. "Unchanged" means the existing tests pass without edits. Owner
is me unless noted. `rules.js` and `query.js` are shared with the unified-rules agent: I own the
scope environment and keyword bindings, and they own the editor UI and check engine.

**C1. Signal core.**
- Files: new `app/signals.js` (`AtriumSignals`: validate, model, series, span, stages, paths,
  views, `scopeEnv`, `fromLegacy`/`toLegacy`, `edit`, `renameNet`, `directives`) and `app/lazy.js`
  (register, deps `AtriumNetIntent`).
- Tests: new `tests/signals.cjs` covering:
  - spans: an AC-coupled diff, a series R, a CMC via `SeriesPins`, a resistor network,
    rail/ground refusal, seed stop, a span conflict, the depth and size caps, exclude/through;
  - polarity and flip;
  - stages, regular and irregular;
  - auto and stored paths;
  - bus tag inheritance;
  - the `fromLegacy`/`toLegacy` identity on edge cases.

**C2. Format 1.4, adoption, mirror, compat.**
- Files: `app/model.js` (validate `project.signals`), `app/compat.js` (`CURRENT` 1.4 if rules v3
  has not moved it yet; set-aside of a version 2 store; the `forSave` mirror hook shared with the
  rules-v3 mirror writer), `docs/format-versioning.md`, `scripts/compat-guard.py`
  state, and the corpus (`v1.4-signals.atrium`, `v1.5-newer-signals.atrium`, `index.json`,
  `snapshots.json`).
- Tests:
  - `tests/compat*.cjs` (untouched 1.3 files save byte-identical; the newer store is preserved);
  - new `tests/signals-compat.cjs` (adoption, mirror equality, reconcile after a simulated 1.3
    edit, a 1.3 reader seeing correct classes);
  - `tests/compat-mcp.py`.

**C3. Rules and query bound to `scopeEnv`.**
- Files: `app/rules.js` (`compile` env; `netClasses`, `diffPairs`, `matchedGroups` and `boardNets`
  as views; the `signal` and `tag` scope kinds in `checkRule`, `scopeQuery` and `matcher`;
  `detectDiffPairs` as a wrapper over `AtriumNetIntent.pairs`, per net-intent.md §9) and
  `app/query.js` (`InSignal`, `HasTag`, `Signal`, `Polarity`; context via `scopeEnv`; `xsIndex`
  removed).
- Tests: `rules.cjs`, `query.cjs`, `rules-altium-parity.cjs`, `drc.cjs`, `drc-equivalence.cjs`
  unchanged, plus new cases for the new keywords and for "InDifferentialPair after merge".

**C4a. Routing and length consumers.**
- Files: `app/diffpair.js` (`pairs()` returns declared stages; the `SUFFIX` loop goes; name
  matches are suggestions), `app/drag-reroute.js`, `app/length-tuning.js` (`diffPairList`,
  `netClassList`, `pairPartner` via views and net-intent; `seriesOther` via
  `AtriumSignals.series`), `app/xsignals.js` (store via the signals API; `across` removed; the
  wizard writes paths and tags), and `app/route-suggest.js`.
- Tests: `diffpair.cjs`, `length-tuning.cjs`, `length-agreement.cjs`, `high-speed.cjs`,
  `timing.cjs`, `drag-reroute.cjs` unchanged; the wizard round trip extended.

**C4b. Other readers of raw rules keys.**
- Files: `app/route-planner.js`, `app/insights.js`, `app/constraints.js` (model rows),
  `app/bus-route.js`, `app/viastack.js`, `app/via-fence.js`, `app/search-index.js`,
  `app/si.js`, `app/autorouter.js`, `app/kicad-export.js`, and `app/rule-sets.js` (`DESIGN_KEYS`
  no longer needed once a store exists).
- Tests: the existing suites for each, unchanged.

**C5a. Directive collector and ECO.**
- Files:
  - `app/signals.js`: `directives()` collector, derived declarations, Detach.
  - `app/eco.js`: `directives()` reduced to the issue line; `renameNet` hook. C5a′ is the
    reviewed "Signals" group if Q1 is answered "keep ECO".
  - `app/sch-objects.js`: validate the directive fields on labels, wires and the directive item.
  - `app/sch-author.js`: MCP `signal`, `polarity`, `tags`.
  - `app/sch-object-inspector.js` / `app/sch-object-forms.js`: the fields.
- The directive *item* itself (`kind: "directive"`, drawing, placement) is owned by the
  impedance-directives / unified-rules phase 7 owner. C5a reads it only through the collector.
- Tests: new `tests/signals-directives.cjs`:
  - USB_DP/DM accepted; arbitrary names warn and do not fail;
  - one directive covers an AC-coupled pair;
  - deleting the directive removes the intent;
  - stored beats derived.
- Also `eco.cjs` (no class or pair rows; renames carry stored seeds) and `eco-e2e.py`.

**C5b. Detach and "show directive" round trips in the panel.**
- Files: `app/signals-panel.js`.
- Tests: `signals-panel.cjs`.

**C6. Diff and merge.**
- Files: `app/diff.js` (`signalsDiff`, legacy suppression), `app/diff-model.js` and
  `app/diff-export.js` labels, and `app/diff-worker.js` (load the signals module).
- Tests: `diff.cjs` (an adopted board versus its 1.3 original is empty; span derived change; flip;
  tag edits), `diff-review.cjs`, `mcp_diff.py`, and `merge3` cases in `diff.cjs`.

**C7. Signals panel.**
- Files: new `app/signals-panel.js` and `app/signals-panel.css`; `app/lazy.js` (action
  `signals-panel`); `app/index.html` (menu entries); `app/rules.js` (editor panes become one
  pointer, coordinated with the unified-rules agent); `app/constraints.js` (Tags and Signals tabs);
  `app/nets-panel.js` and `app/nets-table.js` (column); `app/context-menu.js`; `app/router.js` and
  `app/diffpair.js` (the route-bar declare offer); `app/locales/en.json`.
- Tests: new `tests/signals-panel.cjs` (headless view model, actions as single undo steps), a
  LinkeDOM smoke test in the integration inventory, and `editor-demand.cjs` (eager budget
  unchanged).

**C8. MCP.**
- Files: `mcp/headless.js`, `mcp/automation.py`, `mcp/board_runner.py` (module lists),
  `mcp/README.md`, `docs/mcp-and-cli.md`, `docs/headless-parity.json`.
- Tests: `tests/mcp.py` (declare, flip, merge, tag, legacy view; `rules` and `xsignals` back
  compatibility) and `headless-parity.py`.

**C9. Altium and KiCad.**
- Files:
  - `app/pcb-import.js`: read `Classes6` (`KIND=0` nets, `6` diff pairs, superclasses and
    autogenerated classes skipped, `UNIQUEID` kept), `DifferentialPairs6` and `SignalClasses`
    (`KIND=10`), and the xSignal records (stream to be confirmed) into `project.signals`
    (`origin: "altium"`).
  - `app/altium-export.js`: write `RECORD=Class` and `DifferentialPair` records from the views,
    with stages named after `stages`; xSignals from stored paths, or auto paths when
    `altium.xSignals ≠ "stored"`.
  - `app/import-kicad.js`: net-level tags as well as the existing rules, so the class identity
    survives.
  - `app/kicad-export.js`: a diagnostic for diff signals whose names KiCad cannot pair.
- Tests:
  - `import-altium-real.cjs`: the snapshot gains class `1A = {VCC_5V}`, a deliberate change;
  - `altium-export.cjs`: a round trip of classes, pairs, pair classes and xSignal classes through
    the importer oracle, including UNIQUEIDs;
  - `kicad-roundtrip.cjs`, `import-kicad.cjs`;
  - a new synthetic ASCII PcbDoc fixture with pairs and xSignals.

**C10. Docs.**
- User guides cover [high-speed design](../high-speed.md), [schematic and PCB sync](../schematic-pcb-sync.md), [importing](../importing.md) and [upgrading](../upgrading.md).

Commit order is C1 → C2 → C3, then C4a, C4b, C5a, C6 and C9 can go in parallel (each owns
disjoint files apart from `lazy.js` registrations, which are trivial to rebase). After that come
C7, C8, C5b and C10.

## 14. Risks

1. **False spans.** Two signal nets bridged by a passive that is not series (an op-amp feedback
   network, a bias tee) would merge.
   - *Mitigation:* spanning applies only to declared signals, with rail and ground refusal; the
     span is always visible in the panel and diffs; exclude is one click.
2. **Choke pin maps.** A wrong 4-pin heuristic would cross-wire legs.
   - *Mitigation:* there is no default map. A suggestion plus `SeriesPins` is set once per library
     part.
3. **Irregular stages.** Routers need per-stage pairs, and asymmetric topologies cannot pair a
   stage.
   - *Mitigation:* the stage is skipped with an issue. The signal and its paths still drive
     matching.
4. **Mirror drift and two writers.**
   - *Mitigation:* the hash check and reconcile on load, mirror refresh at save, and a test with a
     simulated 1.3 edit.
5. **Altium format details are unverified.** `DifferentialPairs6` field names and the xSignal
   storage are unconfirmed (the PiDP-11 fixture has none; it shows `Classes6` kinds 0/1/2/3/4/6/7
   and `SignalClasses` kind 10).
   - *Need:* a small PcbDoc from the user with two pairs, a pair class, xSignals and an xSignal
     class. Until then the importer reads only what the fixture proves (net classes).
6. **Behaviour changes users will notice.**
   - Name-matched pairs no longer route silently as pairs.
   - `InDifferentialPair` broadens after a merge.
   - ECO accepts pairs without suffixes, with a warning.
   - All three are deliberate and are documented in upgrading.md.
7. **Length and DRC drift.** Unifying the series-part regex (adding JP/NT to xSignal discovery)
   could change measured paths.
   - *Mitigation:* the length auto-xSignal policy stays point-to-point, and the snapshots
     (`drc-equivalence`, the compat corpus DRC) must stay identical.
8. **Two sources (directive and stored) naming one signal.**
   - *Mitigation:* stored wins, an insight flags it, and Detach makes it explicit. Conflicting edits
     are shown, never auto-resolved.
9. **Collaboration granularity.** `project.signals` is one top-level field for `collab-crdt.js`,
   so concurrent tag edits conflict at field level until per-record merge lands. This is acceptable
   for the preview; the records are already keyed for it.
10. **Coordination.** `rules.js` and `query.js` are touched by both this work and the unified-rules
    work.
    - *Mitigation:* `scopeEnv` lands first (C3) as the agreed seam. The editor panes are removed
      only in C7, after agreement.

## 15. Coordination with the parallel designs

What this doc takes from them:

- **net-intent.md:** the only recogniser (`AtriumNetIntent`), polarity as `±1`, the suggestion
  shape, and `intent`/`conventions`/`declined` reserved in this store. Its integration note lists
  the call sites C3 and C4 replace.
- **unified-rules-and-checks.md:** project-level storage with `boards` scoping, directives derived
  rather than copied, no ECO for intent (pending Q1), one 1.4 bump with per-board v2 mirrors, and a
  mirror-hash reconcile. This doc's store, mirror and reconcile ride on the same machinery. It needs
  `signalsOf(net)`, `netsOf(signal)`, `tagsOf(signal)`, stable ids and change info. Those are
  `scopeEnv` (section 6.1) plus `AtriumSignals.changes(since)`, which returns the signal ids whose
  span, tags or declaration changed, from the same journal pass as section 12. That is what its
  scheduler needs for `incremental: "signal"` checks.
- **impedance-directives.md:** `signal.impedance` and `tag.impedance` are reserved. Its
  `signalImpedance` ECO action becomes a plain store edit under the no-ECO answer, or joins the
  "Signals" ECO group under the fallback.

Open conflicts, stated rather than silently resolved:

1. **ECO or live intent.** This hangs on unified-rules Q1, the user's call. Both paths are designed
   (section 8). impedance-directives.md assumes an ECO action, and unified-rules assumes none. Both
   docs should follow whatever answer the user gives.
2. **Store location if rules stay per board.** If the user rejects project-level rules, signals can
   still be project-level; nothing here needs board-level rules. That decision is independent and I
   would keep the project store either way.
3. **Mirror ownership.** There must be one `forSave` writer for each board's v2 `doc.rules`.
   Unified-rules phase 5b owns it. It calls `AtriumSignals.toLegacy(project, board)` for the class,
   pair and pair-class keys. If C2 lands first, C2 writes those keys into the existing `doc.rules`,
   and 5b later takes the writer over unchanged.
4. **Format bump timing.** There is one 1.4 bump. If C2 ships before phase 5b, it moves `CURRENT`
   and adds `v1.4-signals.atrium`. Phase 5b then adds its own 1.4 corpus file without a second
   bump, because both are additive within unreleased 1.4.


## 16. Implementation status (phase B, 2026-11-20)

The initial implementation covered the signal model, live directives, the Signals panel’s Detach and Go to directive actions, and import and export. An interchange check used a board saved by Altium Designer 26. [Altium record details](altium-pairs-xsignals-format.md)

Where the code differs from the sections above:

- **Legacy data does not span.** Pairs and xSignals read from legacy keys or imports get `span: false`,
  and net classes become net-level tags (no promotion to signal-level). That keeps the legacy view exact
  whatever the topology does; spanning starts when the user declares or edits a signal, or accepts a
  suggestion.
- **Reconcile** (an older build or a legacy writer edits the mirror) works per dimension: pairs, pair
  classes, net classes, xSignals. A dual-role tag keeps its other role; a deleted pair that hosts
  xSignals becomes single-ended; a deleted derived stage adds exclusions. Writing back the model's own
  view is not a legacy edit, so `AtriumRules.effective()` can carry the live view.
- **Imported classes** are kept as text records (`doc.sourceClasses`: Altium Class, DifferentialPair and
  xSignal pin-pair records, KiCad net classes) and read until the board's rules carry class keys; Altium
  xSignals also go to `lengthTuning`.
- **Spans stop** at nets with more than 8 pins and at bussed resistor networks, as well as at rails,
  grounds and other signals' seeds.
- **MCP** `signals` lives in `signals-panel.js` (`headless`), beside the panel's actions.

Not done yet (C7 remainder): the rules editor's Net Classes / Differential Pairs panes still edit the
legacy keys (their writes are folded back by reconcile); the Constraint Manager keeps its Net Classes /
Differential Pairs / xSignals tabs (reading the model's views); the Nets panel's Class column shows tag
names through `AtriumRules.netClasses()`; no board context-menu entries or route-bar "declare" offer; no
CMC pin-map suggestion. Pending from the impedance branch: odd-mode pair delay in length tuning,
`neckLength` on Width and Differential Pairs Routing rules, router auto-shrink floor.
