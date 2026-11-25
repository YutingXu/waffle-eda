# Writing Waffle EDA extensions

Waffle extensions add commands, menus, panels and design automation. They are written in plain JavaScript against **AtriumAPI v1**. The same API runs:

- in the editor, inside a sandboxed Worker;
- in the Scripting Console (Tools › Scripting Console);
- headlessly over MCP (`AtriumScripting.runHeadless`).

Samples live in `extensions/examples/` (see its README). First-party extensions shipped with Waffle live in `app/extensions/<id>/`. Every call is documented in the generated [API reference](../docs/extension-api.md); `scripts/new-extension.py <id>` scaffolds a new extension, and **Preferences › Extension Development** turns on developer mode (Load unpacked…, Reload from folder, Console).

Prepare a fresh checkout with `python3 scripts/prepare-assets.py` before running the extension harness.

## How it works

- **Lazy activation.** Nothing about an extension is loaded at startup except its manifest. Its code reaches a worker only when an activation event fires. With no extensions running there is no worker at all.
- **Sandboxed.** Every extension runs in its **own** Web Worker (one realm per extension), and every console script run gets a fresh one. Extension code never runs in the editor's page. See [Threat model](#threat-model).
  - Workers live inside a hidden, sandboxed iframe with an opaque origin and the CSP `default-src 'none'`, which the workers inherit. No request can leave a worker: `fetch`, `import()`, `importScripts`, `FontFace`, `XMLHttpRequest`, `WebSocket`, `EventSource` and nested workers are all refused by the browser engine.
  - The worker also has no `document`, `window`, `parent`, `localStorage`, `indexedDB`, `caches`, OPFS, editor globals (`Waffle*`) or native bridge (`AtriumHost`, `webkit`).
  - Raw `postMessage` and `self.onmessage` are removed. The only way out is the `api` object, over a private channel bound to that worker.
  - The editor never `eval`s extension or script text.
- **Capabilities.** Every API call is a message to the editor, which attributes it to the worker it came from (never to an id inside the message) and checks that extension's granted permissions on every message. Revoking a permission takes effect on the next call, and revoking `read:project` stops design events.
- **Copies, not references.** Reads return copies of exactly what you asked for. Use `fields`, `limit` and `offset`: a read returns at most 20 000 objects.
- **Guarded edits.** Writes are collected as operations, validated, turned into an [AtriumProposal v2](../app/automation/proposal.js) whose every change is guarded by the value it replaces, and applied in one undo step. A change drafted against data that has since changed is refused.
- **Limits.**
  - Time: 5 s per command by default. `timeoutMs` raises it to 120 s, or 10 min with `"worker": "dedicated"`. At the limit the worker is terminated, even inside a `for (;;) {}`.
  - Background CPU: outside a running command (and while waiting for the user) a worker may use at most half a core over 10 s and must answer a 1 s heartbeat; otherwise it is terminated. Three strikes disable the extension.
  - Idle: an active extension with no open panel, status item, event subscription or pending work is stopped after 10 minutes and restarts on demand.
  - Rate: 2 000 API calls per second.
  - Size: 16 MB per message, 1 MB per panel view and 50 log lines per second.
  - Dialogs: one per extension at a time, one consent dialog on screen at a time, at most 3 queued per extension. An extension whose dialogs are dismissed 5 times in 30 s is disabled. Every extension dialog is headed "<name> (extension)".
  - Users can stop everything from the status bar, the Extensions manager (Stop all, Pause all), the Scripting Console, or by pressing **Esc three times** within 1.5 s, which works even while a dialog is open (`AtriumExtensions.pauseAll()`).

## A first extension

```
renumber-by-x/
  waffle-extension.json
  main.js
```

`waffle-extension.json`:

