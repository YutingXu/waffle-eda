# Teardrop Audit

**Reports › Audit Teardrops** checks the active board and lists, in the **Messages** panel:

- track ends on a pad or via of the same net with no teardrop (Warning; **Locate** in the Messages panel selects the track and centres the view on it);
- teardrops whose track or pad no longer exists (Warning);
- a summary (Info).

A land counts only when it is at least *ratio* × the track width (setting, default 1.2). Vias and pads can be left out in the settings. Teardrops are recognised as the Teardrops tool makes them: filled graphics tagged `teardrop`, `teardropTrack` and `teardropAnchor`.

It shows the idiom for a **read-only check that reports to Messages**: `api.ui.showMessage(summary, {level, messages: [{class, text, objectId, point}]})`. The rows appear under "Teardrop Audit (extension)", replacing the previous run, and can never pose as one of the editor's own checks.

## Permissions

| Permission | Why |
| --- | --- |
| `read:project` | Reads tracks, vias, pads, parts and teardrops. |
| `ui:command` | The Reports command, and the status message and Messages rows. |

No edit permission of any kind.

## Test

`scripts/test-jsc.sh extension-examples`, or `jsc tests/jsc-shim.js -- "$PWD/extensions/examples/teardrop-audit/test.cjs"`.
