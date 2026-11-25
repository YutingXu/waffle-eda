# Net Colour Presets

**View › Net Colour Presets…** opens a panel of presets; click one to colour its nets on the active board:

| Preset | Nets |
| --- | --- |
| Power and ground | `GND*`, `AGND`, `VSS*`, `0V` blue; `VCC*`, `VDD*`, `VIN*`, `VBAT*`, `3V3`, `+5V`… red |
| Clocks and crystals | names containing `CLK`, `CLOCK`, `XTAL`, `OSC`, `SCK` |
| Differential pairs | names ending `_P`/`_N`, `+`/`-`, `_DP`/`_DM` |
| My preset | your own `Pattern=#rrggbb; …` list from the settings (`*` matches anything) |

**View › Clear Preset Net Colours** removes the colours it set. Colours set elsewhere (the Nets panel) are left alone.

It shows the idiom for **a View contribution**: `contributes.menus.view` and a right-dock panel whose table rows run a command. Net colours are saved with the board, so applying a preset is a change: it asks only for `propose:edits`, submits a **guarded proposal** (`api.proposals.submit`) that names the value each colour replaces, and the user reviews it; it is one undo step.

**API limitation.** AtriumAPI v1 does not return a board's `netColors` from `documents.get`, so the extension remembers what it last applied (`api.storage`) and guards with that. If a colour it set was changed elsewhere, the editor refuses the whole change instead of overwriting it, and the extension says so. A future API version that exposes `netColors` would remove this.

Scripts can apply ad-hoc rules: `api.commands.execute("netColours.apply", {rules: "GND*=#3f7fbf; V*=#c84f4f"})`.

## Permissions

| Permission | Why |
| --- | --- |
| `read:project` | Reads net names. |
| `propose:edits` | Proposes the colour changes; you review them. |
| `ui:command` | The View menu commands. |
| `ui:panel` | The presets panel. |

## Test

`scripts/test-jsc.sh extension-examples`, or `jsc tests/jsc-shim.js -- "$PWD/extensions/examples/net-colour-presets/test.cjs"`.