```json
{
  "id": "acme.renumber-by-x",
  "name": "Renumber by X Position",
  "publisher": "ACME",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.js",
  "activationEvents": ["onCommand:renumber.byX"],
  "permissions": ["read:project", "write:edits", "ui:command"],
  "contributes": {
    "commands": [{"command": "renumber.byX", "title": "Renumber Designators by X Position"}],
    "menus": {"tools": [{"command": "renumber.byX"}]},
    "keybindings": [{"command": "renumber.byX", "key": "ctrl+alt+r"}]
  }
}
```

`main.js` is a CommonJS module. `require("./other.js")` works for files inside your own package.

```js
exports.activate = function (api, context) {
  api.commands.register("renumber.byX", async () => {
    const parts = await api.items.list({kind: "part", fields: ["id", "ref", "x"]});
    parts.sort((a, b) => a.x - b.x);
    await api.transaction("Renumber", tx => parts.forEach((p, n) => tx.update(p.id, {ref: "U" + (n + 1)})));
  });
};
exports.deactivate = function () {};
```

`context` holds `extensionId`, `settings` (the current values) and `subscriptions`. Anything with a `dispose()` method that you push into `subscriptions` is disposed when the extension is disabled or reloaded.

### Developer mode

**Preferences › Extension Development › Developer mode** (off by default) adds **Load unpacked…** to the manager. An unpacked extension runs in the same sandbox with the same prompts and checks, carries a **Developer** badge, and is pinned to the SHA-256 of the files loaded: grants are keyed `id@sha256`, the digest is re-checked whenever its code starts, and a reload that asks for different permissions prompts again. Its code is held in memory only, so it is gone when Waffle quits or developer mode is turned off, and it cannot take the id of an installed, project or built-in extension. **Reload from folder** re-reads the files the folder picker granted (or asks for the folder again); **Console** shows its log live.

### Installing

Open Tools › Extensions… and choose one of:

- **Install from package…** accepts a `.zip`, a `.waffle-extension` bundle (`{"manifest": {...}, "files": {"main.js": "..."}}`), or the manifest and its files selected together;
- **Install folder…** installs a folder.

The install dialog lists the permissions requested. Code is stored in IndexedDB, with localStorage as a fallback.

**Add to project** saves an extension inside the `.waffle` file (`project.extensions`). Anyone who opens that project sees it as *Blocked* until they choose **Trust and enable**.

## Manifest reference

| Field | |
| --- | --- |
| `id` | `publisher.name`: letters, digits, `-` and `_`, with dots between parts. |
| `name`, `version`, `publisher`, `description` | `version` is semantic, e.g. `1.2.0`. |
| `apiVersion` | `1`. |
| `main` | The entry `.js` file. |
| `activationEvents` | `onCommand:<id>`, `onView:<panelId>`, `onDocumentKind:pcb` or `onDocumentKind:schematic`, and `onStartup` (`*`). |
| `permissions` | See below. Nothing is granted without being declared. |
| `contributes.commands` | `[{command, title, when}]`. Needs `ui:command`. |
| `contributes.menus` | `{tools: [...], reports: [...], view, place, edit, project, file, help, panels, activeBar}`. Each entry is `{command, title?, when?, icon?}`. `icon` names a built-in icon such as `via`. Needs `ui:command`. |
| `contributes.keybindings` | `[{command, key: "ctrl+alt+r", when}]`. Keys need Ctrl, Alt or Cmd, or a function key. They join the editor keymap, so users can rebind them in Keyboard Shortcuts. |
| `contributes.panels` | `[{id, title, location: "right" \| "dialog"}]`. Needs `ui:panel`. |
| `contributes.settings` | `[{key, type: "string" \| "number" \| "boolean" \| "enum", default, title, description, options}]`. Users edit these in the manager. Read them with `api.settings.get()`. |
| `timeoutMs` | Per-command limit: 100–120 000 ms, or up to 600 000 with `"worker": "dedicated"`. |
| `worker` | `"shared"` (default) or `"dedicated"`. Every extension has its own worker either way; `"dedicated"` only allows the longer `timeoutMs` (up to 10 min) for long-running work such as simulation. |
| `builtin`, `enabledByDefault` | Only first-party extensions bundled in `app/extensions/` may set `builtin`. |

