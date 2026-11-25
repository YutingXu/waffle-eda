"""Hand-written notes for docs/extension-api.md (read by scripts/gen-extension-api.py).

The generator takes the list of calls, their permissions, parameter counts and the limits from
the source (app/core/atrium-api.js, app/extension-host/extensions.js). This file only adds words: a summary, a name
and description per parameter, the return value and an example. `--check` fails when a call in
the source has no note here, when a note names a call that no longer exists, or when the number
of parameters differs from the handler's signature.

Each note: summary, params [(name, type, description)], returns, example, and optionally
limits [LIMIT keys], notes (extra text), local=True (runs inside the worker, no message).
"""

AREAS = [
    ("project", "Project", "The open project as a whole."),
    ("documents", "Documents", "Schematic sheets and board layouts."),
    ("items", "Objects", "Parts, wires, tracks, vias, pads, labels and graphics on a document."),
    ("defs", "Library", "Component definitions (symbol, footprint, parameters) used by the project."),
    ("parts", "Parts", "Pins and pads of a placed component."),
    ("nets", "Nets", ""),
    ("selection", "Selection", ""),
    ("layers", "Layers", ""),
    ("units", "Units", "Lengths in the API are millimetres. These helpers convert for display and input."),
    ("geometry", "Geometry", "Pure helpers that run inside the worker. Points are [x, y] in mm."),
    ("query", "Queries", ""),
    ("rules", "Design rules", ""),
    ("transaction", "Edits", "Every change is a guarded proposal applied as one undo step."),
    ("proposals", "Edits", ""),
    ("commands", "Commands", ""),
    ("events", "Events", ""),
    ("motion", "Motion diagnostics", "Read-only window policy and simulation in the interactive editor."),
    ("ui", "User interface", "Panels are declarative data; the editor renders them."),
    ("storage", "Storage and settings", ""),
    ("settings", "Storage and settings", ""),
    ("files", "Files", ""),
    ("simulation", "Simulation", "Read-only signal-integrity inputs: routed copper per net, the field solver and the model files a project stores."),
    ("assets", "Files", ""),
    ("external", "External programs", "Programs the user installed and chose in Preferences › External Tools (run:external, desktop app only)."),
    ("transfer", "Files", ""),
    ("features", "Features", "Editor features exposed to extensions. Reads need read:project; edits go through proposals."),
    ("outputs", "Features", ""),
    ("log", "Logging", ""),
    ("version", "Logging", ""),
]
FEATURES = ["bom", "drc", "erc", "annotate", "pour", "route", "length", "fanout", "stackup", "autoplace", "routePlan", "planes"]

# Handlers reached through another call rather than directly.
INTERNAL = {
    "transaction.commit": "transaction",
    "commands.unregister": "commands.register",
    "events.subscribe": "events.on",
}

DOC = ("doc", "string", "Document id; the active document when omitted.")
OPTS_DOC = ("options", "object", "`{doc}`: document id (default: the active document).")

