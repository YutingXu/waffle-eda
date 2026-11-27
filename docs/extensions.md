# Writing a Waffle EDA extension

Extensions add commands, menus, panels and design automation in plain JavaScript against **AtriumAPI v1**. The same API runs in the Scripting Console and headlessly over MCP (`run_script`). This guide walks through a first extension. Every call, with its permission, parameters, return value, limits and an example, is in the generated [API reference](extension-api.md). The manifest reference and threat model are in [extensions/README.md](../extensions/README.md); console scripts are in [scripting.md](scripting.md).

**The 15-minute path:**

1. `python3 scripts/new-extension.py yourname.my-tool` (or **Tools › Extensions… › New Extension…**, which saves the same starter as a `.zip`).
2. Turn on **Preferences › Extension Development › Developer mode**, then **Tools › Extensions… › Load unpacked…** and pick the folder.
3. Edit `main.js`, press **Reload from folder**, watch **Console**.
4. Run its sandbox test: `jsc tests/jsc-shim.js -- "$PWD/extensions/examples/my-tool/test.cjs"` on macOS, or `node extensions/examples/my-tool/test.cjs`.
5. Copy idioms from the examples in [`extensions/examples/`](../extensions/examples/).

## How the sandbox works (the short version)

- Each extension runs in its **own Web Worker**, inside a hidden sandboxed iframe with an opaque origin and the CSP `default-src 'none'`. It has no `document`, `window`, storage, editor globals or native bridge, and it cannot load or send anything over the network by itself.
- Every API call is a message that the editor checks against the permissions **you granted** that extension, on every call.
- Reads return copies. Writes become a guarded proposal (`AtriumProposal` v2) applied as **one undo step**. If the objects changed since the extension read them, the proposal is refused.
- Commands time out after 5 s by default. Idle CPU, message rate (2,000 calls/s), message size (16 MB) and dialogs are all capped. **Esc three times** while extension work is running, **Ctrl/⌘+Shift+Esc** at any time, **Pause all** in the manager or the status bar stops everything.
- Only the manifest is read at startup. Code loads when an activation event fires, so an idle extension costs nothing.

## Choose edit access

Open **Tools › Extensions**, select the named extension and open **Permissions**. The choices appear for capabilities declared in its manifest.

| Access | What happens |
| --- | --- |
| Read only | Enable **read:project**, turn off **propose:edits**, and choose **Deny** for **write:edits** if declared. |
| Propose | Turn on **propose:edits** and leave direct writes denied. The editor shows the before and after values and applies your selection in one step. |
| Direct edits on this project | For an extension declaring **write:edits**, choose **Ask each time**, allow one action at the prompt, or explicitly choose **Allow for this project**. |

A saved-target grant belongs to the extension and the exact project path. A browser project or unsaved design keeps its grant only while that project is open. A new target asks again. Older direct-write grants had no target and now ask on first use. **Deny** or **Reset permissions** revokes direct access. Existing trust checks for bundled, installed, project and developer extensions still apply. File export, network and program execution have their own grants.

An installed extension has only the permissions you ticked. An update that asks for different permissions shows the prompt again, and **Cancel** keeps the installed version with its current answers.

The built-in AI Assistant declares **propose:edits**. Its card holds the exact edit and generated object IDs first previewed. Choosing **Review proposal** opens the editor's selection dialog. A changed planning input, replaced project or expired draft requires another proposal. The host also checks guards, the current grant, document locks and revision state at Apply. Extensions can use the same workflow with `api.proposals.draft` and `api.proposals.review`.

## 1. Create the package

```
hello-nets/
  waffle-extension.json
  main.js
```

`waffle-extension.json`:

```json
{
  "id": "yourname.hello-nets",
  "name": "Hello Nets",
  "publisher": "yourname",
  "version": "0.1.0",
  "apiVersion": 1,
  "description": "Lists the nets on the active board.",
  "main": "main.js",
  "activationEvents": ["onCommand:helloNets.show"],
  "permissions": ["read:project", "ui:command", "ui:panel"],
  "contributes": {
    "commands": [{"command": "helloNets.show", "title": "Hello Nets: Show", "when": "pcb"}],
    "menus": {"tools": [{"command": "helloNets.show"}]},
    "panels": [{"id": "helloNets", "title": "Hello Nets", "location": "right"}]
  }
}
```

`main.js` is a CommonJS module:

```js
exports.activate = function (api, context) {
  api.commands.register("helloNets.show", async () => {
    const nets = await api.nets.list();
    await api.ui.setPanel("helloNets", [
      {type: "heading", text: nets.length + " nets"},
      {type: "table", columns: [{key: "name", title: "Net"}], rows: nets.map(n => ({name: n.name}))}
    ]);
    await api.ui.showPanel("helloNets");
  });
};
exports.deactivate = function () {};
```

Panels are declarative data: headings, text, tables, lists, forms, buttons and plots. The editor renders them, so you never touch the DOM.

## 2. Try it