`when` clauses use `pcb`, `schematic` and `selection`, combined with `!` and `&&`.

### Permissions

| Permission | Allows | Granted |
| --- | --- | --- |
| `read:project` | Documents, objects, nets, netlists, rules, selection, design events. | At install. |
| `propose:edits` | Changes that the user reviews (as a diff) and picks from before they apply; `proposals.propose` edits whitelisted data fields. | At install. |
| `write:edits` | Changes applied directly, always as one undo step. | Ask each time, Allow once, Allow for this project, Review… or Deny. |
| `outputs:write` | `api.files.export`, which saves through the system save dialog. | At install. |
| `ui:panel` | Panels. | At install. |
| `ui:command` | Commands, menus, Active Bar buttons, shortcuts and status items. | At install. |
| `ui:decorations` | Read-only labels, probes and markers on the schematic and PCB canvas (`api.ui.decorations`), removed when the extension stops. | At install. |
| `run:external` | Run programs the user installed and chose in Preferences › External Tools (`api.external`, desktop app only); needs `contributes.externalTools`. The full command is shown and approved once per extension version, program and declared argument template (`contributes.externalTools[].args`); any other argument asks again. | Off until the user ticks it. |
| `network:<host>` | `fetch` to exactly `https://<host>`. The editor makes the request (see below). | Off until the user turns it on. |
| `network:localhost` | `fetch` over http or https to this computer only: `localhost`, `127.0.0.1` or `[::1]`, any port (local model servers). | Off until the user turns it on. |

#### Network: host-mediated `fetch`

The worker itself has no network. While at least one `network:` permission is on, the worker's global `fetch(url, {method, headers, body, signal})` sends the request to the editor, which checks the **live** grant on every call and performs it with `redirect: "error"`, `credentials: "omit"`, `cache: "no-store"` and no referrer. URLs with user info are refused.

- `method`: GET, HEAD, POST, PUT, PATCH or DELETE. `headers`: an object, `[k, v]` pairs or a `Headers`. `body`: a string, `ArrayBuffer` or typed array.
- The result is a standard `Response` whose `body` is a `ReadableStream` that streams chunks from the editor, so SSE works (`res.body.getReader()`). `signal` aborts the request.
- At most 8 open responses per extension and 64 MB per response.
- When the user turns network hosts on or off, the extension's worker restarts so `typeof fetch` reflects it. With all hosts off `fetch` is `undefined`.
- Requests still obey CORS, as from the editor page (origin `null` in the app, `file://` in a browser).
- Hosts embedding the extension host (tests) pass `attach(host, {fetch})` to supply the editor-side fetch.

Every permission can be revoked in the manager, and **Reset permissions** asks again.

## API reference (v1)

Every method returns a Promise in an extension. Headless and in-process calls return values directly, but writing `await` everywhere works in both. Lengths are in millimetres.