NOTES = {
    # ---------------------------------------------------------------- project
    "project.info": dict(
        summary="Name, units, revision and a summary of every document.",
        params=[], returns="`{name, units, apiVersion, revision, activeDocument, documents: [{id, name, kind, grid, itemCount}], libraryCount, extensions}`",
        example='const {name, documents} = await api.project.info();\nconsole.log(name, documents.length + " documents");'),
    "project.netlist": dict(
        summary="The schematic netlist as JSON, or as SPICE text.",
        params=[("options", "object", '`{format: "json" | "spice", doc}`. Without `doc`, every sheet (nets with the same name join across sheets).')],
        returns="`{project, components: [{id, ref, value, definition, footprint, sheet, pins: [{number, name, net, fn?, unit?}]}], nets: [{name, pins: [\"R1.1\", …]}]}`; with `format: \"spice\"` also `text`.",
        example='const net = await api.project.netlist({format: "spice"});\nconsole.log(net.text.split("\\n")[0]);'),
    # -------------------------------------------------------------- documents
    "documents.list": dict(summary="Every document.", params=[], returns="`[{id, name, kind: \"schematic\" | \"pcb\" | …, grid, itemCount}]`",
        example='const boards = (await api.documents.list()).filter(d => d.kind === "pcb");'),
    "documents.active": dict(summary="The document the user is looking at.", params=[], returns="`{id, name, kind, grid, itemCount, outline}`",
        example='const doc = await api.documents.active();\nif (doc.kind !== "pcb") throw Error("Open a board first.");'),
    "documents.get": dict(summary="One document, optionally with its objects.",
        params=[("id", "string", "Document id."), ("options", "object", "`{items: true, kind, fields, limit, …}`: include objects, filtered as in `items.list`.")],
        returns="`{id, name, kind, grid, itemCount, outline, notes, items?}`", limits=["MAX_ITEMS"],
        example='const d = await api.documents.get(id, {items: true, kind: "via", fields: ["id", "x", "y"]});'),
    "documents.activate": dict(summary="Switch the editor to another document.", params=[("id", "string", "Document id.")], returns="`true`",
        example='await api.documents.activate(boardId);'),
    # ------------------------------------------------------------------ items
    "items.list": dict(summary="Objects on a document, filtered. Returns copies.",
        params=[("filter", "object", "`{doc, kind, kinds, ids, layer, net, where: {field: value}, bounds: [x0, y0, x1, y1], fields, limit, offset}`. `fields` picks the properties to copy; use it, it keeps messages small.")],
        returns="`[object]`: each a copy with the requested `fields` (all fields when omitted).", limits=["MAX_ITEMS"],
        example='const tracks = await api.items.list({kind: "track", net: "GND", fields: ["id", "width", "points"]});'),
    "items.get": dict(summary="One object by id, from any document.",
        params=[("id", "string", "Object id."), ("options", "object", "`{fields}`.")], returns="The object plus `document` (its document id), or `null`.",
        example='const t = await api.items.get(id, {fields: ["width", "layer"]});'),
    "items.page": dict(summary="Return one bounded page and its total from the same document, ordering and filter.",
        params=[("filter", "object", "As items.list, including bounds, offset, limit and fields. The default page size is 50.")],
        returns="`{items, total, next_offset}`", example='const page = await api.items.page({kind: "track", offset: 50, limit: 25});'),
    "items.count": dict(summary="How many objects match a filter (no limit applies).", params=[("filter", "object", "As `items.list`.")], returns="`number`",
        example='const vias = await api.items.count({kind: "via"});'),
    # ---------------------------------------------------------------- library
    "defs.list": dict(summary="The project's component definitions.",
        params=[("options", "object", "`{fields}`. Without `fields`: `{id, name, prefix, value, category, symbol: boolean, footprint: name}`.")],
        returns="`[definition summary]`", example='const defs = new Map((await api.defs.list()).map(d => [d.id, d]));'),
    "defs.get": dict(summary="One definition in full: symbol, footprint (pads, shapes), parameters.", params=[("id", "string", "Definition id (a part's `def`).")],
        returns="The definition, or `null`.", example='const def = await api.defs.get(part.def);\nconsole.log(def.footprint?.pads.length);'),
    "parts.pins": dict(summary="Pins (schematic) or pads (board) of a placed component, in world coordinates.",
        params=[("partId", "string", "A part's id.")],
        returns="`[{number, name, x, y, w, h, shape, layer, angle, net}]` (`net` on boards, from the part's pin nets).",
        example='for (const pin of await api.parts.pins(partId)) if (!pin.net) console.log("unconnected", pin.number);'),
    # ------------------------------------------------------------------- nets
    "nets.list": dict(summary="Nets on a document.", params=[OPTS_DOC],
        returns="Boards: `[{name, objects}]`. Schematics: `[{name, pins, wires, conflict}]` from the sheet's connectivity.",
        example='const nets = (await api.nets.list()).map(n => n.name);'),
    "nets.items": dict(summary="The objects on one net.", params=[("name", "string", "Net name."), ("options", "object", "`{doc, fields}`.")],
        returns="`[object]`", example='const ids = (await api.nets.items("GND", {fields: ["id"]})).map(i => i.id);\nawait api.selection.set(ids);'),
    # -------------------------------------------------------------- selection
    "selection.get": dict(summary="Ids of the selected objects.", params=[], returns="`[id]`", example='const ids = await api.selection.get();'),
    "selection.items": dict(summary="The selected objects on the active document.", params=[("options", "object", "`{fields}`.")], returns="`[object]`",
        example='const parts = (await api.selection.items({fields: ["id", "kind", "ref"]})).filter(i => i.kind === "part");'),
    "selection.set": dict(summary="Select objects (unknown ids are ignored).", params=[("ids", "string[]", "Object ids.")], returns="`true`",
        example='await api.selection.set(hits.map(p => p.id));'),
    # ----------------------------------------------------------------- layers
    "layers.list": dict(summary="Copper and other layers in use on a board.", params=[OPTS_DOC], returns="`{copper: [\"Top\", \"Inner 1\", …, \"Bottom\"], other: [name]}` (empty lists on a schematic).",
        example='const {copper} = await api.layers.list();'),
    # ------------------------------------------------------------------ units
    "units.get": dict(summary="The project's display unit.", params=[], returns='`"mm"` or `"mil"`', example='const unit = await api.units.get();'),
    "units.toMm": dict(local=True, summary="Convert a value in a unit to millimetres.", sig="toMm(value, unit = \"mm\")",
        params=[("value", "number", ""), ("unit", "string", "`mm`, `mil` (`mils`, `th`, `thou`), `in`, `um`, `cm`.")], returns="`number` (mm, rounded to 1 nm)", example='api.units.toMm(10, "mil") // 0.254'),
    "units.fromMm": dict(local=True, summary="Convert millimetres to a unit.", sig="fromMm(mm, unit = \"mm\")",
        params=[("mm", "number", ""), ("unit", "string", "As `toMm`.")], returns="`number`", example='api.units.fromMm(0.254, "mil") // 10'),
    "units.format": dict(local=True, summary="Format millimetres for display.", sig="format(mm, unit = \"mm\", digits)",
        params=[("mm", "number", ""), ("unit", "string", ""), ("digits", "number", "Decimals (default 4, or 3 for mil).")], returns='`string`, e.g. `"10 mil"`',
        example='api.units.format(0.2032, "mil", 1) // "8 mil"'),
    "units.parse": dict(local=True, summary="Parse user input such as `10mil`, `0.2 mm` or `.1in` to millimetres.", sig="parse(text, unit = \"mm\")",
        params=[("text", "string", ""), ("unit", "string", "Unit when the text has none.")], returns="`number` (mm), or `NaN`", example='api.units.parse("8 mil") // 0.2032'),
    # --------------------------------------------------------------- geometry
    "geometry.distance": dict(local=True, sig="distance(a, b)", summary="Distance between two points.", params=[("a", "[x, y]", ""), ("b", "[x, y]", "")], returns="`number`",
        example='api.geometry.distance([0, 0], [3, 4]) // 5'),
    "geometry.rotate": dict(local=True, sig="rotate(p, deg)", summary="Rotate a point about the origin.", params=[("p", "[x, y]", ""), ("deg", "number", "Degrees, counter-clockwise.")], returns="`[x, y]`",
        example='api.geometry.rotate([1, 0], 90) // [0, 1] (approximately)'),
    "geometry.segmentDistance": dict(local=True, sig="segmentDistance(p, a, b)", summary="Distance from a point to a segment.", params=[("p", "[x, y]", ""), ("a", "[x, y]", "Segment start."), ("b", "[x, y]", "Segment end.")],
        returns="`number`", example='const gap = api.geometry.segmentDistance([v.x, v.y], t.points[0], t.points[1]) - t.width / 2;'),
    "geometry.pointInPolygon": dict(local=True, sig="pointInPolygon(p, poly)", summary="Whether a point is inside a polygon (even-odd).", params=[("p", "[x, y]", ""), ("poly", "[[x, y]]", "")], returns="`boolean`",
        example='const inside = api.geometry.pointInPolygon([x, y], (await api.documents.active()).outline);'),
    "geometry.bounds": dict(local=True, sig="bounds(points)", summary="Bounding box of points.", params=[("points", "[[x, y]]", "")], returns="`[x0, y0, x1, y1]`, or `null` for no points",
        example='const box = api.geometry.bounds(doc.outline);'),
    "geometry.length": dict(local=True, sig="length(points)", summary="Length of a polyline.", params=[("points", "[[x, y]]", "")], returns="`number`",
        example='const routed = tracks.reduce((n, t) => n + api.geometry.length(t.points), 0);'),
    # ---------------------------------------------------------------- queries
    "query.spatial": dict(summary="Objects whose bounds overlap a rectangle (uses the editor's spatial index).",
        params=[("bounds", "[x0, y0, x1, y1]", "mm."), ("options", "object", "`{doc, kind, kinds, fields, limit}`.")], returns="`[object]`", limits=["MAX_ITEMS"],
        example='const near = await api.query.spatial([x - 1, y - 1, x + 1, y + 1], {kinds: ["track", "via"], fields: ["id", "net"]});'),
    "query.connectivity": dict(summary="Connectivity of a document.", params=[OPTS_DOC],
        returns="Schematics: `{nets: [{name, pins, wires, conflict}], byPin: {\"partId/pin\": net}, byWire: {wireId: net}}`. Boards: the editor's connectivity report as plain data.",
        example='const c = await api.query.connectivity();\nconst net = c.byPin[part.id + "/" + pin.number];'),
    "rules.query": dict(summary="The design rule that applies to a net or pair of nets.",
        params=[("type", "string", 'Rule type, e.g. `"width"`, `"clearance"`, `"viaStyle"`.'), ("options", "object", "`{doc, net, layer, net2}`.")],
        returns="The rule's values as plain data (for example `{min, preferred, max}` for width).",
        example='const w = await api.rules.query("width", {net: "VIN", layer: "Top"});'),
    "rules.get": dict(summary="The board's rule set.", params=[OPTS_DOC], returns="The rules object (or the defaults).", example='const rules = await api.rules.get();'),
    # ------------------------------------------------------------------ edits
    "transaction": dict(local=True, via="transaction.commit", sig="transaction(label, fn)",
        summary="Collect edits and apply them as one guarded proposal and one undo step.",
        params=[("label", "string", "Undo label (optional; `transaction(fn)` works)."),
                ("fn", "function(tx)", "Called once with `tx`: `add(item, {doc}) → id`, `update(id, patch)` (`null` deletes a field; `id` and `kind` never change), `move(id, dx, dy)`, `transform(id, {x, y, angle})` (parts), `remove(id | ids)`, `setDocument(doc, {name, grid, outline})`, `addDefinition(def) → id`, `select(ids)`. May be async.")],
        returns="`{applied, added: [ids], removed, result}`; `{applied: 0, declined: true}` when the user discards a review. `result` is what `fn` returned.",
        limits=["MAX_OPS_TRANSACTION"],
        notes="Every operation is checked against the model rules and the whole project is validated afterwards; if anything fails, nothing changes and the error names the operation. With `propose:edits` the user reviews the changes and may keep a subset. Reads inside `fn` see the project as it was before. Object kinds that can be added: part, wire, track, graphic, label, netlabel, junction, via, pad.",
        example='const r = await api.transaction("Widen power", tx => {\n  for (const t of tracks) tx.update(t.id, {width: 0.5});\n});\nconsole.log(r.applied + " changes");'),
    "proposals.draft": dict(summary="Plan an edit once without applying it. The host retains the exact guarded operations for this actor and project. Requires read:project as well as an edit capability.",
        params=[("action", "string", "transaction, annotate.apply, pour, route, fanout, autoplace, routePlan or planes."),
                ("options", "object", "Feature options, or {label, ops} for transaction. Ops use op add (doc, item), update (id, set), move (id, dx, dy), transform (id, set), remove (id), document (doc, set) or definition (def).")],
        returns="`{handle, total, changes, ...report}` with at most 100 preview rows, or `{applied: 0}` for an unchanged design. A context holds up to 32 drafts and 8 Mi characters, evicting oldest first.",
        example='const draft = await api.proposals.draft("annotate.apply", {action: "update"});'),
    "proposals.review": dict(summary="Review one retained draft once. The editor always asks for an explicit selection, including for actors granted direct writes.",
        params=[("handle", "string", "The handle returned to this context by proposals.draft.")],
        returns="`{applied}` or zero with declined, stale, blocked, cancelled or revoked. A replaced project or changed planner input requires a fresh draft.",
        example='if (draft.handle) await api.proposals.review(draft.handle);'),
    "proposals.discard": dict(summary="Release a retained draft belonging to this context.", params=[("handle", "string", "A handle returned by proposals.draft.")],
        returns="True when the draft was present.", example='await api.proposals.discard(draft.handle);'),
    "proposals.submit": dict(summary="Submit an AtriumProposal v2 you built yourself, guarded by the values you read.",
        params=[("proposal", "object", '`{format: "atrium-ai", version: 2, project: name, ops: [{op: "set", target: "item" | "document" | "project" | "library", document, id, path: [...], before, after} | {op: "add" | "remove", …}]}`. Omit `before` for a field that is absent; omit `after` to delete.'),
                ("label", "string", "Undo label.")],
        returns="`{applied}`, or `{applied: 0, declined: true}`.", limits=["MAX_OPS_PROPOSAL"],
        notes="If any guarded value changed since you read it, the whole proposal is refused (\"… has changed since this proposal was drafted\"). Proposals can never write `extensions`, `scripts` or other code-bearing fields.",
        example='const t = await api.items.get(id);\nawait api.proposals.submit({format: "atrium-ai", version: 2, project: (await api.project.info()).name,\n  ops: [{op: "set", target: "item", document: t.document, id, path: ["width"], before: t.width, after: 0.4}]}, "Widen");'),
    "proposals.propose": dict(summary="Propose edits of whitelisted fields (see `proposals.fields`) for the user to review. The review shows each changed object as the visual diff does (Property, Before, After); the user picks the changes to apply, and they apply as one undo step. Nothing changes without that approval, even with `write:edits`.",
        params=[("edits", "object[]", '`[{target: "item", id, path: ["sim", …], value} | {target: "definition", id, path, value} | {target: "project", path: ["simulation", "benches"], value}]`. `value` `null` deletes the field. Paths name plain object fields; one edit per field.'),
                ("options", "object", "`{label}`: the review title and undo label.")],
        returns="`{applied}`, `{applied: 0, declined: true}`, `{applied: 0, unchanged: true}`; without a host that can ask (headless, scripts) `{applied: 0, proposal}`.", limits=["PROPOSE"],
        notes="The current values become the proposal's guards. If any chosen field changes while the dialog is open, Waffle refuses the chosen edits together. The whole project is checked by the model validator before the user sees it. A proposal the user discarded is final: proposing the same edits again fails with \"You already declined this change\" and shows no dialog.",
        example='await api.proposals.propose([\n  {target: "item", id: part.id, path: ["sim"], value: {model: "D1N4148"}},\n  {target: "project", path: ["simulation", "benches"], value: benches}], {label: "Save test bench"});'),
    "proposals.fields": dict(summary="The fields `proposals.propose` may edit, per target.", params=[],
        returns='`{item: {part: ["sim", "value", "parameters"]}, definition: [...], project: ["simulation"]}`', example='const fields = await api.proposals.fields();'),
    # --------------------------------------------------------------- commands
    "commands.register": dict(local=True, via="commands.register", sig="register(id, fn, meta = {})",
        summary="Handle a command. Declare it under `contributes.commands` so it appears in menus and the palette before activation.",
        params=[("id", "string", "Letters, digits, `.`, `-`, `_`."), ("fn", "function(...args)", "The handler; may be async. Its return value is the command's result."),
                ("meta", "object", "`{title, when}` for commands not declared in the manifest.")],
        returns="`{dispose(), ready: Promise}`", notes="Command ids are global: registering another extension's command fails.",
        example='api.commands.register("myExt.run", async () => { /* … */ });'),
    "commands.execute": dict(local=True, via="commands.execute", sig="execute(id, ...args)",
        summary="Run one of your own commands, or an `waffle.*` view command.",
        params=[("id", "string", "Your command, or one of: " + "`waffle.fit`, `waffle.zoom-in`, `waffle.grid`, `waffle.toggle-units`, `waffle.layer-mode`, …"), ("args", "...any", "Passed to the handler.")],
        returns="The command's result.", notes="Editor commands that edit, open or save are refused: changes go through transactions.",
        example='await api.commands.execute("waffle.fit");'),
    "commands.list": dict(summary="Every command id, with its title and owner.", params=[], returns="`[{id, title, owner}]`", example='const mine = (await api.commands.list()).filter(c => c.owner === context.extensionId);'),
    "motion.inspect": dict(summary="Read one motion diagnostic without accessing the project.",
        params=[("action", "string", "`policy`, `plan`, `sample`, `retarget`, or `active`."),
                ("args", "object", "The corresponding read-only Butter motion command arguments. Omit for `active`.")],
        returns="The command result, or `{count}` for the number of active tracks.",
        notes="Available on demand in an interactive editor. Reads no design fields or individual track details and changes no state.",
        example='const {count} = await api.motion.inspect("active");'),
    # ----------------------------------------------------------------- events
    "events.on": dict(local=True, via="events.subscribe", sig="on(name, fn)",
        summary="Listen to an editor event. Only subscribers receive events, and bursts are coalesced to the latest state.",
        params=[("name", "string", "`selectionChanged`, `documentChanged`, `activeDocumentChanged`, `projectSaved` (need read:project); `panelShown`, `panelHidden` (own panel only), and `settingsChanged` (no permission)."),
                ("fn", "function(payload)", "Called with the event's payload, e.g. `{count, ids}` for selectionChanged, `{id}` for panelShown and panelHidden.")],
        returns="`{dispose()}`. Push it into `context.subscriptions`.", notes="Revoking read:project stops design events at once. Panel lifecycle subscriptions alone do not keep a closed panel’s worker active.",
        example='context.subscriptions.push(api.events.on("documentChanged", () => refresh()));'),
    # --------------------------------------------------------------------- ui
    "ui.showMessage": dict(summary="Show a status message; optionally list rows in the Messages panel.",
        params=[("text", "string", "Status bar text."), ("options", "object", '`{level: "info" | "warn" | "error", messages: [{class: "Error" | "Warning" | "Info", text, objectId, point: [x, y]}]}`. `warn` and `error` also go to the extension\'s log.')],
        returns="`true`", limits=["MAX_REPORT"],
        notes="`messages` replaces this extension's group in the Messages panel. The group is always named \"<extension name> (extension)\", so an extension can neither replace nor pose as the editor's own checks; text is shown as text, `objectId` lets the user locate the object.",
        example='await api.ui.showMessage("2 problems", {level: "warn", messages: [\n  {class: "Warning", text: "No teardrop on VIN", objectId: track.id, point: track.points[0]}]});'),
    "ui.setStatus": dict(summary="Add or replace an item in the status bar.", params=[("id", "string", "Your item id."), ("item", "object", "`{text, tooltip, command, args}`; clicking runs `command`.")],
        returns="`true`", example='await api.ui.setStatus("count", {text: n + " vias", command: "myExt.show"});'),
    "ui.clearStatus": dict(summary="Remove a status bar item.", params=[("id", "string", "")], returns="`true`", example='await api.ui.clearStatus("count");'),
    "ui.registerPanel": dict(summary="Create a panel declared under `contributes.panels` (setPanel does this for you).",
        params=[("id", "string", "Declared panel id."), ("options", "object", '`{title, location: "right" | "dialog", tall}`.')], returns="`true`",
        example='await api.ui.registerPanel("results", {title: "Results"});'),
    "ui.setPanel": dict(summary="Set a panel's content: one view element or a list of them.",
        params=[("id", "string", "Declared panel id."), ("view", "object | object[]", "Elements: `heading`, `text` (`muted`, `level`), `code`, `kv` (`rows: [[k, v]]`), `table` (`columns: [{key, title, align}]`, `rows`, `rowCommand`; a row with `locate: id` selects that object, and a column of type `chip` displays cells with `{text, tone}`; optional `layout: \"details\"` displays label/value rows in narrow dock panels), `list` (`items: [{label, detail, locate | command}]`), `button`, `buttons`, `form` (`fields: [{key, label, type, value, options, wide}]`, `submit: {label, command, primary?}` (set `primary: false` for an outlined submit), optional `secondarySubmit: {label, command}` receiving the same field values), `plot` (`series: [{name, x, y, color, style: \"dash\" | \"faint\"}]` (a `null` y breaks the line), `size: \"large\"`, `xRange`, `yRange`, `hlines: [{y, label}]`, `vlines: [{x, label}]`, `legend`, `zoomCommand` (gets `{x0, x1}` for a drag or Ctrl/⌘+wheel, `{fit: true}` for a double-click) and `cursorCommand` (gets `{x, cursor: \"a\" | \"b\"}` for a click or Shift+click)), `stack`.")],
        returns="`true`", limits=["viewChars", "VIEW_NODES"],
        notes="Form fields accept an optional `error` as plain text. A form with `retainDraft: true` keeps its inputs during panel updates while its declaration is unchanged.",
        example='await api.ui.setPanel("results", [\n  {type: "heading", text: "Vias"},\n  {type: "table", columns: [{key: "net", title: "Net"}], rows, rowCommand: "myExt.pick"}\n]);'),
    "ui.showPanel": dict(summary="Open a panel.", params=[("id", "string", "")], returns="`true`", example='await api.ui.showPanel("results");'),
    "ui.closePanel": dict(summary="Close a panel.", params=[("id", "string", "")], returns="`true`", example='await api.ui.closePanel("results");'),
    "ui.addMenuItem": dict(summary="Add a menu item at run time (prefer `contributes.menus`).",
        params=[("item", "object", "`{command, title, menu: \"tools\" | \"reports\" | \"view\" | \"place\" | \"edit\" | …, when}`.")], returns="`true`",
        example='await api.ui.addMenuItem({command: "myExt.run", menu: "tools"});'),
    "ui.addActiveBarButton": dict(summary="Add a button to the Active Bar.", params=[("item", "object", "`{command, title, icon, when}`; `icon` names a built-in icon.")], returns="`true`",
        example='await api.ui.addActiveBarButton({command: "myExt.run", title: "Run", icon: "via", when: "pcb"});'),
    "ui.showInputBox": dict(summary="Ask for a line of text.", params=[("options", "object", "`{title, prompt, value, placeholder}`.")], returns="`string`, or `null` if cancelled.",
        limits=["DIALOGS"], example='const name = await api.ui.showInputBox({title: "Rename", value: "R1"});\nif (name == null) return;'),
    "ui.showQuickPick": dict(summary="Ask the user to choose one item.", params=[("items", "(string | {label, detail})[]", "At most 500."), ("options", "object", "`{title}`.")],
        returns="The chosen item, or `null`.", limits=["DIALOGS"], example='const pick = await api.ui.showQuickPick(["Top", "Bottom"], {title: "Layer"});'),
    "ui.confirm": dict(summary="Ask a yes/no question.", params=[("text", "string", ""), ("options", "object", "`{title, confirm: \"OK\"}`.")], returns="`boolean`",
        limits=["DIALOGS"], example='if (!await api.ui.confirm("Remove 12 vias?", {confirm: "Remove"})) return;'),
    "ui.locate": dict(summary="Select an object and centre the view on it.", params=[("id", "string", "")], returns="`true`", example='await api.ui.locate(track.id);'),
    "ui.decorations.set": dict(summary="Replace this extension's decorations on a document: read-only labels, probes and markers drawn above the design (operating-point voltages, probe points, markers). They never become design objects, never react to the pointer (no hover pop-ups) and are removed when the extension stops, is disabled or loses the permission.",
        params=[("doc", "string | null", "Document id; `null` for the active document."),
                ("items", "object[]", '`[{kind: "label" | "probe" | "marker", text, at: [x, y] | anchor: {id, pin?}, offset?: [dx, dy], tone?: "info" | "success" | "warning" | "danger" | "accent" | "muted", size?: "small" | "normal", id?}]`. An anchor follows its object (a part\'s pin, a part\'s origin or another object\'s centre); a decoration whose object is deleted is not drawn. `[]` clears the document.')],
        returns="`{document, count}`", limits=["DECORATIONS"],
        notes="Text is drawn as plain canvas text: markup is not interpreted, and control, bidirectional-override and zero-width characters are removed. Unknown fields are refused.",
        example='await api.ui.decorations.set(null, [{kind: "probe", text: "1.65 V", anchor: {id: u1.id, pin: "3"}, tone: "info"}]);'),
    "ui.decorations.clear": dict(summary="Remove this extension's decorations from one document, or from every document.", params=[("doc", "string | null", "Document id; omitted or `null` clears all.")],
        returns="`true`", example='await api.ui.decorations.clear();'),
    # ---------------------------------------------------------------- storage
    "storage.get": dict(summary="Read a value from this extension's private storage (on this computer, never in the project).", params=[("key", "string", "")], returns="The value, or `null`.",
        example='const key = await api.storage.get("apiKey");'),
    "storage.set": dict(summary="Store a JSON value.", params=[("key", "string", ""), ("value", "JSON", "")], returns="`true`", limits=["STORAGE_VALUE"],
        example='await api.storage.set("lastRun", {at: Date.now()});'),
    "storage.delete": dict(summary="Remove a stored value.", params=[("key", "string", "")], returns="`true`", example='await api.storage.delete("lastRun");'),
    "storage.keys": dict(summary="Stored keys.", params=[], returns="`[string]`", example='const keys = await api.storage.keys();'),
    "settings.get": dict(summary="Values of the settings declared under `contributes.settings` (the user edits them in the manager).",
        params=[("key", "string", "Optional: one setting.")], returns="`{key: value}` (defaults filled in), or one value.",
        example='const {template} = await api.settings.get();'),
    # ------------------------------------------------------------------ files
    "files.export": dict(summary="Save text or bytes through the system save dialog. The user picks the place; nothing else is written.",
        params=[("name", "string", "Suggested file name."), ("data", "string | Uint8Array", "")], returns="`true` when saved.",
        example='await api.files.export("net-lengths.csv", csv);'),
    "files.pickText": dict(summary="Ask the user to pick a text file (for example an IBIS model) through the system file picker and read it. Nothing is read without the picker; the size is capped. One dialog at a time, like the other extension dialogs.",
        params=[("options", "object", "`{accept: [\".ibs\", …] (up to 8 extensions), maxBytes}` (default 4 MB, at most 8 MB).")],
        returns="`{name, size, text}`, or `null` when the user cancels. Treat the text as untrusted input.", limits=["DIALOGS"],
        example='const f = await api.files.pickText({accept: [".ibs"]});\nif (f) console.log(f.name, f.text.length);'),
    "simulation.get": dict(summary="The simulation data the project stores in `project.simulation`: the index of its model files (IBIS) without their text, per-part model assignments and settings, plus the saved SPICE test benches. Extensions write it only through reviewed proposals (`proposals.submit` with `target: \"project\"`, `path: [\"simulation\", …]`).",
        params=[], returns="`{version, models: [{key, name, kind, size, sha256, added, summary}], assign: {partId: {…}}, settings, benches: [{id, name, engine, analyses, probes, …}]}`",
        example='const {models, assign} = await api.simulation.get();'),
    "simulation.model": dict(summary="The text of one stored model file.", params=[("key", "string", "A `key` from `simulation.get().models`.")],
        returns="`{key, name, kind, text}`, or `null`.", example='const m = await api.simulation.model(models[0].key);'),
    "simulation.channel": dict(summary="The routed copper of one board net, with what a transmission-line model needs: tracks (layer, width, points), vias (span, drill, land, back-drill and the stub lengths from the via-stub report), the pads of every component on the net (with all their pins, so series parts can be followed), the stack-up (each copper layer's depth and its cross-section: microstrip or stripline, dielectric heights, εr, tan δ, copper and cover thickness), the cross-section of each impedance profile a Width rule gives the net's tracks (its reference planes, etch factor and coplanar ground gap, as DRC and the Layer Stack Manager solve it) and, on request, other nets' tracks nearby. Read-only.",
        params=[("net", "string", "Net name."), ("options", "object", "`{doc, neighbours}`: `neighbours` (mm, at most 5) also returns other nets' tracks on the same layer within that distance.")],
        returns="`{net, doc, stackup: {thickness, er, derived, layers: [{key, name, type, z, t, geometry}], profiles: {[profile]: {[layer]: geometry}}}, tracks: [{id, layer, width, points, profile}], vias: [{id, x, y, drill, diameter, from, to, backdrill, stub: {top, bottom, residual, used, status}}], pads: [{part, ref, pin, name, x, y, w, h, layer}], parts: [{id, ref, value, def, defName, parameters, pins}], neighbours: [{net, id, layer, width, points}], neighboursTruncated, clearance}` (`neighboursTruncated` is true when the neighbour search hit its work limit on a very large net)",
        limits=["MAX_ITEMS"], example='const ch = await api.simulation.channel("DQ0", {neighbours: 0.5});\nconsole.log(ch.tracks.length + " tracks, " + ch.vias.length + " vias");'),
    "simulation.fieldSolve": dict(summary="Waffle's 2D quasi-static field solver for one transmission-line cross-section (single or coupled), run in the editor's solver worker. Results are cached by geometry; a caller may queue up to 8 solves.",
        params=[("geometry", "object", "Field-solver geometry in mm: `{structure: \"microstrip\" | \"stripline\" | \"coupled-microstrip\" | \"coupled-stripline\" | \"cpwg\" | …, w, s, h | h1, h2, t, er, tanD, cover: {t, er}, etch, g, rough}` (`etch`: trapezoid etch factor; `g`: coplanar ground gap; `rough`: rms copper roughness). `simulation.channel` gives each layer's `geometry`, and `stackup.profiles[track.profile][layer]` for a track under an impedance profile; add `w` (and `s` for a pair)."),
            ("options", "object", "`{quality: \"fast\" | \"normal\", fGHz}`: `fGHz` adds conductor and dielectric loss at that frequency.")],
        returns="`{ok, error, z0, z, zodd, zeven, zdiff, eeff, eeffOdd, eeffEven, delay (ps/mm), kb, kf, alpha_c, alpha_d (dB/mm), ms, warnings}`",
        example='const r = await api.simulation.fieldSolve({...layer.geometry, w: 0.2}, {fGHz: 1});\nconsole.log(r.z0.toFixed(1) + " Ω, " + r.delay.toFixed(2) + " ps/mm");'),
    "assets.read": dict(summary="Read a file bundled in your own package, such as a `.wasm` module.", params=[("path", "string", "Path inside the package.")], returns="`ArrayBuffer`",
        example='const {instance} = await WebAssembly.instantiate(await api.assets.read("solver.wasm"));'),
    "external.tools": dict(summary="The external programs this extension declares (`contributes.externalTools`) and whether the user has chosen each one. The path is never revealed.",
        params=[], returns="`{available, reason, tools: [{id, name, configured}]}`; `available` is false in the browser build.", example='const {tools} = await api.external.tools();'),
    "external.run": dict(summary="Run a program the user chose in Preferences › External Tools. The desktop host runs it with your arguments as a list (no shell), in a new temporary folder that holds your input files, with a minimal environment, then returns its output and deletes the folder. The first run shows the full command; the user's Allow holds for this version of the extension (its content hash), this program file and the arguments the tool declares in `contributes.externalTools[].args` (besides your input and output file names). Any other argument shows the full command and asks for that exact command; an update, or another program file, asks again.",
        params=[("tool", "string", "A tool id from `contributes.externalTools`."),
                ("options", "object", '`{args: ["-b", "deck.cir"], files: {"deck.cir": text | bytes}, outputs: ["*.raw"], timeoutMs, maxOutputBytes, runId, encoding: "text" | "binary"}`. File names are plain names in the working folder.')],
        returns='`{exitCode, signal, timedOut, cancelled, truncated, durationMs, stdout, stderr, files: [{name, size, text | bytes}]}`', limits=["EXTERNAL"],
        notes="Fails when the program is not set up (the message names Preferences › External Tools), when the user denies the command, or in the browser. Runs are cancelled when the extension stops.",
        example='const r = await api.external.run("ngspice", {args: ["-b", "-r", "out.raw", "deck.cir"], files: {"deck.cir": deck}, outputs: ["out.raw"]});'),
    "external.cancel": dict(summary="Cancel a run started with that `runId`.", params=[("runId", "string", "")], returns="`true` if a run was cancelled.", example='await api.external.cancel("tran");'),
    "external.configure": dict(summary="Open Preferences › External Tools so the user can choose a program. Nothing is chosen for them.", params=[("tool", "string", "A declared tool id.")],
        returns="`true`", example='if (!tools[0].configured) await api.external.configure("ngspice");'),
    "transfer": dict(local=True, sig="transfer(value)", summary="Mark an ArrayBuffer or typed array to be moved, not copied, in the next message.",
        params=[("value", "ArrayBuffer | TypedArray", "")], returns="The same value.", example='return {wave: api.transfer(samples)};'),
    # --------------------------------------------------------------- features
    "features": dict(summary="Which feature calls this build offers.", params=[], returns='`["bom", "drc", "erc", …]`',
        example='if ((await api.features()).includes("length")) rows = await api.length();'),
    "bom": dict(summary="The bill of materials report.", params=[("settings", "object", "BOM view settings: `{columns, groupBy, variant, …}` as in Reports › Bill of Materials.")],
        returns="`{title, project, source, columns: [{key, label}], rows: [[cell]], totalParts, lineCount, excluded, …}`",
        example='const bom = await api.bom();\nconsole.log(bom.lineCount + " lines");'),
    "drc": dict(summary="Run design rule checks on a board.", params=[("options", "object", "`{doc, types, limit, rules}`.")],
        returns="The DRC report as plain data (violations with their rule, message and location).", example='const report = await api.drc({limit: 100});'),
    "erc": dict(summary="Run electrical rule checks on the schematic.", params=[("options", "object", "ERC options.")], returns="The ERC report as plain data.",
        example='const erc = await api.erc();'),
    "annotate": dict(summary="Plan designator annotation (nothing changes).", params=[("options", "object", "Annotate options (order, scope, start).")], returns="The plan as plain data.",
        example='const plan = await api.annotate({order: "across-then-down"});'),
    "annotate.apply": dict(summary="Annotate designators, as a proposal and one undo step.", params=[("options", "object", "As `annotate`.")], returns="`{applied, report}`",
        example='await api.annotate.apply({});'),
    "pour": dict(summary="Repour the board's polygons, as a proposal.", params=[OPTS_DOC], returns="`{applied, report}`", example='await api.pour();'),
    "route": dict(summary="Autoroute, as a proposal.", params=[("options", "object", "`{doc, nets, …}` autorouter options.")], returns="`{applied, report}`", example='const r = await api.route({nets: ["VIN"]});'),
    "fanout": dict(summary="Fan out SMD pads, as a proposal.", params=[("options", "object", "`{doc, …}`.")], returns="`{applied, report}`", example='await api.fanout();'),
    "length": dict(summary="Routed length per net from the length engine that Length DRC, the Length Manager and MCP use: pad to pad for a two-pad net, else the total copper; via barrels between the copper layers they connect; die length.",
        params=[("options", "object", "`{doc, nets: [name], segments: false}`; `segments: true` adds per-segment detail.")],
        returns="`[{net, length, segmentCount, …}]`", example='const rows = await api.length({nets: ["USB_P", "USB_N"]});'),
    "stackup": dict(summary="The board's layer stackup.", params=[OPTS_DOC], returns="The stored stackup, or `null`.", example='const stack = await api.stackup();'),
    "autoplace": dict(summary="AI-assisted placement: a report with `dryRun`, otherwise a proposal.", params=[("options", "object", "`{doc, dryRun, …}`.")],
        returns="The plan (dry run) or `{applied, report}`.", example='const plan = await api.autoplace({dryRun: true});'),
    "routePlan": dict(summary="AI-assisted route planning: a report with `dryRun`, otherwise a proposal.", params=[("options", "object", "`{doc, dryRun, …}`.")],
        returns="The plan (dry run) or `{applied, report}`.", example='const plan = await api.routePlan({dryRun: true});'),
    "planes": dict(summary="Power-plane planning: a report with `dryRun`, otherwise a proposal.", params=[("options", "object", "`{doc, dryRun, …}`.")],
        returns="The plan (dry run) or `{applied, report}`.", example='const plan = await api.planes({dryRun: true});'),
    "outputs.build": dict(summary="Build fabrication outputs in memory.", params=[("options", "object", "`{doc, …}` fabrication options.")],
        returns="`{name, warnings, files: [{name, kind, title, content}]}`", example='const out = await api.outputs.build();\nfor (const f of out.files) console.log(f.name);'),
    "outputs.gerber": dict(summary="Only the Gerber files of `outputs.build`.", params=[("options", "object", "As `outputs.build`.")], returns="As `outputs.build`.",
        example='const {files} = await api.outputs.gerber();'),
    "outputs.drill": dict(summary="Only the drill files of `outputs.build`.", params=[("options", "object", "As `outputs.build`.")], returns="As `outputs.build`.",
        example='const {files} = await api.outputs.drill();'),
    # ---------------------------------------------------------------- logging
    "log": dict(local=True, sig="log(...values)", summary="Write to the extension's log (the same as `console.log`).", params=[("values", "...any", "")], returns="`undefined`",
        limits=["logsPerSecond"], example='api.log("checked", n, "pads");'),
    "version": dict(local=True, value=True, sig="version", summary="The API version (`1`).", params=[], returns="`1`", example='if (api.version !== 1) throw Error("Needs AtriumAPI v1");'),
}

