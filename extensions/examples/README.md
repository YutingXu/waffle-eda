# Example extensions and scripts

Small, tested, least-privilege examples to copy from. Each folder is a complete extension: `waffle-extension.json`, `main.js`, `README.md` (with its permissions) and `test.cjs`, which runs it in the sandbox harness.

| Example | Shows | Permissions |
| --- | --- | --- |
| [bom-template](bom-template/) | An **output**: BOM to Markdown/CSV with a column template | read:project, outputs:write, ui:command |
| [unconnected-pins](unconnected-pins/) | A **command with a selection context** and a **results panel** | read:project, ui:command, ui:panel |
| [teardrop-audit](teardrop-audit/) | A **read-only check** that reports to **Messages** | read:project, ui:command |
| [silk-labels](silk-labels/) | An **edit** reviewed as a **proposal**, one undo step | read:project, propose:edits, ui:command |
| [net-colour-presets](net-colour-presets/) | A **View contribution** with a guarded proposal | read:project, propose:edits, ui:command, ui:panel |
| [net-length-report](net-length-report/) | A live panel driven by events, CSV export | read:project, outputs:write, ui:panel, ui:command |
| [renumber-by-x](renumber-by-x/) | Direct edits with settings and a shortcut | read:project, write:edits, ui:command |
| [pcb-geometry](pcb-geometry/) | Generated copper (teardrops, stitching vias) | read:project, write:edits, ui:command |

[`scripts/`](scripts/) holds console scripts (renumber by position, select by footprint, export net lengths, widen power tracks, snap to grid); see [docs/scripting.md](../../docs/scripting.md).

## Start your own

```sh
python3 scripts/new-extension.py yourname.my-extension          # extensions/examples/my-extension/
python3 scripts/new-extension.py yourname.my-extension --out ~/src/my-extension
```

or **Tools › Extensions… › New Extension…** in the app, which saves the same starter as a `.zip`. Then turn on **Preferences › Extension Development › Developer mode** and use **Load unpacked…**, **Reload from folder** and **Console** while you work. The full API is in [docs/extension-api.md](../../docs/extension-api.md).

## Tests

```sh
scripts/test-jsc.sh extension-examples                     # every example, the scaffold, developer mode, the scripts
jsc tests/jsc-shim.js -- "$PWD/extensions/examples/silk-labels/test.cjs"   # one example
```

(`jsc` is `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc` on macOS; with Node 18+, `node <test>.cjs` works too.) [`harness.cjs`](harness.cjs) loads an extension the way the editor does: its code runs in a separate JS realm joined to the host only by JSON messages, with the real permission checks, proposals and limits, against an in-memory example project. Consent prompts are answered by `h.answers`.