| Area | Methods (permission) |
| --- | --- |
| Project | `project.info()`, `project.netlist({format: "json" \| "spice", doc})` (read:project) |
| Documents | `documents.list()`, `documents.active()`, `documents.get(id, {items, fields, limit})` (read:project); `documents.activate(id)` (ui) |
| Objects | `items.list({doc, kind, kinds, ids, layer, net, where, bounds, fields, limit, offset})`, `items.get(id, {fields})`, `items.count(filter)` |
| Library | `defs.list({fields})`, `defs.get(id)`, `parts.pins(partId)`, which gives pins and pads in world coordinates with their nets |
| Nets | `nets.list({doc})`, `nets.items(name, {doc, fields})` |
| Selection | `selection.get()`, `selection.items({fields})` (read:project); `selection.set(ids)` (ui) |
| Layers and units | `layers.list({doc})`, `units.get()`. Local helpers: `units.parse("10mil")`, `units.format(mm, "mil")`, `units.toMm` and `units.fromMm` |
| Queries | `query.spatial([x0, y0, x1, y1], {doc, kinds, fields})`, `query.connectivity({doc})`, `rules.query(type, {net, layer, net2})`, `rules.get()` |
| Geometry (local) | `geometry.distance`, `segmentDistance`, `pointInPolygon`, `bounds`, `length`, `rotate` |
| Edits | `transaction(label, tx => {...})` and `proposals.submit(proposal, label)` (propose:edits or write:edits) |
| Commands | `commands.register(id, fn, {title, when})`, `commands.execute(id, ...args)`, `commands.list()` (ui:command). Of the editor's own commands (`waffle.*`), only view commands are available: fit, zoom, grid, units, select and pan tools, layer mode, split and panel toggles. |
| UI | `ui.showMessage` (with `{messages: [{class, text, objectId, point}]}` it also lists rows in the Messages panel, under "<name> (extension)"), `ui.showInputBox`, `ui.showQuickPick` and `ui.confirm` (ui). `ui.registerPanel`, `setPanel`, `showPanel` and `closePanel` (ui:panel). `ui.setStatus`, `clearStatus`, `addMenuItem` and `addActiveBarButton` (ui:command). |
| Events | `events.on(name, fn)` returns a disposable. Names: `selectionChanged`, `documentChanged`, `activeDocumentChanged` and `projectSaved` (read:project); `panelShown` and `settingsChanged`. Only subscribers receive them, and bursts are coalesced. |
| Storage | `storage.get`, `set`, `delete` and `keys`: per extension, JSON values up to 256 KB. `settings.get(key?)`. |
| Files | `files.export(name, text)` (outputs:write) |
| Binary data | `assets.read(path)` returns an `ArrayBuffer` of a file in your own package, such as a `.wasm` module. `transfer(typedArray)` moves a buffer instead of copying it. |
| Features | `features()` lists what this build offers. The feature calls are `bom(settings)`, `drc({doc, types, limit})`, `erc(options)`, `annotate(options)`, `annotate.apply(options)`, `pour({doc})`, `route({doc, ...})`, `fanout({doc})`, `length({doc, nets, segments})`, `stackup({doc})`, `outputs.build`, `outputs.gerber` and `outputs.drill`. Reads need read:project; the edits (`annotate.apply`, `pour`, `route`, `fanout`) need an edit permission and go through proposals. |

### Transactions

```js
const r = await api.transaction("Add vias", tx => {
  const id = tx.add({kind: "via", x: 5, y: 5, diameter: .6, drill: .3, layer: "Multi", net: "GND"}, {doc});
  tx.update(otherId, {width: .3});     // null deletes a field; id and kind never change
  tx.move(partId, 1, 0);                // schematic wires follow moved parts
  tx.transform(partId, {angle: 90});
  tx.remove([a, b]);
  tx.setDocument(doc, {name, grid, outline});
  tx.select([id]);
});
// r = {applied, added: [ids], removed}. With propose:edits the user may pick a subset: {declined: true} if discarded.
```

- Every operation is checked against the real model rules first, and the whole project is validated afterwards. If anything is wrong, nothing changes and the error names the operation.
- Reads inside a transaction callback see the project as it was before the transaction.
- In the Scripting Console, all of a script's transactions form a single undo step.

To guard an edit by what you read, build a proposal yourself. For example:

```js
const t = await api.items.get(id);
await api.proposals.submit({format: "atrium-ai", version: 2, project: (await api.project.info()).name,
  ops: [{op: "set", target: "item", document: t.document, id, path: ["width"], before: t.width, after: .4}]});
```

If the width changed in between, the proposal is refused.

### Declarative panels

Panels are data. The editor renders them, and you never touch the DOM. A view is one element or a list of them.

