# Unified rules and checks: one rule model, one engine, one problems list

Original design proposal, 20 November 2026.

Builds on two parallel proposals and does not repeat them:

- [Signal model](signal-model.md). It defines **Net** (physical connectivity), **Signal**
  (design intent that spans series passives; kinds single, diff, bus) and **Tags** (which replace net
  classes, diff-pair classes and xSignal classes). Rules attach to signals or tags. This document assumes
  only that the model provides `signalsOf(net)`, `netsOf(signal)`, `tagsOf(signal)`, stable signal ids,
  and a change journal for signals and tags.
- [Impedance directives](impedance-directives.md). It covers the schematic **directive** object and the `90 Ω diff`
  case end to end. This document makes that directive the general carrier for any rule or tag set from
  the schematic (§1.5). It also folds that proposal's `impedance_check` tool into one `check` tool (§2.8).

The PM brief was: "Unified rule editor for both schematics and layout. Or Fusion? Unified DRC engine. Lots
of companies treat schematics and PCBs as separate products, they are not."

## 0. Verdict and where we stand

**Verdict.** Waffle already has most of the parts. It has five check engines, four result surfaces, three
waiver stores and eight places to edit rules. Each part was built well for its own domain, and the result
feels like separate products. The fix is consolidation of the envelope. The checks themselves mostly stay
as they are: one rule store, one check registry with one scheduler, one violation shape, one problems list,
one waiver model, one editor, one MCP tool. The checks are wrapped first and changed later, so every phase
can be proven equivalent to today's results.

### 0.1 What exists today

| Concern | Schematic | Layout | Notes |
|---|---|---|---|
| Rule store | `project.erc` = `{version:1, scope, checks:{id:level}, matrix}` (`erc.js`) | `doc.rules` else `project.rules`, `atrium-rules` v2 (`rules.js`, 43 rule types, priorities, scopes, rule sets 1.3) | The board store *replaces* the project store. It does not merge with it. |
| Other rule-like stores | No ERC markers (`kind:"noerc"`); `netClass`/`diffPair` properties on labels and wires | `board.lengthTuning` (xSignals, classes, groups, targets); fab preset limits (`fab-presets.js`) for DFM; `project.ruleSets` library sets | xSignal-scoped rules are skipped by `rules.drc` and re-dispatched to `xsignals.js` (`XS_SCOPE`, rules.js:569). |
| Engines | `AtriumERC.run` (20 checks + 8×8 pin matrix, whole project, on Compile only) | `AtriumRules.drc` (batch), `AtriumDRCView.online` (journal-driven, 30 ms budget), `AtriumDRCFixes.checks` (2 extra checks), `AtriumDFM.run` (15 checks, fab limits, own cache), `AtriumXSignals.drc` | `AtriumInsights` (13 PCB + 6 schematic hints) has the **best** registry: `register({id, kind, scope:"net"/"area"/"doc"/"pour", heavy, run})`, generator checkpoints, idle slices. |
| Severity | No Report / Warning / Error / Fatal per check | Implicit error; `warning:true` on two extras | DFM: error/warning. Insights: tip/advice. Messages classes: Fatal/Error/Warning/Info. |
| Editors | Project Options dialog: Error Reporting and Connection Matrix (modal) | Rules and Constraints Editor (`rules.js` `open`, modal `<dialog>`, "PCB Rules and Constraints Editor"), Constraint Manager (modal), Rule Sets (modal), xSignals Wizard (modal), Length Tuning manager, fab presets | Insights settings live in Preferences. |
| Shown as | Messages rows (group "Compiler") only; no markers on the sheet | Board markers, Violation inspector, F8, fixes with preview, waivers (`drc-markers/-inspector/-fixes/-waivers.js`) | Insights have violet markers in both editors, Alt+F8, a card and a Messages group. |
| Waivers | None. No ERC markers suppress pins, and per-check levels suppress whole checks | `doc.drcWaivers`. A waiver is **deleted silently** when any object's geometry signature changes (`prune()`) | `project.insights.dismissed` uses a coarse sig chosen by the check, which survives a move. This is the better model. |
| Diff | — | `diff-model.drcDelta` re-runs batch DRC on both sides; waivers are ignored | No ERC delta. |
| MCP | `run_erc` | `run_drc`, `drc_waivers`, `list_rules`, `get_rule`, `propose_rule_change`, `board_rule_sets`, `activate_rule_set`, `constraints`, `xsignals`, `dfm_check`, `check_board_rules`, `list_source_rules` | `list_insights` |
| Schematic → rules | `eco.directives()` turns `netClass`/`diffPair` label properties into ECO rows that **copy** classes and pairs into board rules | | The schematic has no visible directive object (impedance-directives §1). |

### 0.2 Duplicated checks (same physical question, different answers)

| Question | Answered by | Proposal |
|---|---|---|
| Annular ring | DRC `annularRing`, DFM `ring`, Insight `ringMin` | One check. The required value is the stricter of the rule and the fab limit, and the message says which one bound it. The insight becomes the hint tier of the same check ("at the minimum, no margin"). |
| Hole to hole | DRC `holeToHole`, DFM `holeToHole` | One check, as above. |
| Silk over exposed copper | DRC `silkToMask`, DFM `silkPad`, Insight `silk` | One check. |
| Floating input pin | ERC `floatingInputs`, Insight `floatingInput` | One check. The hint tier runs live while editing. Compile reports the same object at error severity. |
| Single-pin net | ERC `singlePinNets`, Insight `singlePin` | As above. |
| Acid trap | DFM `acid`, Insight `acuteAngle` | One check. |
| Copper near edge | DRC `boardOutlineClearance`, DFM `drillEdge`/`maskSliver`, Insight `edgeCopper` | One check for copper to edge. Drill to edge stays its own check. |

Today a user can get three different messages, in three styles and three panels, for one under-sized via
ring. The user sees that as three products.

## 1. One rule model

### 1.1 Fusion, Altium, KiCad: what to copy and what to avoid

**Autodesk Fusion Electronics (formerly EAGLE)** is the right reference for *cohesion*, and the wrong one
for *rule power*.

What Fusion does well:

- **One design.** Schematic, board and 3D board are views of one electronics design. Each has its own
  editor, but the editors share one shell, one inspector style and one command vocabulary.
- **Always-on forward and back annotation.** An edit on either side updates the other immediately, so the
  two sides stay consistent.
- **Net classes defined once.** A class is assigned in the schematic, carries width, clearance and drill,
  and the board uses it directly. A class-to-class clearance matrix completes this. To most users this is
  "the rules" and it is shared by construction.
- **Approvals.** ERC and DRC findings can be *approved*, and the approval is stored in the design. This is a
  waiver model that both domains share.

What Fusion does badly:

- **Flat, board-only DRC.** The DRC rule set (EAGLE `.dru`, tabbed by Clearance, Distance, Sizes, Restring
  and so on) is one flat set per board. It has no query scopes and no priorities, and it can't express
  rules by component, area or layer beyond a few fixed fields. Heavy Altium users hit the ceiling in an
  afternoon.
