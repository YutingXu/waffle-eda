# BOM Template Export

**Reports › Export BOM as Markdown (Template)…** and **…as CSV (Template)…** write a bill of materials with the columns *you* define.

```
Qty={qty}, Designators={refs}, Value={value}, Footprint={footprint}, MPN={param:MPN}
```

- A column is `Title={field}`. A cell can mix text and fields: `Part={value} ({param:Tolerance})`.
- Fields: `qty`, `refs`, `value`, `footprint`, `name`, `category`, `prefix`, `param:<Name>` (component or library parameter, case-insensitive).
- **One line per** (setting) lists the fields that must match for parts to share a line, e.g. `value, footprint`.
- **Read parts from**: the active document, the schematic (all sheets) or the board.
- CSV cells that start with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets never run them as formulas.

It shows the idiom for an **output contribution**: read with `read:project`, build text, hand it to `api.files.export`, which opens the system save dialog. Scripts can call it too: `api.commands.execute("bomTemplate.csv", {template: "{refs},{value}", save: false})` returns `{name, lines, parts, text}`.

## Permissions

| Permission | Why |
| --- | --- |
| `read:project` | Reads parts, their library definitions and parameters. |
| `outputs:write` | Saves the file through the system save dialog. |
| `ui:command` | The two Reports menu commands. |

No edit, panel or network permission.

## Test

`scripts/test-jsc.sh extension-examples`, or on its own: `jsc tests/jsc-shim.js -- "$PWD/extensions/examples/bom-template/test.cjs"`.