```js
await api.ui.setPanel("netLengths", [
  {type: "heading", text: "Routed nets"},
  {type: "kv", rows: [["Nets", 12], ["Total", "84.2 mm"]]},
  {type: "table", columns: [{key: "net", title: "Net"}, {key: "len", title: "Length", align: "right"}],
   rows: [{net: "GND", len: "56.5 mm"}], rowCommand: "netLengths.select"},
  {type: "form", fields: [{key: "current", label: "Current (A)", type: "number", value: 1}],
   submit: {label: "Calculate", command: "calc.track"}},
  {type: "plot", title: "V(out)", xLabel: "ms", yLabel: "V", series: [{name: "out", x: Float64Array, y: Float64Array}]},
  {type: "buttons", items: [{label: "Refresh", command: "netLengths.refresh"}]},
  {type: "text", text: "…", muted: true, level: "warn"}, {type: "code", text: "…"},
  {type: "list", items: [{label: "R1", detail: "10k", locate: itemId}]}
]);
```

The full set of element types is `heading`, `text`, `code`, `kv`, `table`, `list`, `button`, `buttons`, `form`, `plot` and `stack`. Rows and list items with `locate: id` select and centre that object. Command arguments come from `args`, the row, or the submitted form values. A form field with `wide: true` puts its label above a full-width field, for long labels and comma-separated lists.

## Scripts

The Scripting Console (Tools › Scripting Console) runs the body of an async function with `api`, `console` and `args`:

- Ctrl/Cmd+Enter runs.
- Tab indents.
- Scripts can be saved per user or into the project.
- Built-in snippets cover common tasks.

Each script run gets a fresh sandboxed worker, terminated when it ends, with `read:project`, `write:edits` and `outputs:write` (no network). They have a 5 s default limit, which is configurable, and a Stop button.

The same text runs headlessly:

```js
const out = await AtriumScripting.runHeadless(projectJsonOrObject, code, {timeoutMs: 5000, documentId, args});
// {ok, project /* edited copy */, log: [{level, text}], result, error, transactions, steps}
```

Headless runs do not create the isolation themselves. The MCP server's `run_script` runs each script in a short-lived child process (`mcp/board_runner.py --script`) with a fresh JavaScriptCore context whose watchdog stays armed for every API call (so microtask chains after an `await` are limited too), a 1 GB memory guard, and a hard wall-clock kill. Node's `vm` is not a security boundary: under Node, `run_script` is refused unless `ATRIUM_ALLOW_NODE_SCRIPTS=1`, and even then runs under Node's permission model (no child processes or writes) with the same kill.

## First-party extensions

Waffle's own extensions live in `app/extensions/<id>/` and `extensions/<id>/` with `"builtin": true` in their manifests. Run `python3 scripts/bundle-extensions.py` after editing them. Add `--check` to verify the manifest index, individual packages, and full tooling bundle.

First-party extensions use the same API and the same worker sandbox, and they declare permissions. Unlike third-party extensions they:

- are trusted by provenance, so there is no install prompt;
- may set `"builtin": true`;
- are enabled by default unless `enabledByDefault` is `false`;
- show as *Built-in* in the manager, where they can be disabled and their permissions revoked, but not uninstalled.

The Engineering Calculators extension (`extensions/calculators`) is the reference example. It provides:

- IPC-2221 track width;
- via current;
- nearest E3–E192 value;
- regulator feedback divider.

It reads the board's width rule and via drills, and never edits.

### AI Assistant

The AI Assistant (`extensions/ai-assistant`, Tools › AI Assistant) chats with Claude, ChatGPT or a local model about the open design, using the user's own API key.

- **Files.** `agent.js` holds the provider adapters and the tool loop (no editor access; tested with recorded streams). `tools.js` holds the tools, which reuse the MCP server's names (`run_drc`, `list_components`, `propose_component_edits`, …). `main.js` holds the panel and commands.
- **Providers.** Anthropic Messages API (`claude-opus-5-5` by default), OpenAI Chat Completions, and any OpenAI-compatible server on this computer (Ollama, LM Studio). Replies stream over SSE, with tool use. 429 and overloaded errors back off and retry. A reply stops after the configured number of tool rounds (default 8).
- **Network.** It declares `network:api.anthropic.com` and `network:api.openai.com`. Both stay off until the user turns them on in the Extensions manager. Local models need the host's `network:localhost` support.
- **Keys.** Keys are kept in the extension's own storage on this computer. They are never written to the project or a log, never rendered back into the panel, and sent only to the provider host as a header.
- **Design data.** Design data is read only through tools. With "Ask before sending design data" (on by default), the first read in each chat asks first.
- **Edits.** Edits are queued as proposals. **Review proposal** checks that the objects still match what the model saw, then opens the editor's review dialog. The result is one undo step.
- **Commands.** `ai.show` and `ai.askSelection` (Ask AI about Selection, Mod+Alt+I). The Modern profile uses Mod+Alt+Shift+I.
- **Tests.** `scripts/test-jsc.sh ai-assistant`.