- **ERC is thin.** It covers the basics, and its configuration is coarse next to Altium's per-check levels
  and connection matrix.
- **Brittle consistency.** EAGLE's annotation broke when one file was edited without the other open, and
  the consistency repair was manual and painful. Fusion's single design container mostly removed this, but
  at the price of the cloud data model.
- **High-speed constraints.** Diff pairs are mostly a naming convention, and matched groups, xSignal-like
  paths and delay rules are limited.

Where I am unsure (to verify before we cite Fusion to users):

- whether Fusion 2024–2026 releases added query-style rule scoping or a constraint-manager-like view;
- whether its approvals survive moves, or are keyed to location as EAGLE's were;
- how far its newer stack-up and impedance tooling feeds DRC.

**Altium** has the power that we already copied: query scopes, priorities, 40+ rule types, rule sets and
xSignals. Its cohesion story is weak. ERC lives in Project Options, rules live in a PCB-only dialog, and
schematic Parameter Sets with "PCB Rule" parameters reach the board only through an ECO. The Constraint
Manager in Altium 22 and later, which opens from both editors and edits classes, pairs and rules, is Altium
admitting the problem.

**KiCad 6 and later** is the nearest to unified. Net classes live in the project file and are shared by
Schematic Setup and Board Setup. ERC and DRC severities use one model, exclusions with comments are stored
in the project for both, and custom DRC rules use a condition language.

**Waffle's position.** Take Fusion's "one design, one set of signals and tags, one shell". Keep Altium's
rule power and Altium's explicit ECO for *structural* change (parts, nets, footprints), because the user
relies on it. Then go further than both: **rules are project data, not board data**, so they need no sync
at all.

### 1.2 The decision that makes it work: rules live in the project

