# Silkscreen Label Generator

**Place › Generate Silkscreen Labels…** puts a line of silkscreen text under each selected component (or every component when nothing is selected), filled from a template:

```
{ref} {value}        {param:MPN}        {footprint}
```

Labels go on the Silk layer (Bottom silk, mirrored, for parts on the bottom), centred under the part's pads. A label whose fields are all empty is skipped. Running it again replaces the labels it made; **Tools › Remove Generated Silkscreen Labels** removes them. Generated labels carry `groupId: "silk-labels:<part id>"`; the board's own text is never touched.

It shows the idiom for **an edit with an undo proposal**: it asks only for `propose:edits`, so `api.transaction(...)` opens the editor's review dialog. The user can keep all, some or none of the changes, and what they keep applies as **one undo step**. If the board changed underneath, the editor refuses the stale change.

Settings: label text, text height, gap below the pads, and whether to ask for the text each time.

## Permissions

| Permission | Why |
| --- | --- |
| `read:project` | Reads parts, pads and parameters. |
| `propose:edits` | Proposes the labels; you review them before they apply. |
| `ui:command` | The Place and Tools commands, and the text prompt. |

It never asks for `write:edits`.

## Test

`scripts/test-jsc.sh extension-examples`, or `jsc tests/jsc-shim.js -- "$PWD/extensions/examples/silk-labels/test.cjs"`.