### SPICE Simulation

Open **Design › Simulate › Mixed Sim** on a schematic, or **Tools › SPICE Simulation** from either editor. The built-in solver runs offline in the extension worker. On the desktop, **Configure simulators…** opens **Preferences › External Tools**. Choose your installed ngspice or LTspice executable there. Waffle asks for approval when an extension first runs that program.

- **Test benches.** Choose an analysis, fill in its settings, enter a bench name and choose the engine. **Run** uses those settings immediately. **Save bench** opens a review, then stores the settings and probes in the project. Select a saved bench to use it again, or **New bench** for a separate setup. Each bench has its own engine.
- **Probes and coverage.** Select wires, labels or parts and choose **Probe selection**, or enter net names. Probe markers and operating-point voltages attach to pins on the schematic. The panel shows model coverage by rung and can locate the part named by a simulator error. **Use generic**, **Exclude** and **Save model** open a review of the part or shared component assignment.
- **External model files.** Both connectors stage a single, self-contained deck in a temporary directory. Waffle can pass inline primitive models and supported subcircuits supplied in the part’s `Spice.Lib` parameter. The runner cannot resolve a library tree from a schematic. File paths in `.include` and `.lib`, file-backed sources, code models and simulator control scripts are refused before the program starts. Copy the supported model cards into `Spice.Lib` when their licence permits. No vendor model files ship with Waffle.

- **Files.** `spice.js` is the solver (`AtriumSpice`, DOM-free), `export.js` turns the schematic into a netlist, `main.js` holds the panel and commands, and `cli.js` runs a netlist file from a terminal. The bundler includes `extensions/<id>/` folders whose manifest says `"builtin": true`.
- **Netlist.** Parts are netlisted from their parameters: `Spice` (the text after the nodes, such as `10k`, `1N4148` or `DC 5 AC 1`, or a whole-line template with `%ref`, `%1`…`%n`, `%{pin name}`), `Spice.Prefix`, `Spice.Pins`, `Spice.Lib` (`.model`/`.subckt` text) and `Spice.Exclude`, plus `DC`, `AC`, `AC Phase`, `PULSE`, `SIN`, `PWL` and `EXP` on sources. Without a `Spice` parameter the designator prefix decides (R, C, L, V, I, D, LED, Q, M, and U/X only when a subcircuit is known). Parts that are not fitted in the active assembly variant are left out, using the BOM's variant resolution. Connectors, test points and other parts without a model are left out with a note. A few generic models (1N4148, 1N4001, 1N5819, LED, 2N3904, 2N3906, BC547, 2N7000, BSS138, …) and a single-pole `OPAMP` subcircuit are built in; their values are rounded typical values, not vendor models.
- **Solver.** Modified nodal analysis with dense LU. R, C, L, V, I, E, F, G, H, diodes (Shockley with RS, CJO, BV), BJTs (Ebers–Moll transport model with VAF), level-1 MOSFETs and `.subckt`. Newton–Raphson with junction limiting, then gmin and source stepping. Analyses: `.op`, `.dc` source sweep, `.ac` (complex, linearised at the operating point) and `.tran` (trapezoidal or backward Euler, divided-difference truncation-error step control, source breakpoints). `tests/analysis/spice.cjs` checks it against analytic answers.
- **Panel.** Choose the analysis, probe nets selected on the sheet (Probe selection, Mod+Alt+Shift+P) or typed, and run. Waveforms use the host-drawn `plot` element with up to six traces, two cursors (value table with differences), zoom, pan and fit; AC shows magnitude and phase on a log axis. Operating-point source currents and the built-in solver’s semiconductor bias results appear in the panel. Show, export (`.cir`) and CSV export of results.
- **Scripts and automation.** `spice.simulate({analysis, probes, engine?, netlist?})` returns plain data. Use `spice.simulate({bench: id})` to run a saved bench. Extensions cannot expose commands to MCP yet, so automation uses the DOM-free module directly: `AtriumSpice.simulate(netlistText, analysis)` or `jsc extensions/spice/spice.js extensions/spice/cli.js -- deck.cir` (or `node extensions/spice/cli.js deck.cir`).
- **Rawfiles.** Both batch connectors return the same operating-point or waveform data as the built-in solver. ngspice accepts ASCII and binary rawfiles. The LTspice reader handles UTF-16 headers and logs, complex AC values, float or double real traces, and Fast Access layout. Each run requests one analysis and reads up to 2 million samples in total (all traces and points). Waveforms stay in memory.
- **Earlier versions.** Settings and model assignments that only existed in an older extension’s local storage must be saved again with the project.