1. Turn on **Preferences › Extension Development › Developer mode**.
2. **Tools → Extensions… → Load unpacked…** and pick `hello-nets/`. The dialog lists the permissions requested. The extension carries a **Developer** badge.
3. Run **Tools → Hello Nets: Show**, or find it in the command palette.
4. Edit `main.js` and press **Reload from folder** in the manager. **Console** shows its `console.log` output and errors live.
5. Try API calls first in **Tools → Scripting Console**. It runs the body of an async function with `api`, `console` and `args`, and `Mod+Enter` runs it.

Without developer mode, **Install folder…** installs the folder as an ordinary extension.

### Developer mode

Developer mode is **off by default**. While it is on:

- **Load unpacked…** loads a folder you pick with the system folder picker. Nothing else on disk is read: **Reload from folder** re-reads the files that picker granted, or asks for the folder again.
- An unpacked extension runs exactly like an installed one: its own worker in the sandboxed iframe (CSP `default-src 'none'`), the same permission prompt and per-call checks.
- Each load is **pinned to the SHA-256** of its manifest and files (shown in the prompt, the manager and the Console). Grants belong to that digest; a reload with the same permissions keeps your answers, a reload asking for more asks again. The digest is re-checked whenever the code starts.
- The code is kept in memory only: unpacked extensions are forgotten when Waffle quits or developer mode is turned off, and they cannot take the id of an installed or built-in extension.

### Examples to copy from

| Example | Shows |
| --- | --- |
| `extensions/examples/bom-template` | An output: BOM to Markdown/CSV with a column template (`outputs:write`) |
| `extensions/examples/unconnected-pins` | A command with `"when": "selection"` and a results panel |
| `extensions/examples/teardrop-audit` | A read-only check that reports to the Messages panel |
| `extensions/examples/silk-labels` | An edit reviewed as a proposal (`propose:edits`), one undo step |
| `extensions/examples/net-colour-presets` | A View menu contribution with a guarded proposal |
| `extensions/examples/net-length-report`, `renumber-by-x`, `pcb-geometry` | Live panels and events; direct edits; generated copper |

First-party extension sources live under `extensions/`. This includes Calculators, AI Assistant, SPICE and [Signal Integrity](si-simulation.md). Preparation writes an index and one package per extension in `app/extensions/`. The editor reads the manifests first and loads an extension’s package when needed. The generated `bundled.js` index gives CommonJS tooling access to those packages through lazy `files` properties.

The optional [Motion Inspector developer extension](../extensions/developer/motion-inspector/README.md) uses the same installer and grants. Open it from the command palette or Window → Panels after installing and enabling the extension.

## 3. Choose permissions