GLOBALS = [
    ("fetch(url, {method, headers, body, signal})", "network:<host>",
     "Present only while at least one `network:` permission is turned on. The editor makes the request after checking the live grant on every call, with `redirect: \"error\"`, `credentials: \"omit\"`, `cache: \"no-store\"` and no referrer. `https://<host>` only (`network:localhost`: http or https to this computer, any port). Returns a standard `Response` whose body streams.",
     ["NET_OPEN", "NET_BYTES"]),
    ("console.log / info / warn / error / debug", "none", "Goes to the extension's log: Tools › Extensions › Output, and the developer Console.", ["logsPerSecond"]),
    ("require(\"./file.js\")", "none", "CommonJS `require` for `.js` and `.json` files inside your own package.", []),
    ("setTimeout / setInterval / clearTimeout", "none", "Timers. Work outside a running command counts against the background CPU budget.", ["CPU_BUDGET"]),
]

CONTEXT = [
    ("context.extensionId", "Your manifest `id`."),
    ("context.settings", "The settings' values when the extension activated (read fresh ones with `api.settings.get()`)."),
    ("context.subscriptions", "Push anything with `dispose()` here; it is disposed when the extension stops, reloads or is disabled."),
]

PALETTE_CONTRIBUTIONS = """## Palette contributions

`contributes.insertItems` and `contributes.paletteCommands` add entries to Waffle’s existing search palette. Each entry has an extension-local `id`, a `name` and the `command` registered by the package’s `activate(api)` function. Optional fields include `description`, `keywords` (string array), a local sprite `icon`, a short text or PNG `preview`, `contexts` (editor kinds such as `schematic` and `pcb`) and `actions` (`{id,label}` pairs). Declare the existing `ui:command` permission. Waffle can index these declarations before starting the extension. The same entries are available to the palette’s alias and shortcut preferences.

```json
{"permissions":["ui:command"],"contributes":{"paletteCommands":[
  {"id":"browse","name":"Browse packages","command":"packages.browse","keywords":["footprints"],"icon":"chip"}
]}}
```

Register the handler with `api.commands.register("packages.browse", event => …)`. Opening a row sends `{type:"open",query,editorKind}`. Choosing an action sends `{type:"action",actionId,itemId?,query,editorKind}`. Submitting a form sends `{type:"submit",actionId,values,query,editorKind}`. A user-invoked command with a live `read:project` grant also receives the captured `documentId` and finite `[x,y]` placement `point` when available. Use existing `api` reads for anything else. IDs returned by screen items and actions go back only to this same command in this same installed package. A command can return another screen, enabling native Back navigation. Use `api.transaction` or `api.proposals` for design changes. An approved proposal commits through the editor’s existing Undo history.

### Declarative screens

| `kind` | Fields |
| --- | --- |
| `list`, `grid` | `title`, `text`, `items`. Each item has `id`, `label` and optional `detail`, `accessory`, `icon`, `disabled`, `thumbnail` and item-scoped `actions`. |
| `detail` | `title`, `text`, `blocks`, `primary`, `actions`. Blocks can be `{kind:"text",text}`, `{kind:"math",text}`, `{kind:"richText",body}` or `{kind:"image",image}`. Use TeX in a math block or notebook math run. The bundled typesetter supplies scalable glyphs and an accessible transcription. Unsupported expressions remain readable as entered. |
| `form` | `title`, `text`, `fields`, `primary:{id,label}`. Each field has `id`, `label`, `type` (`text`, `number` or `select`), optional `value` and `required`. Numeric fields support `min` and `max`, text fields `maxLength`, and select fields `choices:[{id,label}]`. The host validates submitted fields and sends finite numbers for numeric fields. |
| `calculation` | `title`, `functionId`, exact `version`, `arguments:[{value,dimension}]`. The host asks the shared calculation worker to evaluate a function owned by the extension. Optional `blocks` use the Detail format and appear with its formatted result. A dimension or domain error appears in the current palette. |

Waffle renders text, icons and controls itself. A packaged PNG uses `{kind:"png",data:"data:image/png;base64,…",alt:"…"}`. Images are limited to 512 × 512 pixels and 88,000 URI characters. Screen models are limited to 512 KiB, 80 items, 32 detail blocks, 16 form fields and 12 actions per list. The live editor, DOM nodes, navigation functions and executable handlers are outside the screen protocol.

A `richText` body uses the notebook’s static paragraph grammar. Each `body.blocks` entry has a `style` (`paragraph`, `h1`, `h2`, `h3`, `bullet`, `number` or `check`) and `runs`. A checklist entry accepts a boolean `checked`. Runs are `{type:"text",text}` or `{type:"math",tex}`, with optional boolean `bold`, `italic`, `underline`, `strike` and `code` marks. Use ordinary text for literal markup. The view reads no project fields and activates no links. Each rich body accepts 16 paragraphs, 32 runs per paragraph and 8,192 characters. A Detail displays up to 256 rich runs and 16,384 rich characters. Its first 32 formulas can use up to two million raster pixels in total. Further formulas retain readable source.

### Streaming search

Declare up to four `contributes.searchProviders` per extension. Each entry uses `id`, `name`, `command`, a packaged JavaScript `module`, optional local JSON `data`, and a `hosts` array. Every host must match an exact `network:<host>` permission on the same manifest. The existing install or trust dialog asks about the hosts once per extension. Users can change the individual grants in Tools › Extensions.

```js
// search.js, with a packaged stock catalogue named by the provider’s data field
exports.search = async ({query, editorKind}, {signal, emit, data}) => {
  for (const part of data) {
    if (signal.aborted) return;
    if (part.label.toLowerCase().includes(query.toLowerCase())) {
      emit([{id: part.id, label: part.label, accessory: String(part.stock)}]);
    }
  }
};
```

Providers run in fresh, read-only workers. The search module receives the query and editor kind. `emit(rows)` sends partial results. Returning an array sends a final batch. Rows use the list item fields and stable extension-local IDs. Choosing a result invokes the provider’s declared command with its `itemId`. The host supplies its source name, icon and stable row key and appends streamed rows below existing local results. Stale batches are discarded on a new query or close. Pass `signal` to `fetch` when using a live service. Only declared, currently approved hosts accept GET or HEAD, with redirects disabled and credentials omitted. Providers cannot read the project, invoke commands, persist data or edit a design while searching.

A provider can start four times per second with a two-second response deadline. During a burst only the latest waiting query is kept. Each search can return at most eight chunks and 24 distinct rows. The palette also applies its aggregate limits across providers. A provider’s missing grant, timeout or unavailable service leaves the other sources responsive.

### Pure calculation functions

`contributes.mathFunctions` declares versioned functions in the shared calculation language. An ID consists of the complete package ID followed by a single function name. `arguments` is an array of named dimensions (up to 16), `returns` names the result dimension, `domain` is a predicate or a list of predicates, and `expression` is the pure calculation body. Optional `dependencies` are `{id,version}` pins. The computation worker receives these declarations and quantities in base SI units. When the shared evaluator is available, installing or enabling a package checks its expression and domain with the same parser used by sheets. An invalid update preserves the installed version. The installed package digest and exact function version identify the implementation. The host checks dimensions, finite results and cancellation and reports unavailable versions. The same function declaration can be used on a sheet and in a palette Form. The package’s normal JavaScript, grants and project data are outside this arithmetic interface.

```json
{"id":"example.divider.vout","version":"1.0.0",
 "arguments":[{"name":"vin","dimension":"voltage"},{"name":"rtop","dimension":"resistance"},{"name":"rbottom","dimension":"resistance"}],
 "returns":"voltage","domain":["rtop >= 0 ohm","rbottom > 0 ohm"],
 "expression":"vin * rbottom / (rtop + rbottom)"}
```

Complete examples are [Benchstock’s stub distributor](../extensions/examples/palette-distributor/), [live project footprint grid](../extensions/examples/palette-footprints/) and [voltage divider Form](../extensions/examples/palette-calculator/). The distributor sample uses a packaged stock fixture. The footprint browser builds pad thumbnails and proposes placement on the active board. The calculator delegates a 5 V, 1 kΩ and 2 kΩ divider to the same pure function used by sheets, yielding 3.333 V. A build without the shared evaluator displays its availability inline.
"""

