# Scripting

The **Scripting Console** (Tools › Scripting Console) runs short JavaScript against the open design with the same API extensions use, [AtriumAPI v1](extension-api.md). Use it for one-off jobs: renumbering, selecting, measuring, exporting, bulk edits. When a script becomes something you run every day, turn it into an extension ([extensions.md](extensions.md)).

## The console

- A script is the **body of an async function**. It gets `api`, `console` and `args`, may use `await` anywhere, and its `return` value is printed.
- **Ctrl/⌘+Enter** runs, **Tab** indents, **Stop** ends a run, **Clear** empties the output.
- **Snippets…** inserts a built-in example. **Save…** keeps a script for you, or in the project so it travels with the design (a project's scripts never run by themselves: you choose to run them).
- Each run gets a **fresh sandboxed worker**, ended when the script finishes: no DOM, no network, no storage, no editor globals. It runs with `read:project`, `write:edits`, `outputs:write` and dialogs.
- Runs stop after **5 s** by default; the **Limit (s)** field changes it (up to 600 s).
- **Consecutive transactions from one run share an Undo step.** An editor action, another script or Undo between transactions starts a new step for the next script edit. The console reports the number of steps the run actually created. Switching to another project ends the run's permission to change the previous design.

```js
const parts = await api.items.list({kind: "part", fields: ["id", "ref", "x"]});
await api.transaction("Nudge right", tx => parts.forEach(p => tx.move(p.id, 1, 0)));
return parts.length + " parts moved";
```

## Reading the design

| To get | Call |
| --- | --- |
| The active document | `await api.documents.active()` → `{id, name, kind, grid, outline}` |
| Objects | `await api.items.list({kind: "track", net: "GND", fields: ["id", "width", "points"]})` |
| The selection | `await api.selection.items({fields: ["id", "kind", "ref"]})` |
| Library definitions | `await api.defs.list()`, `await api.defs.get(part.def)` |
| Pins and pads of a part | `await api.parts.pins(part.id)` (world coordinates, nets on boards) |
| Nets | `await api.nets.list()`, `await api.nets.items("GND")` |
| Connectivity | `await api.query.connectivity()` (schematics: `byPin["partId/pin"]`) |
| Objects in an area | `await api.query.spatial([x0, y0, x1, y1], {kinds: ["via"]})` |
| Rules | `await api.rules.query("width", {net: "VIN"})` |

Pass `fields` whenever you can: it keeps the copies small. Lengths are millimetres; `api.units.parse("10mil")` and `api.units.format(mm, "mil")` convert. `api.geometry` has `distance`, `segmentDistance`, `pointInPolygon`, `bounds`, `length` and `rotate`.

## Changing the design

Every change goes through `api.transaction`:

```js
await api.transaction("Widen VIN", tx => {
  for (const t of tracks) tx.update(t.id, {width: 0.5});   // null deletes a field
  tx.add({kind: "via", x: 5, y: 5, diameter: 0.6, drill: 0.3, layer: "Multi", net: "GND"});
  tx.move(partId, 1, 0);                                      // wires follow parts on schematics
  tx.remove([idA, idB]);
});
```

Each operation is checked against the model, and the whole project is validated afterwards; if anything is wrong, nothing changes and the error names the operation. Code-bearing project fields (`extensions`, `scripts`) can never be written.

## Output

- `console.log`, `info`, `warn`, `error` print in the console.
- `return` a value to print it (objects and arrays are shown as JSON).
- `await api.files.export("name.csv", text)` saves through the system save dialog.
- `await api.ui.showMessage(text)` puts a line in the status bar; add `{messages: [{class: "Warning", text, objectId}]}` to list rows in the Messages panel.
- `await api.selection.set(ids)` selects objects, `await api.ui.locate(id)` centres one.

## Example scripts

Five ready-made scripts live in [`extensions/examples/scripts/`](../extensions/examples/scripts/). Open one, copy it into the console and run it, or save it. Each reads optional `args`, which the console leaves `null` (so defaults apply) and MCP `run_script` can pass.

| Script | What it does | `args` |
| --- | --- | --- |
| [renumber-by-position.js](../extensions/examples/scripts/renumber-by-position.js) | Renumbers designators in reading order (rows by Y, then X), per prefix, and renames the linked part on the other document so schematic and board stay in step. Swaps go through temporary names, so R1 ↔ R2 never collides. | `{tolerance: 1, prefixes: ["R"], start: 1, reverseY: false}` |
| [select-by-footprint.js](../extensions/examples/scripts/select-by-footprint.js) | Selects every part whose footprint name contains `0402` (or any text). | `{size: "0603"}` |
| [export-net-lengths.js](../extensions/examples/scripts/export-net-lengths.js) | Routed length, track and via count per net, longest first, saved as CSV. | `{nets: ["USB_P", "USB_N"], file: "lengths.csv"}` |
| [widen-power-tracks.js](../extensions/examples/scripts/widen-power-tracks.js) | Widens tracks on power and ground nets to a minimum width. | `{width: 0.5, nets: "^(GND|VDD)$"}` |
| [snap-selection-to-grid.js](../extensions/examples/scripts/snap-selection-to-grid.js) | Snaps the selected parts (or all) to the document grid. | `{grid: 0.25}` |

For example, *select all 0402 parts*:

```js
const size = String(args?.size || "0402");
const doc = await api.documents.active();
const defs = new Map((await api.defs.list()).map(d => [d.id, d]));
const parts = await api.items.list({doc: doc.id, kind: "part", fields: ["id", "ref", "def"]});
const hits = parts.filter(p => String(defs.get(p.def)?.footprint || "").toLowerCase().includes(size.toLowerCase()));
await api.selection.set(hits.map(p => p.id));
return hits.map(p => p.ref);
```

`tests/extension-examples.cjs` runs all five, both headlessly and through the console's sandboxed worker.

## Headless: MCP and the command line

The same text runs without the editor, on a copy of the project:

```js
const r = await AtriumScripting.runHeadless(projectJsonOrObject, code, {timeoutMs: 5000, documentId, args});
// {ok, project /* the edited copy */, log: [{level, text}], result, error, transactions, steps}
```

The MCP tool `run_script` does this in a short-lived child process with a fresh JavaScriptCore context, a watchdog, a memory guard and a wall-clock kill. Headless runs have `read:project` and `write:edits` only: no selection to set and no save dialog, so the example scripts fall back to logging (`try { await api.files.export(…) } catch { console.log(csv) }`).

## Tips

- **Keep it small.** Read with `fields`, page with `limit`/`offset` past 20 000 objects, and do the work in one transaction.
- **Guard against the wrong document:** `if ((await api.documents.active()).kind !== "pcb") return "Open a board first.";`
- **Errors are fine.** An exception stops the script, nothing is half-applied, and the console shows the line.
- **Reads inside a transaction callback** see the design as it was before that transaction.
- **From script to extension:** wrap the body in `api.commands.register("me.myCommand", async () => { … })` inside `exports.activate`, declare the command and the permissions it needs, and you have an extension. `python3 scripts/new-extension.py me.my-tool` gives you the skeleton.