Declare the permissions your extension uses. The downloadable registry, the package installer and the API reference use the same permission names. The install prompt explains each requested capability. [Permission reference](extension-api.md#permissions)

- Set `enabledByDefault: false` to install in a disabled state until the user chooses Enable. Updates keep an existing opt-in.
- Ask for `propose:edits` when the user should review a change. Direct editing requires separate approval for the current project. [Edit access](#choose-edit-access)
- A notebook widget uses `ui:widgets` and `ui:command`. Add `read:project` when the widget binds a field or calculation to design data. An AI provider uses `ai:provider` and requires project consent to answer questions. [Widget examples](extension-api.md#sheet-widgets) · [AI provider example](../extensions/examples/ai-provider/waffle-extension.json)
- Network hosts and external programs require explicit approval. Declare each network host and each external tool. A program approval is scoped to the extension version and argument template. [External tools](#external-programs-connectors)

## 4. Edit the design

```js
await api.transaction("Widen power tracks", tx => {
  for (const t of tracks) tx.update(t.id, {width: 0.5});
});
```

Every operation is validated against the model, and the whole project is validated afterwards. If anything fails, nothing changes. With `propose:edits`, the user sees the changes and can apply a subset.

### Proposing field edits

`api.proposals.propose(edits, {label})` is the simplest reviewed edit: name the fields and their new
values, and the user reviews them as the visual diff shows them. Only data fields can be proposed
(`api.proposals.fields()`): a part's `sim`, `value` and `parameters`, a library definition's `sim`,
`parameters` and `description`, and `project.simulation` (models, assignments, test benches).

```js
await api.proposals.propose([
  {target: "item", id: part.id, path: ["sim"], value: {model: "D1N4148"}},
  {target: "project", path: ["simulation", "benches"], value: benches}
], {label: "Save test bench"});
```

The project is validated before the dialog opens, and the user's answer is final: proposing the
same edits again after a Discard fails at once, with no second dialog. Even `write:edits` does not
skip this review.

### Canvas decorations

With `ui:decorations`, `api.ui.decorations.set(docId, items)` draws read-only text and marks above
the design: operating-point voltages, probe points, markers. Items are data only
(`{kind: "label" | "probe" | "marker", text, at | anchor: {id, pin?}, tone}`); anchored items follow
their object. They have no hover pop-ups, never become design objects and are removed when the
extension stops. Limits: 2,000 per document, 120 characters of text each.

### External programs (connectors)

A connector extension drives a program the user installed, such as LTspice or ngspice, the way a
VS Code language extension uses an interpreter path:

```json
"permissions": ["run:external", "ui:command"],
"contributes": {"externalTools": [{"id": "ngspice", "name": "ngspice", "homepage": "https://ngspice.sourceforge.io",
                                   "args": ["-b", "-r", "--out={output}"]}]}
```

- The user chooses the program in **Preferences › External Tools** (Choose…, or a detected install
  path they confirm). Waffle never downloads a program or picks one silently. Extensions name the
  tool by id and never see or pass its path.
- `api.external.run("ngspice", {args, files, outputs, timeoutMs})` runs it in a new temporary
  folder holding `files`, with the arguments as a list (no shell), a minimal environment, a
  timeout, caps on output and cancellation (`runId` with `api.external.cancel`, or the extension
  stopping). It returns the exit code, stdout, stderr and the `outputs` files.
- **Approval.** The first run shows the full command (program and every argument) in a native
  dialog. Allow holds for this extension *version* (its `id@sha256` content hash, as trust and grants
  are), this tool and this program file (its resolved path; symlinks are followed on macOS and Linux
  and on Windows where .NET can), for runs that pass only declared arguments:
  - the run's own input file names (`files`) and plain names matching its `outputs` patterns;
  - the entries of the tool's `args` template, each literal (`"-b"`) or with one `{input}` or
    `{output}` standing for such a name (`"--out={output}"`); at most 64 entries.

  A run with any other argument (another flag, a path, a name that is not one of its files) shows the
  full command again and asks for that exact command, which is then remembered for that version. An
  update of the extension, another program file, or a changed symlink target asks again; Forget in
  Preferences › External Tools drops the tool's approvals. Declare every flag your runs use, so that
  people approve once per version and an unexpected argument stands out.
- Only the desktop app runs programs (macOS; the Linux and Windows hosts carry the same code but
  are not yet tested). In the browser, `api.external.tools()` reports `available: false`.

### Panel UI kit

Panels are declarative: `heading`, `text`, `code`, `kv`, `button`, `buttons`, `list`, `table`,
`form`, `stack`, `plot`, and `chip` / `chips` for status badges (`{type: "chips", items: [{text:
"Vendor", tone: "success"}, {text: "3 defaults", tone: "warning"}]}`; tones `info`, `success`,
`warning`, `danger`, `accent`, `muted`). A `list` item takes a `badge` the same way. A `buttons`
item with `pressed: true` or `false` is a toggle, for a choice such as an analysis type. There is no
HTML view type: extension text is always shown as text.

## 5. Settings, storage and keys

- `contributes.settings` declares typed settings that the user edits in the manager. Read them with `api.settings.get()`.
- `api.storage` is per-extension JSON storage of up to 256 KB. Never ask users to put API keys in the project. Keep them in `api.storage`, as the AI Assistant does.
- `contributes.keybindings` default keys must use Ctrl, Alt or Cmd, or a function key. They join the editor keymap, so users can rebind them.

## 6. Ship it

**Package.** Zip the folder, or write a `.waffle-extension` bundle (`{"manifest": {...}, "files": {"main.js": "..."}}`). Users install it with **Install from package…**.

**Inside a project.** **Add to project** stores the extension in the `.waffle` file. Anyone who opens the project sees it as *Blocked* until they choose **Trust and enable**. Trust is bound to `id@sha256` of the canonical bundle, so any change to the code blocks it again and shows the permissions again.

**Registry.** Users can install from an extension index with **Tools › Extensions… › Browse…**. The index lists each package with its permissions and SHA-256, and Waffle refuses any package that does not match. See [extension-registry.md](extension-registry.md) for the format and `scripts/registry-entry.py`, which prints an entry for your package. Either way, publish a release on your own repository with:

- the bundle and its SHA-256;
- a README that lists each permission and why it is needed;
- a licence (MIT or Apache-2.0 is recommended for compatibility with Waffle);
- no third-party vendor code, libraries or logos (see the clean-room policy in [CONTRIBUTING.md](../CONTRIBUTING.md)).

## 7. Test

- Every scaffold and example has a `test.cjs` that runs in the sandbox harness, `extensions/examples/harness.cjs`: your code runs in a separate JS realm joined to the host only by JSON messages, with the real permission checks, proposals and limits, against an in-memory example project. `h.answers` answers the permission and review prompts. Run one with `jsc tests/jsc-shim.js -- "$PWD/<folder>/test.cjs"` on macOS (no Node needed) or `node <folder>/test.cjs`; `scripts/test-jsc.sh extension-examples` runs all the examples.
- `tests/extensions/extensions.cjs` and `tests/core/atrium-api.cjs` cover the host itself: sandbox escapes, permissions, limits.
- Headless: `AtriumScripting.runHeadless(project, code, {timeoutMs})`, or the MCP `run_script` tool, runs the same API without the editor.

## Checklist before publishing

- [ ] Fewest permissions; no `write:edits` unless direct edits are the point.
- [ ] Any `network:` host is named in the README, with what is sent there.
- [ ] Work stays well under the 5 s command limit, or you set `timeoutMs` and `"worker": "dedicated"`.
- [ ] Subscriptions are pushed into `context.subscriptions` so they are disposed.
- [ ] No secrets in `project.extensions` or in example projects.
