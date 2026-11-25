# __NAME__

A Waffle extension: counts the objects on the active document, by kind, in a panel.

## Permissions

| Permission | Why |
| --- | --- |
| `read:project` | Reads the objects on the active document. |
| `ui:command` | Adds **Tools › __NAME__: Show**. |
| `ui:panel` | Shows the counts in the right dock. |

It has no edit, file or network permission.

## Develop

1. Turn on **Preferences › Extension Development › Developer mode**.
2. **Tools › Extensions… › Load unpacked…** and pick this folder. It carries a *Developer* badge.
3. Edit `main.js`, then press **Reload from folder**. **Console** shows `console.log` output and errors.

## Test

```sh
# macOS, no Node needed
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc __WAFFLE__/tests/jsc-shim.js -- "$PWD/test.cjs"
# or, with Node 18+
node test.cjs
```

`test.cjs` loads the extension into Waffle's sandbox harness (`extensions/examples/harness.cjs`): the code runs in a separate JS realm with the real permission checks, against an in-memory example project.

## Package

Zip this folder and install it with **Tools › Extensions… › Install from package…**. To list it in a registry, see `docs/extension-registry.md` and `scripts/registry-entry.py`.

## Licence

MIT
