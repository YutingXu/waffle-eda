# Unconnected Pins

Select one or more components and run **Tools › Find Unconnected Pins on Selected Part** (Ctrl+Alt+U). A right-dock panel lists every pin that connects to nothing:

- **No net**: the pin or pad has no net at all;
- **Only pin on NET**: its net reaches no other pin (turn this off in the settings to report only pins with no net).

Pins the library marks hidden or no-connect are skipped. Schematic pins get their nets from the sheet's connectivity, board pads from the part's pin nets. Click a row to select its part.

It shows the idiom for a **command with a selection context**: the manifest's `"when": "selection"` keeps the menu item, shortcut and palette entry unavailable until something is selected, and the results go to a **declarative panel** (`api.ui.setPanel` with `kv`, `table` with `rowCommand`, and `buttons`).

## Permissions

| Permission | Why |
| --- | --- |
| `read:project` | Reads the selection, pins, nets and connectivity. |
| `ui:command` | The Tools command and its shortcut. |
| `ui:panel` | The results panel. |

Read-only: it never changes the design.

## Test

`scripts/test-jsc.sh extension-examples`, or `jsc tests/jsc-shim.js -- "$PWD/extensions/examples/unconnected-pins/test.cjs"`.