A rule describes intent ("USB_D is 90 Ω differential", "unconnected pins are warnings except on test
points"). Intent has no side. So:

- The **one store** is `project.rules`, version 3. Each rule says where it applies (§1.3).
- Boards keep no rule copies. A board can still have board-specific rules. Such a rule is a project rule
  restricted to that board (`boards: [docId]`).
- Changing a rule or a directive is an ordinary undoable edit that both editors see at once, with **no
  ECO**. Nothing on the board moves, so the edit needs nothing to approve. The Problems list shows the
  consequences right away. The ECO keeps its job for parts, nets and footprints.
- Multi-board projects work naturally: a shared rule applies to every board, and `boards` narrows it.

This turns the existing "board rules else project rules" precedence into a merge, and that change has to
be lossless. §1.6 shows that it is.

### 1.3 The rule record (v3)

v3 is v2 plus five optional fields. Every v2 rule is a valid v3 rule with the same meaning.

```js
{
  id, type, name, comment, enabled, priority, set?,       // as v2 (priority 1 = highest, per type)
  scope:  Scope, scope2?: Scope,                          // as v2, plus the new subject kinds below
  ...constraintFields,                                    // as v2, per TYPES[type].fields
  severity?: "fatal" | "error" | "warning" | "hint" | "off",   // default from the type (error for v2 types)
  where?:   "schematic" | "layout" | "both",              // default from the type; narrows only
  boards?:  [docId],                                      // layout: only these boards (default: all)
  sheets?:  [docId],                                      // schematic: only these sheets (rare)
  origin?:  {kind: "directive", doc, item} | {kind: "fab", preset}
          | {kind: "altium", record} | {kind: "template", name} | {kind: "user"}
}
```

**Scope.** It stays `{kind, value}` so that Altium round-trips and the simple pickers keep working.
`kind: "query"` takes any expression. Every kind compiles through one query AST (`scopeQuery` already
writes each kind as a query). New kinds come from the Signal model: `signal`, `tag`, `sheet`, `pin`,
`room`. `netclass`/`diffpairclass` keep working and resolve to tags.

**Subjects.** Today `ruleMatcher` evaluates PCB-shaped objects `{net, pair, span, layer, component}`. v3
evaluates a **subject**, a common shape that both domains produce:

```js
{domain: "sch"|"pcb", kind, id, doc, net, signal, tags, component, pin, sheet, layer, span, box}
```

`query.js` already parses schematic predicates (`IsPin`, `IsWire`, `IsNetLabel`, `OnSheet`). What changes
is that a predicate becomes false, not an error, on a subject that lacks the field: `OnLayer` on a pin, for
example.

**Type metadata.** Each type in `TYPES` gains:

- `domains`: which of schematic and layout have a check for it;
- `severities`: which severities make sense;
- `defaultSeverity`.

ERC checks become rule types in a new **Schematic** category: `ercUnconnectedPins`, `ercFloatingInputs`,
`ercPinMatrix` (the 8×8 matrix is its field), and so on. `project.erc.checks[id] = level` maps 1:1 to one
`All`-scoped rule per check with that severity.

The real gain is that **ERC can now be scoped**. "Unconnected pins: off for
`InComponentClass('TestPoints')`" or "Output to Output: allowed on `HasTag('OD_BUS')`" are ordinary rules.
Today Altium and Waffle can only do this with a No ERC marker on every pin.

**Severity tiers.**

| Tier | Meaning | Gates Release | Look |
|---|---|---|---|
| fatal, error | Must fix or waive | yes | red ring (layout), red underline and glyph (schematic) |
| warning | Should look at | configurable (default no) | amber triangle |
| hint | Insight: valid but not ideal | never | violet diamond, quiet (as `insights-ui.js` today) |
| off | Not checked | — | — |

Insights are therefore checks at the **hint** tier, not a separate system. They keep their quiet look, the
"never counted" promise, per-user thresholds in Preferences, and dismissals. Two new verbs join them:

- **Promote to rule** turns an insight into a project rule at warning severity. Example: "decoupling cap
  farther than 3 mm is a warning on this project".
- **Demote to hint** goes the other way.

### 1.4 Where a rule applies: authored from either editor

`where` is derived from the type and only narrows. A clearance rule is layout-only, `ercFloatingInputs` is
schematic-only, and `impedance` is both. Both means:

- **schematic**: intent consistency. Examples: a diff spec on a single signal, two directives with
  conflicting specs, a tag rule that matches no signal.
- **layout**: geometry. Examples: width and gap out of the window, a missing reference, the neck budget
  exceeded.

The editor is the same window from both editors (§1.7). It opens on the right rules for the current
selection:

- in the schematic, right-click a net, signal, pin or part › **Rules for This…**;
- in the PCB, right-click › **Rules for This…** (Altium's "Applicable Rules").

The editor shows every rule that matches the selection, in priority order. It marks the winner and the
rules it shadows, and says why each one matches.

### 1.5 Directives are rule and tag sources placed on the schematic

`impedance-directives.md` defines `kind: "directive"`, a flag with a hotspot that touches a wire, label,
port or bus. Generalise it: the directive item carries any of the following.

| Field | Produces | Today's equivalent |
|---|---|---|
| `tags: ["HS", "USB"]` | tags on the touched signal (Signal model) | `netClass` property → ECO `netClass` row |
| `diffPair: "USB_D"` | a diff signal | `diffPair` property → ECO `diffPair` row |
| `impedance: {...}` | an `impedance` rule on the signal | (impedance-directives §2) |
| `rules: [{type, ...fields, severity?}]` | rules scoped `InSignal('<touched>')` | Altium Parameter Set "Rule" parameters (dropped on import today) |
| `waive: ["ercUnconnectedPins", ...]` | a scoped `off` rule for these checks on the touched net | No ERC marker (which stays a separate, simpler object) |
| `params: {...}` | parameters on the signal (current, voltage) | `netCurrents` in rules v2 |

**Derived, not copied.** A directive's rules and tags are computed from the sheets whenever the rule set
compiles, the same way component classes per sheet and per room are generated today
(`component-classes.js`). They are never written into `project.rules.list`. Two consequences:

- Deleting the directive removes its rules. There is no stale copy and no ECO delta logic, which today's
  `eco.directives()` needs for renames and removals.
- The rules editor lists derived rules read-only, with an `origin` link ("from directive on sheet Power,
  near U3") and **Detach**, which turns the rule into an ordinary stored rule.

The same "rule source" mechanism serves:

- **fab presets**: DFM limits become rules with `origin:{kind:"fab"}` (§2.6);
- **Altium source records**: `doc.sourceRules`, already shown under "Altium Source Rules";
- **ECSet templates** (Constraint Manager);
- **set-aside newer-version rules**.

The compiled rule set is `stored ∪ derived`. The priority of derived rules follows impedance-directives
§4.2: above `All` and class rules, below component, room and query rules.

### 1.6 Migration: lossless, in memory, and old builds still read new files

The [format versioning](../format-versioning.md) rules: opening never rewrites the file, a minor version only *adds*, and a
reader accepts every older version. The plan is format **1.4** (minor) with **mirrors**. The precedent is
already in the code: rules v2 still writes `defaults` and `nets` as a "derived summary … for older readers"
(rules.js header).

**Reading (any older file → v3 in memory, `AtriumCompat.upgrade`):**

1. Each board with `doc.rules` contributes its rules with `boards: [thatBoard]`, plus its net classes,
   pairs and rule sets.
2. The old `project.rules` was the fallback for boards *without* their own rules. Its rules get
   `boards: [those boards]`. A project with no boards keeps them unrestricted.
3. `project.erc` becomes Schematic-category rules (one per non-default level, plus the matrix rule), with
   the same `scope` setting.
4. Name collisions between boards (two "Clearance" rules) are kept. Ids are unique, and names may repeat
   once `boards` differs.

This is exact. Every board ends up under the same effective rules as before, by construction. The
equivalence test (`tests/rules-v3-migrate.cjs`) runs batch DRC and ERC on every corpus file before and
after and requires identical violations.

**Writing (`forSave`):**

- `project.rules` is written as v3 (authoritative).
- Each board's `doc.rules` is written as a **mirror**: the v2 flattening of the rules that apply to that
  board, stamped `mirrorOf: <hash of the v3 set>`.
- `project.erc` is written as a mirror of the schematic rules that `project.erc` can express.

**Reading a 1.4 file in a 1.3 build:** the old build reads the mirrors and gets the same DRC and ERC.
Fields it doesn't know are kept on save, as for any newer-minor file.

**An old build edits a 1.4 file:**

- The mirror hash no longer matches. The 1.4 build sees which board changed.
- It takes the mirror's rules for that board, applies them as a delta against v3, and shows one Messages
  row: "Board rules were edited in an older Waffle; 2 rules updated."
- Nothing is dropped. A mirror rule with no v3 counterpart is added with `boards: [board]`.

**Altium import and export:**

- **PCB import** (`fromAltium`, `replaceWithSource`): imported rules get `boards: [this board]` and
  `origin:{kind:"altium", record}`. The record is kept, so re-export writes the original line when the rule
  is unchanged. This is lossless for the record types we can't model.
- **Schematic import:** Parameter Sets (SchDoc record 43) with rule parameters become directive items
  instead of being dropped.
- **Export** (`altium-export.js`) writes `boards`-matching effective rules to each PcbDoc, and directive
  rules as Parameter Sets on the SchDoc. Waffle-only fields (`severity` on layout rules, `where`, `hint`)
  go into the rule `COMMENT` as a tagged suffix, `[atrium:{...}]`, so an Altium round trip brings them back.
- ERC levels map to Altium's Error Reporting entries where an equivalent exists, in a `.PrjPcb` export.
  Scoped ERC rules have no Altium equivalent and are reported in the export notes.

### 1.7 One editor

**Rules and Constraints** is one window, opened from either editor:

- Design › Rules and Constraints… (`D R` in both, the Altium chord);
- Project › Project Options › Error Reporting, which opens it on the Schematic category.

It is **non-modal**: a document tab, or a large dock panel, like the Constraint Manager in Altium 22. Today
`rules.js` opens a modal `<dialog>` with `showModal()`, so the board cannot be inspected while rules are
edited. The proposal keeps the board available while editing rules.

| Region | Content |
|---|---|
| Left tree | Categories with domain badges (S, L, S+L): Electrical, Schematic (ERC), Routing, High Speed, Clearance, Manufacturing (fab limits merged in), Placement, Rigid-Flex, Hints. Then Signals & Tags (from the Signal model), Rule Sets, Sources (Directives · Fab preset · Altium records · From a newer version) |
| Views (tabs) | **Rules**: Altium's priority list and the rule form, as today. **Constraints**: the Constraint Manager spreadsheet by signal or tag, which already writes rules (`constraints.js` `setCell`). **Matrix**: clearance class-to-class, pin connection, DFA spacing |
| Right | **Applies to**: live, lazily computed membership and coverage (the "scope matches nothing" notes today) and the current violation count per rule. Clicking the count filters Problems |

Existing modules keep their engines and lose their dialogs:

- `constraints.js` `open()` becomes a view;
- `erc.js` options pages become the Schematic category;
- `rule-sets.js` and `rule-groups.js` become the Rule Sets node;
- the xSignals Wizard stays a wizard, and its output appears under Signals & Tags.

## 2. One checking engine

### 2.1 The registry

New lazy module `app/checks.js` (`AtriumChecks`). It grows out of the `insights.js` engine, which already
has the right shape. Insights becomes its first client.

```js
AtriumChecks.register({
  id: "layout.clearance",            // stable, namespaced: schematic.* layout.* cross.* (never renamed)
  title, help,                       // i18n keys
  ruleTypes: ["clearance"],          // rule types it enforces ([] for rule-less checks: netAntennae, sync)
  domains: ["layout"],               // which documents it reads and reports on
  tiers: ["error", "warning", "hint"],
  module: "AtriumRules",             // lazy global holding run(); the registry entry itself is tiny
  needs: ["items", "nets", "rules", "stackup", "pours"],  // invalidation keys (2.3)
  incremental: "area",               // area | net | signal | sheet | doc | project
  reach: rules => mm,                // area checks: how far a change can matter
  cost: "cheap" | "heavy",
  *run(ctx, dirty) { yield* violations }   // generator; each yield is a pause/abandon checkpoint
});
```

`ctx` is `{project, doc | docs, defs, rules (compiled, resolver), signals, connectivity, spatial, cache}`.
`cache` belongs to the check and is kept per document. Examples are DFM's per-object feature cache and
online DRC's signatures.

`dirty` is either `null` (everything) or:

```js
{docs: {[docId]: {ids, boxes, nets}}, signals: Set, sheets: Set, rules: Set<ruleId>}
```

It is built from `AtriumUndoStore.changed(doc, since)` per document, the signal and tag journal, and a diff
of the compiled rule set.

A check returns violations only for its dirty region. The engine replaces exactly that region's previous
violations. This works the same way `drc-view.online` does today, through the subject keys.

**Registration is data. Implementation is lazy.** The registry entries for every check are about 6 KB of
JSON-like metadata in `checks.js`. The check code stays in its current module (`rules.js`, `erc.js`,
`dfm.js`, `insights-*.js`, `xsignals.js`, `z-clearance.js`, `flex-drc.js` …) and loads on the first run that
needs it. Nothing is added to the eager bundle (§2.9).

### 2.2 One violation format

```js
{
  key,                      // stable identity: check | ruleId | sorted object ids | check-chosen sig (2.5)
  check, ruleId?, ruleName?, ruleSet?, origin?,   // origin: the rule's source (directive, fab, altium)
  severity,                 // fatal | error | warning | hint (after rule + waiver)
  objects: [{doc, id, role?}],          // role: "a" | "b" | "pad" | "directive" …
  at: [{doc, point}],                   // marker positions, any number of documents
  subject?: {net?, signal?, tags?, component?, sheet?},
  measure?: {actual, required, limit: "min"|"max", unit: "mm"|"ps"|"ohm"|"A"|"°C"|"%"|"count", target?},
  text: {key, args},                    // i18n; one sentence ("Clearance 0.186 < 0.2 mm · A2.2 ↔ Track")
  detail?, fixes?: true,                // fixes are computed lazily by drc-fixes on demand
  waiver?: {id, state}                  // set by the waiver layer, not the check
}
```

Adapters convert today's shapes:

- DRC `{type, ruleId, id, otherId, actual, required, at, otherAt, title}`;
- ERC Messages rows `{class, check, objectId, point}`;
- DFM `issues`;
- insights `{objects, at, message, sig}`.

Old exports are then generated from the new shape. `run_drc` output stays byte-compatible.

### 2.3 Scheduling: one scheduler, incremental first

Today two schedulers exist, the online DRC in `drc-view.js` and the insights runner in `insights-ui.js`.
ERC has none and runs only on Compile. Replace them with one:

1. **Trigger.** An edit commits, or a rule, signal or tag changes. The journal `seq` advances. Nothing runs
   while documents are unchanged. This is the same contract as today.
2. **Dirty sets.** Per document, `changed(doc, since)` gives `ids`. The scheduler maps them to `boxes`
   (spatial index) and `nets` (old and new net of each item). The Signal model maps nets to signals. A rule
   change dirties only checks whose `ruleTypes` include the changed type, and only the subjects that the
   old and new scopes match. A journal gap (`ids: null`) or a large edit dirties the document fully, and
   the run is then sliced.
3. **Order.**
   - cheap checks on the active document's visible area;
   - then the rest of the active document;
   - then cross-domain checks;
   - then heavy checks, which in Efficiency mode wait for quiet (as insights do);
   - then the other documents.
4. **Slicing.** Each generator yield is a checkpoint. Slices last up to 8 ms in idle time and 6 ms when
   forced, the numbers that `insights-ui.js` uses. A newer edit abandons the run, and the abandoned run's
   finished parts are kept.
5. **ERC goes live** at the hint tier. `erc.graph` already builds per sheet. Re-running per touched net is
   cheap, and schematics are small next to boards. **Compile** runs the full set at the configured
   severity and writes a checkpoint for the release gate. Live and batch use the same code.
6. **Batch** (Tools › Check Design; also T D R and Compile, filtered) runs the registry with `dirty = null`
   through the same generators, without slicing and with a progress row in Problems.

### 2.4 Cross-domain checks

**The example: the schematic says 90 Ω diff, and the layout violates it.**

1. A directive on sheet *USB* produces a derived `impedance` rule scoped `InSignal('USB_D')`, with `origin`
   pointing to the directive.
2. `layout.impedance.width` (incremental `signal`) runs when USB_D copper changes. It reports violations
   whose `objects` are the offending track segments on the board.
3. **Projection.** The problems list knows the violation's `subject.signal` and `origin`. The schematic
   needs no second check. It shows a **summary marker** derived from the layout violations:
   - on the directive flag, as a red status dot (impedance-directives §3.1);
   - on the signal's net labels and ports on each sheet, found through the Signal model plus
     `AtriumCrossProbe.resolve`.

   The marker says "USB_D: 3 impedance violations on Board, 4.2 mm on L3". Clicking it cross-probes to the
   board and pins the first violation.
4. The problems list has **one row** with both locations. Choosing it in a split view moves both panes
   (split-follow.js).

**Projection rules.** Every violation is shown in the domain that owns its objects. It is also projected,
aggregated per (signal or component, rule), into the other domain when it has a `subject` that domain can
place: a net, a signal, a component or a pin.

- A layout clearance violation between U3 pad 4 and a GND track projects onto U3 in the schematic, but only
  in a quiet "has board violations" badge on the part, never as markers on wires.
- A schematic floating-input violation projects onto the board pad as a hint-tier marker. Users often fix
  that by routing to the right net on the board and then running Update Schematic.

Projection is lazy. It is computed only when the other document is open or the problems list is filtered
to it.

**Real cross-domain checks** (`cross.*`, domains `["schematic", "layout"]`):

| Check | Reads | Reports |
|---|---|---|
| `cross.sync` | the fingerprints that `sync-status.js` already takes | one violation per ECO difference ("Board out of sync: R12 footprint"). The status-bar indicator becomes this check's count, and Fix opens the ECO on that row |
| `cross.pinMatrix` | the board netlist (pad nets) + schematic pin types | the ERC connection matrix evaluated on the **board's** nets. This catches board-only net edits that short two outputs |
| `cross.intent` | Signal model + rules | a schematic spec that the layout can't meet at all (no profile row for any routed layer); a tag with layout rules whose signals have no copper yet (info) |
| `cross.footprintPins` | library + links | footprint pads that no symbol pin maps to, and the reverse (today split between ERC `missingFootprint` and ECO validation) |

### 2.5 Waivers that survive edits and show in diffs

One model, `app/waivers.js`, grown from `drc-waivers.js`. It shares its record shape with insight
dismissals.

```js
{id, check, ruleId?, objects: [{doc, id}], sig, at: {actual?, required?}, note, author?, date,
 holds: "while-not-worse" | "until-changed" | "always"}
```

**Holding semantics.** This is the main fix. Today *any* geometry change deletes the waiver silently.

- The **identity** of a waiver is the violation `key`. The key uses the check-chosen *meaning signature*:
  the objects, nets, layers and rule, but not positions. Insights already do this.
- **`while-not-worse`** is the default for measured violations. The waiver holds while the actual value is
  no worse than the waived actual, plus a tolerance. Waiving a clearance of 0.186 mm against 0.2 mm still
  holds at 0.19 mm after a nudge. It reopens at 0.15 mm.
- **`until-changed`** is today's behaviour. It suits unmeasured checks.
- **`always`** suits accepted design decisions. An example is a net tie that ERC flags.
- A waiver whose objects changed meaningfully, or were deleted, is **not deleted**. It becomes **stale**.
  Problems lists stale waivers in a "Waivers to review" group, with Keep, Re-waive and Remove. Stale
  waivers are removed only by the user or by an explicit "Remove stale waivers" command. Undo then has
  nothing to bring back, because nothing was deleted behind the user's back.

**Storage stays where the objects live**, so old builds keep their data:

- board-only waivers go in `doc.drcWaivers`, with new fields that older builds keep;
- schematic and cross-domain waivers go in a new `project.waivers` (version 1);
- insight dismissals stay in `project.insights`, read through the same API.

**Diffs.** Waivers are design data. `diff.js` gains a `waivers` category: added, removed and stale, each
with its note and author. `diff-model.drcDelta` becomes `checksDelta`. It covers ERC, uses violation keys
instead of rounded positions, and separates "new violation", "fixed" and "newly waived". Reviewers see
"3 violations waived in this revision", each with its note.

### 2.6 DFM, fab presets and length/xSignals in the same frame

- **DFM.** The fab preset becomes a rule source (§1.5). DFM checks register like any other check. Each
  required value is `max(rule, fab limit)`, and the message names the binding source. The DFM release gate
  becomes "checks with origin fab, severity error". `dfm.js` keeps its feature cache as its `ctx.cache`.
- **Length and xSignals.** `rules.drc` already re-dispatches xSignal-scoped length and delay rules to
  `xsignals.js`. Under the Signal model this special case disappears. Length, delay and matched rules are
  scoped to signals, and `layout.length.*` checks run with `incremental: "signal"`. The tuning gauges in
  `length-tuning.js` read the same violations, so the gauge and Problems can't disagree.
- **Net-wide checks** (`unrouted`, `length`, `matched*`) are kept out of online markers today
  (`NET_WIDE` in drc-view.js). They become `signal`-incremental checks. They show in Problems live and on
  the board only as the ratsnest or the length gauge.

### 2.7 One problems surface

**Messages** keeps its name, because Altium users look for it, and gets two views:

- **Problems**: the live state of every check, for the whole project. It replaces the groups "DRC",
  "Compiler", "DFM" and "Insights".
  - Filter chips: severity, domain (Schematic, Layout, Both), document, check, rule, *waived*, *stale
    waivers*, and "my selection" (problems touching the selection).
  - Grouping by rule (Altium), by document, or by signal.
  - Columns: severity, document(s), check, message, objects. Each row cross-probes.
- **Log**: one-shot outputs such as import notes, ECO reports, output jobs and imported-rules prompts. This
  is the current append-and-replace-group behaviour.

**One inspector.** `drc-inspector.js` becomes the Violation inspector for both editors, with the same
sections: severity chip, check, rule (linked to the editor), actual and required, objects (each selects and
frames, across documents), Fix…, Waive…, Show in Problems.

**One navigation.** F8 / Shift+F8 steps through errors and warnings, and Alt+F8 through hints, in *both*
editors. Today F8 is board-only.

Schematic markers are new. The schematic gets the layout's marker language, scaled for sheets:

- a severity glyph at the pin or label;
- the involved wires or pins outlined;
- hover writes one status-bar line;
- click pins the inspector.

There is no hover pop-up, which follows the user's stated preference and drc-feedback.md.

### 2.8 One MCP surface

| New tool | Replaces (kept as thin aliases, never removed) |
|---|---|
| `check {documents?, checks?, domains?, severity?, signals?, tags?, include_waived?, fresh?, offset, limit}` | `run_drc`, `run_erc`, `dfm_check`, `list_insights`, `check_board_rules`, and the proposed `impedance_check` |
| `waive {violation_key, note, holds?}` / `waivers {list, remove, stale}` | `drc_waivers` |
| `rules {list, get, applicable(object), propose(changes), sources}` | `list_rules`, `get_rule`, `propose_rule_change`, `list_source_rules`, `board_rule_sets`, `activate_rule_set` |

`check` returns the §2.2 violation shape. `fresh: false` reads the live store, so an assistant can poll
cheaply, as `run_drc` paging from the cached result does today (0.1 ms). The aliases map their old
parameters onto `check` and re-shape the output, and `tests/mcp-aliases.cjs` pins their output to today's
golden files. MCP tool names are an API, and we don't break them.

### 2.9 Performance budgets

The numbers are measured against `tests/perf` and the PiDP-11 Altium fixture. Each budget is enforced by a
test, never by a comment.

| Budget | Target |
|---|---|
| Eager JS added | **0 KB**. `checks.js`, `waivers.js`, the Problems view and schematic markers are lazy, prefetched on idle like `AtriumDRCView`. The status-bar count reads a 200-byte summary that the lazy engine publishes |
| Online feedback after a local layout edit (≤ 50 items) | first markers ≤ 30 ms after commit (today's online-DRC budget), never in the pointer frame |
| Online ERC after a schematic edit | ≤ 10 ms per touched net. A full project re-graph only on journal gaps |
| Slice length | ≤ 8 ms idle, ≤ 6 ms forced; abandon on newer edit |
| Rule change | re-check only subjects matched by the old or new scope of changed types. A width rule edit on one tag of 40 signals must not re-run clearance |
| Cross-domain projection | ≤ 2 ms per 100 violations, only for open documents |
| Batch "Check Design" | ≤ 1.1 × (today's batch DRC + ERC + DFM run separately). The shared extraction (`rules.extract`, DFM features) is built once per run instead of three times |
| Memory | violation store ≤ 2,000 per rule (today's cap) and ≤ 50,000 total; waiver matching O(waivers + violations) per update |
| Big boards | 10k parts and 100k tracks: no main-thread task over 50 ms during online checking (long-task observer in the perf probe) |
| Idle | nothing runs once the checks are done: no timer, idle callback or frame. `scripts/perf-sch.sh` (30 sheets) and `scripts/perf-sch.sh --board` (the 25.6k-object board, Efficiency mode by default, `EFFICIENCY=off` for the other) hold idle wake-ups to 1/s and 0.2/s and idle CPU to 2 % |
| Settling on the board | after open: quiet within 10 s and 1.5 s of main-thread CPU (measured 0.8–1.1 s on an M-series Mac on battery, both modes, all checks, connectivity and indexes); after one track edit: quiet within 12 s (8 s of it is the Efficiency-mode heavy delay) and 0.4 s of CPU (measured 0.15–0.22 s) |

**Idle, and the Efficiency-mode heavy pass.** In Efficiency mode an insights pass skips the cached heavy checks
(necks, return paths, pairs, crosstalk); the ones an edit concerned are *owed* (`AtriumInsights` state `owed`),
and the scheduler queues one heavy pass 8 s after the plan only when the client `owes(doc)` work. It clears the
timer when a pass ends with nothing owed. In 0.8.1 the heavy pass ran after every plan, and each of its idle
slices restarted it (`restart` was passed on to the continuation), so on the benchmark board it never finished:
about 95 starts a second at 99 % of one core, and the same on a 10k-item schematic sheet. `insights-incremental.cjs`
holds the incremental engine to a from-scratch pass after random edits from every source (local edits, Undo,
Redo, a collaboration peer's `derive`, paste, delete, rule edits), in both modes.

**Edits on a board with poured copper.** Every small edit inside a pour is followed by a live refill, and
the refill used to make three readers start over on the whole board: the pour clearance check
(`drc-pours.js`) re-measured every poured region against every copper object (about 0.5 s of CPU per edit on
the benchmark board), the resolved geometry serialised all poured copper twice to clone and compare it
(about 0.4 s), and online DRC re-extracted the board for Polygon Connect. Now one change set drives them:
the undo journal's changed items, and `AtriumPCBPours.copperChange(before, after)`, which says where the
copper of each polygon changed (a box per connected set of changed directed edges; canonical rings that did
not change are cancelled word for word). The pour clearance check is a session per board
(`AtriumDRCPours.session()`, the `pour-drc` client) that re-checks the changed items' copper, the objects
within the rule's reach of changed copper and the findings of polygons whose regions were replaced, on an
edge grid built only around them; it gives `verify()`'s violations in `verify()`'s order. The resolved
geometry copies each poured region once and keeps it while the region lives, compares refilled copper by
region, and reads a live board's copper report only when something reads its copper (online DRC reads item
extents, `delta.items`). `drc-copper-incremental.cjs` holds online DRC and the pour session to full checks
after random edits from every source with a refill after each. `scripts/perf-sch.sh --board pours` times
the edits (`editTaskMax`, `editSeriesCpuMs`); `--board nets` is the same board without pours.

Measured on an M-series Mac on AC power, three alternating launches per side, per small edit (move a part,
bend, add or delete a track, paste 4, undo, redo): the longest task after the edit went from 325–677 ms to
50–88 ms and the CPU until quiet from 1.0–1.7 s to 0.24–0.64 s, in both Efficiency modes. The checks
themselves now cost about 30–100 ms of that (online DRC 8–25 ms for a bend, the pour session about 10 ms,
the copper change and the geometry delta about 10–30 ms). The rest is not checking: the repaint of
poured copper (the longest tasks left, 50–88 ms canvas frames in CPU raster), garbage collection, the
autosave of the refilled region and the airwires. The same edits without pours cost 0.09–0.16 s and no
long task. What keeps the pours board above that is the copper model: one region per island, and the
board's top ground island is one region of 6,540 rings and 190,000 vertices (4 MB stored), so any edit inside it
rewrites, saves, decodes and repaints that whole region. A refill that changes copper only near the edit
needs regions bounded in size (pours stored and painted in tiles, the tiles a refill touches replaced),
with the canvas repainting only the copperChange boxes.

| Budget (`--board pours`) | Limit | Measured |
|---|---|---|
| `editTaskMax` (longest task after any edit) | 100 ms | 50–88 ms (before: 325–677 ms) |
| `editSeriesCpuMs` (most CPU of one edit) | 0.9 s | 0.46–0.64 s (before: 1.27–1.69 s) |
| `editWindowCpuMs` (the first edit after open, which runs the first pour check) | 1.4 s | 0.90–1.13 s (before: 1.33–1.58 s) |
| `openSettleCpuMs` (open, including pouring ten polygons) | 2 s | 1.16–1.50 s |
| `--board nets`: `editTaskMax`, `editSeriesCpuMs` | 50 ms, 0.4 s | 0 ms, 0.15–0.16 s |

## 3. Cohesion

### 3.1 Principles

1. **Same concept, same word, same place.** If both domains have it (selection, net, designator, rule,
   violation, filter, inspector), it has one name, one inspector section layout and one shortcut.
2. **Domain-specific is fine. Domain-different is not.** The schematic may lack layers. It may not have a
   different way to show, step through or waive a problem.
3. **Every check result is reachable from both sides** when it concerns a net, signal, part or pin
   (§2.4 projection).
4. **Intent is shared live. Structure syncs by ECO.** Rules, tags, signals and waivers need no sync.
   Parts, nets and footprints keep the reviewed ECO.
5. **Quiet by default** in both editors: no hover pop-ups, the status-bar line, click to pin.
6. **One file shape for intent.** A rule written from the schematic and one written from the board are
   indistinguishable on disk, apart from `origin`.

### 3.2 Inventory of schematic ↔ PCB inconsistencies

This inventory comes from a read of the code (file:line cited) and is ordered by priority. **One
caveat on shortcuts:** where Altium itself gives a key different meanings per editor, Waffle keeps
Altium's meaning, because this user's muscle memory wins. Examples are Ctrl+H (select net on PCB),
+/− (layers on PCB) and Alt+click net highlight on sheets. Those rows are marked *keep*. Only
divergences that Waffle invented are fixed.

| # | Area | Schematic | PCB | Fix | Pri |
|---|---|---|---|---|---|
| 1 | Violations on canvas | ERC draws nothing on the sheet. Messages only, with no inspector and no status badge (`erc.js`, `erc.css`; `drc-view.js:456`) | markers, Violation inspector, Fix, Waive, badge | §2.7: schematic markers, shared inspector, badge in both | P0 |
| 2 | Live checking | ERC runs on Compile only, so rows go stale ("Compile again to refresh", `messages.js:252`) | online DRC by default | §2.3: live ERC | P0 |
| 3 | Next/previous violation | none | F8 / Shift+F8 (`keymap.js:419`, `when:"pcb"`) | drop `when`, bind in both | P0 |
| 4 | Naming the check | "Validate Project (ERC)" (menu), "Validate project (compile)" (keymap), "Compile" (C C), "Recompile", "Compile succeeded"; options named two ways | "Run Design Rule Check" (Tools only); `T D` on a sheet says "Open a PCB layout…" | Tools › **Check Design** (all checks) plus **Compile** (C C) and **Design Rule Check** (T D R) as filtered aliases that work from either editor. Project Options › Error Reporting opens the rules editor | P0 |
| 5 | Waivers | No ERC objects or a whole-check "No Report" level | per-violation waivers | §2.5, in both | P0 |
| 6 | Messages row click | double-click or Locate (`messages.js:142,247`) | single click focuses and zooms (`drc-view.js:334`) | single click in Problems, for every row | P0 |
| 7 | Multi-select editing | read-only count per kind (`editor.js:573`) | shared fields with `<varies>`, kind chips, rule clamp (`pcb-selection-inspector.js:52`) | port the PCB multi-edit to the schematic (shared helper, not a copy) | P1 |
| 8 | Severity words | Fatal/Error/Warning/No Report | Error/Warning/Waived; toasts say "N violations" vs "N errors, M warnings" | one ladder, §1.3; one toast format: "3 errors · 5 warnings · 2 waived" | P1 |
| 9 | Error colours | Messages `--msg-error #e2655b` | markers `#ff5a52`; fallback overlay Altium green `#00ff00` (`drc-view.js:27`) | theme tokens `--sev-fatal/-error/-warning/-hint/-waived`, used by markers, Messages and the inspector | P1 |
| 10 | Hover behaviour | insight cards expand on hover by default (`insights-ui.js:5`) | DRC markers are click-only | click-only everywhere by default (user preference: no hover pop-ups); hover stays a preference | P1 |
| 11 | Part vs Component | "Part…" (context Place), "Parts" (Find Similar), hint "Place Part (P, P)" | "Component…", "Place Component (P, C)" | **Component** everywhere (Altium's word). "Part" remains only for multi-part symbol units | P1 |
| 12 | Directive visibility | `netClass`/`diffPair` exist on labels but can only be set through MCP (`sch-author.js:203`); the net-label inspector shows only Text | — | the directive item (§1.5), plus a Signal section in the label inspector | P1 |
| 13 | Net classes | Filter and Nets read classes from the *board's* rules (`query.js:868`) | owns them | project rules plus tags (Signal model) fix this by construction | P1 |
| 14 | Rotation label | "Angle (°)" (free number or 0/90/180/270), "Orientation" (power port) | "Rotation (°)" (text, multi-edit), "Angle (°)" (single part) | **Rotation (°)** everywhere, with one control (number plus 90° steppers) | P2 |
| 15 | Value / Comment | the same flag is "Show value" | "Show comment" (`part-inspector.js:53`) | one field name, "Comment" (Altium), with Value as a parameter | P2 |
| 16 | Locked | modelled (`sch-author.js:250`) with no UI | checkbox, menu and guards | expose Locked on the schematic, with the same guard path | P2 |
| 17 | Parameters | editable grid | read-only, "edit on the schematic" | keep the asymmetry (the schematic owns parameters), but render the same grid read-only with "Edit on sheet ↗" that cross-probes | P2 |
| 18 | Tab while placing | popover (`AtriumSchPlace.popover`) | focuses Properties, only when routing or placing a via; nothing while placing a component | Tab focuses the Properties pane in both, with no popover. The action label is no longer "Edit routing properties" on sheets | P2 |
| 19 | PCB List | none | `scope:"pcb"` (`dock.js:43`) | one **List** panel with domain-specific columns | P2 |
| 20 | Selection filter | kinds `SCH_KINDS`; no class filter | kinds and component-class filter (`pcb-edit.js:247,687`) | shared component and tag filters in both (tags from the Signal model) | P2 |
| 21 | Find Similar | `sch-similar.js` | `pcb-selection-inspector.js:110` | one implementation over subjects (§1.3) | P2 |
| 22 | Inspector form rows | at least five row helpers (`editor field`, `sheet-inspector row`, `pcb-text-inspector row`, `part-inspector lengthField`, `sch-object-forms ask`) | | one `AtriumNavCommon.field()` family, with the same unit-error text ("Enter a value such as 0.25mm or 10mil.") | P2 |
| 23 | Sheet symbol forms | modal dialogs (`sch-object-forms.js`) | Properties pane | Properties pane | P2 |
| 24 | Empty-selection pane | Sheet: Components, Wires, conflict note | Board: dimensions, layers, connectivity, hints | the same skeleton: Document · Counts · **Problems summary** (new, from the registry) · Next steps | P2 |
| 25 | Schematic colours | hard-coded inks, selection `#00a000` (`sch-appearance.js:9`) | user-editable View Configuration | theme tokens for schematic inks (later: a schematic View Configuration) | P3 |
| 26 | Context menu | Update PCB, Annotate, no Compile | Run DRC | "Check Design" and "Rules for This…" in both | P1 |
| 27 | Active Bar | only Junction and Net Label | full | add Power Port, Port, Text, Directive | P3 |
| 28 | Mod+F, L, G, A A, Ctrl+W, Mod+PgDn | find text, net label, grid cycle, Align…, wire, fit objects | flip board, flip side, grid picker, auto route, route, fit document | *keep* where Altium matches. Make G open the same grid picker in both. Make Mod+PgDn fit objects in both | P3 |
| 29 | Ctrl+H, +/−, Alt+click | find-replace, zoom, net highlight | select net, layers, Ctrl+click highlight | *keep* (Altium) | — |

Already shared and worth keeping as the foundation: the Messages panel, the selection-filter UI, Design
Insights, the Filter/query panel (F12), the Navigator, the Nets panel, Lasso, Selection Memory, Cross
Probe (T C), the keymap's `when` contexts, the dock and layouts, the single units toggle (Q), the shared
X/Y and designator fields (`inspectBody`), and Space rotate.

## 4. Phased plan

Each phase ends with every existing test green and an **equivalence test** that compares the new path
with the old one on the corpus (`tests/fixtures/compat`, the PiDP-11 Altium fixture and the sample
board). Phases 1–4 change no file format, which lets us ship the wins users can see before the format
work.

**Dependency.** The Signal model ships before phases 5 and 7. Phases 1–4 and 9 work on today's nets,
classes and xSignals.

| Phase | Commit | Owns (new / main edits) | Touches (small, shared) | Tests | Risk |
|---|---|---|---|---|---|
| **1 Registry and violation shape** (no UX change) | 1a `checks.js`: registry, violation shape, `key()`, adapters for DRC, ERC, DFM, insights, xSignals and drc-fixes extras | `app/checks.js` | `lazy.js` (register) | `tests/checks-adapters.cjs`: the adapter output equals the old engines on the corpus | adapter drift. Mitigation: golden files |
| | 1b insights run through the registry (the engine moves, `insights.js` keeps its API) | `insights.js` | `insights-ui.js` | `insights.cjs` unchanged | — |
| **2 One scheduler** | 2a scheduler: journal dirty sets, order, slicing, abandon | `checks.js` | `drc-view.js` (delegates `online`), `insights-ui.js` (delegates) | `drc-online-parts.cjs`, `insights.cjs`, new `checks-scheduler.cjs` (abandon, slicing, gaps) | performance regression. Mitigation: perf probe in CI, §2.9 |
| | 2b live ERC at the hint tier, per touched net | `erc.js` (`graph` per sheet, `runNets`) | `checks.js` | `erc.cjs` + incremental equals full | ERC graph cost on big hierarchies. Mitigation: per-sheet cache |
| **3 Problems surface** | 3a Messages › Problems and Log views, filters, single-click rows | `messages.js`, `erc.css` → `messages.css` | `drc-view.js`, `dfm.js`, `insights-ui.js` (emit to Problems) | `messages.cjs` (new) | users lose the familiar groups. Mitigation: "group by check" reproduces them |
| | 3b schematic markers and status badge | `sch-markers.js` (new, lazy) | `canvas.js` hook, `drc-markers.js` (shared glyph code moves to `check-glyphs` inside it) | probe screenshots, light and dark | sheet clutter. Mitigation: cap per sheet, aggregate per net |
| | 3c Violation inspector for both, F8 in both, "Check Design" / Compile / T D R aliases | `drc-inspector.js` | `keymap.js`, `index.html` menus, `context-menu.js` | `drc-inspector.cjs` + schematic cases | keymap conflicts. Mitigation: `scripts/gen-shortcuts.py` check |
| **4 Waivers** | 4a `waivers.js`: one record, holding semantics, stale state (no silent prune) | `waivers.js` (from `drc-waivers.js`, which stays as an alias) | `drc-view.js`, `output-jobs.js` | `drc-waivers.cjs` (old behaviour under `until-changed`) + `waivers.cjs` | waivers that used to vanish now persist. This is intended, and the release notes say so |
| | 4b ERC waivers (`project.waivers` v1); register in `AtriumCompat.stores` | `waivers.js`, `erc.js` | `compat.js` stores table | `compat-stores.cjs` fixture | — |
| | 4c diffs: `waivers` category, `checksDelta` with ERC | `diff.js`, `diff-model.js` | `diff-view.js` | `diff.cjs` cases | diff cost. Mitigation: reuse cached results when a side is the live doc |
| **5 Rule model v3, format 1.4** | 5a `validateV3`, subjects, new scope kinds, `severity`/`where`/`boards`/`origin` | `rules.js` | `query.js` (subject-tolerant predicates) | `rules.cjs`, `rules-altium-parity.cjs` | — |
| | 5b migration plus mirrors (`doc.rules`, `project.erc`), mirror-hash adoption | `compat.js` (`restoreRules` neighbour) | `model.js` CURRENT, `rule-sets.js`, `rule-groups.js` | **`rules-v3-migrate.cjs`**: DRC and ERC identical before and after on every corpus file; 1.3 build reads a 1.4 file (snapshot) | **highest risk**. A mistake changes DRC results. Mitigation: equivalence on the whole corpus, compat-guard, `.bak` not needed (minor) |
| | 5c ERC checks as Schematic-category rule types; scoped ERC | `erc.js`, `rules.js` TYPES | — | `erc.cjs` scoped cases | — |
| **6 One editor** | 6a non-modal Rules and Constraints window from both editors; Applies-to pane; Rules for This… | `rules.js` UI split into `rules-editor.js` (new, lazy; `rules-editor.css` exists) | `context-menu.js`, `keymap.js` | `rules-editor.cjs` (new), screenshot probes | big UI move. Mitigation: keep the old dialog reachable behind a pref for one release |
| | 6b Constraints view, ERC pages and Rule Sets folded in | `constraints.js` (view), `erc.js` (options pages) | `rule-sets.js`, `rule-groups.js` | `constraints.cjs` | — |
| **7 Directives as sources** (with impedance-directives) | 7a derived rules and tags from directive items; `eco.directives` reads the same collector and stops writing classes | `rule-sources.js` (new, lazy) | `eco.js`, `sch-objects.js` | `eco.cjs` directive cases; derived rule removal | double source while both paths exist. Mitigation: stored wins, plus an Insight |
| | 7b Altium Parameter Set import and export; `[atrium:{…}]` comment round trip | `sch-import.js`, `altium-export.js` | `rules.js` `fromAltium` | `altium-rules.cjs` round trip | Altium field coverage unknown. Verify on sample SchDocs first |
| **8 Dedupe and cross-domain checks** | 8a merge annular ring, hole to hole, silk, acid, floating input, single pin (§0.2); fab preset as a rule source | `dfm.js`, `insights-pcb.js`, `insights-sch.js` | `rules.js` | `dfm.cjs`, `insights.cjs` (merged ids alias old ids) | users miss a familiar DFM row. Mitigation: the message names the fab limit |
| | 8b `cross.sync`, `cross.pinMatrix`, `cross.intent`, `cross.footprintPins`; projection | `checks-cross.js` (new, lazy) | `sync-status.js`, `crossprobe.js` | `checks-cross.cjs` | false positives. Mitigation: start at warning |
| **9 MCP** | `check`, `waive`/`waivers`, `rules` tools; aliases pinned | `mcp/automation.py`, `mcp/commands.py` | `mcp/board-runner.js`, `mcp/headless.js`, `mcp/README.md` | `mcp-aliases.cjs` golden output for every old tool | client breakage. Mitigation: aliases are permanent |
| **10 Cohesion fixes** | inventory rows P0 → P3, one commit per row group | `editor.js`, inspectors, `keymap.js`, `sch-appearance.js`, `theme.css` | | per-row probes | many small edits in hot shared files. Mitigation: one owner per file per wave |

**Agent fan-out** (max 15, 3 for review, 2 for performance):

- Phases 1–2 are one owner, because `checks.js` is a single file.
- Phases 3a, 3b, 3c and 4 can run in parallel, with one owner each.
- Phase 5 is one owner plus one reviewer dedicated to the migration.
- Phase 10 rows are split by file.

The performance agents own the §2.9 probes from phase 2 onward.

## 5. Open questions for the user

1. **Rules without an ECO.** Should a directive or rule change from the schematic apply to the board
   *immediately*? I recommend yes: it is intent, and no copper moves. The alternative is a reviewed
   "Rules" group in Update PCB, as Altium does.
2. **Panel naming.** Should it be "Messages" with Problems and Log views (Altium's name), or a separate
   "Problems" panel (VS Code's model)?
3. **Default waiver holding.** Should a waiver hold "while not worse" (recommended), or keep today's
   strict "until any change"?
4. **Live ERC severity.** Should live ERC show at the hint tier and turn red only after Compile
   (recommended, to avoid red squiggles while wiring), or show real severities live?
5. **The single command.** Should "Check Design" (everything) replace Compile and T D R as the main
   command, with those kept as filtered aliases?
6. **Duplicated checks.** Should DFM and DRC merge into one check with the stricter limit (recommended),
   or should the fab check stay a separate, visible pass for release sign-off?
7. **Rule editor form.** Non-modal document tab (recommended) or a large dock panel?
8. **Terminology.** Should "Component" be used everywhere, and "Rotation" everywhere? Any Altium terms
   you want kept that I'd otherwise change?
9. **Fusion.** Do you want any of Fusion's always-on annotation for *structure* (parts, nets)? This
   proposal keeps the explicit ECO.
