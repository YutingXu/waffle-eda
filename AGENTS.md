# Instructions for coding agents

Read [HANDOFF.md](HANDOFF.md) for the code conventions, the startup budget and the verification commands.

## UI

- Build every piece of UI from the [UI library](docs/ui-library.md). This includes buttons, fields, selects, chips, badges, rows, sections, panels, notices, empty states, progress and dialogs. The library lives in `app/ui/`. The lazy builders are in `AtriumUIKit`.
- Do not invent controls or repaint a library component in feature CSS. If something is missing, add it to the library, to the gallery (`app/ui/gallery.js`) and to the docs in the same change.
- Settled designs and the [settled rules](docs/ui-library.md#settled-rules) change only with the user's approval. These rules include soft-fill buttons, no boxes inside boxes, compact dialogs, one accent colour and no browser quirks.
- Look at the living gallery at `app/index.html#ui-gallery` in light, dark and touch.

## Checks for UI changes

```sh
python3 -B tests/maintenance/css-tokens.py
python3 -B tests/maintenance/ui-library-lint.py
node tests/ui/browser-ui-gallery.cjs
node tests/ui/browser-ui-snapshots.cjs --app <base>/app --out /tmp/before   # on the base commit, then:
node tests/ui/browser-ui-snapshots.cjs --out /tmp/after --compare /tmp/before
node tests/editor/browser-no-quirks.js
node tests/integration-browser.cjs
```