WIDGET_CONTRIBUTIONS = """## Sheet widgets

A package declares notebook block types under `contributes.widgets`. Each type has a local
`id`, a visible `name`, a `render` command and an optional `event` command. Declare both
commands in this package and grant `ui:command` and `ui:widgets`. A design input also requires
the current `read:project` grant. Disabled packages and missing grants display the saved fallback.

| Declaration | Accepted values |
| --- | --- |
| `state` | Named properties of type `string` with `maxLength` and `default`, `number` with `min`, `max` and `default`, or `boolean` with `default`. A `list` declares `maxItems` and primitive `fields`. Its rows have stable string IDs. |
| `inputs` | Up to 16 uniquely keyed fields or calculation references. Use `{key,kind:"field",expression}` or `{key,kind:"calculation",documentId,blockId,instanceId?}`. |
| `size` | Minimum, preferred and maximum `[width,height]` in millimetres, between 4 and 400 per dimension. The command receives the negotiated size. |
| `fallback` | `{type:"text",text}` or `{type:"image",assetRef,alt}` with a project `{sha256,mediaType,byteLength}` asset reference. Text or alt remains readable when the asset or package is unavailable. |

The worker receives `{state,inputs,size,theme,tokens,event}`. It returns `{title,rows}`, where
each row contains an array of `{text,token?}` cells and optional `checked` and `action` values.
Use the supplied tokens for ink, muted text, accents, links, warnings and broken references.
An interactive row receives keyboard activation, focus and touch through the optional event
command. Return `{state}` with the declared fields to update in a single undo. A returned
list sets that list's row membership and order.
Only user input can change state. A render callback has no DOM or canvas handle.

The worker sees declared fields only. A missing primitive field uses its declared default,
and a missing list appears empty. The host keeps unfamiliar saved fields, including list fields
attached to surviving row IDs. A present value must satisfy its declared type and bounds.

Each extension gets one in-flight widget callback and at most four paint requests per second.
The host stops its worker on a 160 ms callback timeout. The renderer accepts up to 48 rows,
eight cells per row and 32 KiB per response. Other sheet objects continue painting during
a worker request. The persisted fallback also serves export when a live view is unavailable.

Two complete installable samples live under `extensions/examples`:

- [Inspection counter](../extensions/examples/widget-inspection/waffle-extension.json) stores a bounded count and increments it from an actionable row. Its [worker](../extensions/examples/widget-inspection/main.js) handles touch and keyboard.
- [Rail specification](../extensions/examples/widget-rail/waffle-extension.json) displays a live design field with the current net voltage. Its [worker](../extensions/examples/widget-rail/main.js) marks an unavailable field with the broken-reference token.
"""