## Threat model

Extensions and project files are untrusted. An extension is limited to what the user granted it; a project file can carry extensions but they never run until the user trusts that exact bundle.

| Threat | Defence |
| --- | --- |
| One extension using another's permissions (shared intrinsics, listening to its messages) | One worker per extension; the host attributes each message to the worker channel it arrived on. |
| Exfiltration or downloading code (`fetch`, `import()`, `FontFace`, `WebSocket`, …) | Workers run under the sandbox iframe's CSP `default-src 'none'`, enforced by WebKit/Chromium below JavaScript; blocked globals are also removed. Network access only through the host-mediated `fetch` for granted hosts. |
| A forged or changed project bundle running as a trusted one | Trust and grants are bound to `id@sha256(canonical [manifest, files])`. A changed bundle is blocked, and trusting it always shows its permissions again. The digest is re-checked at activation. |
| Proposals planting code into the project (worm) | Proposals cannot write `project.extensions`, `project.scripts` or other code-bearing fields (`app/automation/proposal.js`, `app/core/atrium-api.js`). |
| Confused deputy | `api.commands.execute` reaches only the extension's own commands and `waffle.*` view commands. |
| UI lock-out and phishing | One consent dialog at a time with a capped queue, dismissal limit, "(extension)" labels, a Disable button in each extension dialog, Esc×3 pause, CPU budget and heartbeat. |
| Zip bombs | Declared sizes are checked against the 32 MB budget before inflating, and inflation stops at the declared size. |
| MCP `run_script` | Child process, armed watchdog, memory guard, wall-clock kill; Node only by explicit opt-in. |
| Unpacked (developer mode) code running unnoticed or persisting | Off by default; loads only a folder the user picks; held in memory only; a visible Developer badge; each load pinned to its SHA-256 (grants keyed `id@sha256`, digest re-checked at activation); refused while developer mode is off; cannot take another extension's id. |
| An extension posing as an editor check in Messages | Rows go to a group named "<extension name> (extension)" with the extension as source; plain text; no Fatal class; capped at 2 000 rows. |

Not covered: a malicious extension the user grants `write:edits` can still make bad (undoable) edits; `network:` hosts the user allows receive whatever the extension sends them.

## Testing

[Extension tests](../tests/extensions/extensions.cjs) and [API tests](../tests/core/atrium-api.cjs) run under Node and JavaScriptCore. Under JavaScriptCore, extension code runs in a separate JS realm that is reachable only through JSON. The suites cover sandbox isolation, permissions, proposal validation, limits and samples. The [MCP runner tests](../tests/automation/mcp_runner.py) cover the `run_script` sandbox. Browser-engine tests cover CSP and the restrictions on `import()` and `FontFace` in Chrome and WKWebView.
