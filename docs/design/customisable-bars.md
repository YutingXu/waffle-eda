# Customisable bars

Status: design approved by the owner on 2026-11-27 with the recommended choices below; no code yet. Scope for Butter is the Active Bar. The same
model is meant to carry the other bars in Coconut.

## Goal

The user chooses which commands sit on the Active Bar, in what order, in which flyout group, for
each document kind, and can put it all back. Settings export, reset and extensions keep working
without special cases.

## Principle: add no new concept that already exists

The Active Bar hard-codes three things in markup and constants. Each already has an owner elsewhere:

| The bar needs | Today | Reused owner |
| --- | --- | --- |
| What a button does, its name and its shortcut | `data-action` plus `title` in `app/index.html` | The command registry, `AtriumKeymap.command(id)`: `title`, `short`, `action`, shortcut via `hintKey` |
| When a button shows | `data-scope="pcb"` on the button; `when` on extension buttons | The command's compiled `when` test, plus the document kind |
| Which commands share a flyout | The `GROUPS` constant in `app/editor/active-bar-menu.js` | Bar data (below); `GROUPS` stays as the default |
| Where the choice is stored | Nowhere | `AtriumPrefs`, as the dock does with `workbench.layout` |
| Export, import, reset, unknown-key safety | — | The existing settings bundle and Restore Defaults, which already cover every preference |
| Customise UI | — | A Preferences page built from `AtriumUIKit` (`search`, `list`, `row`, `dragHandle`, `segmented`) |
| Drag feedback | — | `ui/spatial-motion` (`.ui-drag-lift`) and `K.dropState` |

So a bar is **an ordered list of command ids**. Nothing about a command is copied into the bar.

## Model

One preference key, `workbench.bars`. It holds only what the user changed.

```json
{
  "version": 1,
  "active": {
    "pcb": ["select", "pan", "|", {"face": "library", "more": ["via", "polygon-pour", "label"]},
            {"face": "route", "more": ["route-diffpair", "length-tune"]}, "|", "measure", "comment-mode"]
  }
}
```

- An item is a command id, the separator `"|"`, or a group `{face, more}`. `face` is the button;
  `more` is its flyout.
- Bars are stored per document kind (`schematic`, `pcb`, `drawing`), following
  `workbench.kindLayouts`. A kind with no entry uses the default.
- **The default is the markup.** On first use the model reads the static `#tools` markup and
  `GROUPS` once and treats that as the default definition. There is no second table to keep in
  step, and a user who never customises pays nothing at startup.
- An id the registry does not know (an extension that is switched off) is kept in the list and not
  drawn, as the key map does with unregistered bindings.

## Rendering contract

The renderer writes the **same DOM the static markup has today**: `button.tool[data-action]
[data-tool-group][data-scope]` inside `#tools.active-bar.ui-canvas-tools`. Everything that already
reads the bar keeps working unchanged: tooltips and live shortcuts (`AtriumActiveBar.titles`),
flyouts, roving focus, the tutorial's highlights, `drawing.js`, tool pressed states and the settled
28 px tool styling. The flyout asks the model for a group and falls back to `GROUPS`.

Test invariant: a stored bar equal to the default renders markup identical to the static bar.

Startup: the renderer is lazy (`app/lazy.js`). A few eager lines check whether `workbench.bars` has
an entry for this kind and, if so, hold the bar hidden until the renderer has drawn it, the way the
dock applies its saved sizes early. Target cost for the eager budget: under 1 KB.

## What the registry gains

One optional field on a command: `icon`, the name of an existing sprite symbol (`#i-…`). It lives in
the registry, not the bar, so menus and the palette can use it later. A command with no icon shows
its `short` title as a text face, which `route` and `label` already do (`.tool-label`). No icon
picker and no new artwork in the first version.

## Extensions

`api.ui.addActiveBarButton` keeps its signature. Its button becomes an ordinary item appended to the
default list for the kinds its `when` allows. The user can move, group or hide it like any other. No
API version change.

## Macros

Saved macros need no extra mechanism. `app/automation/macro-service.js` already registers each one in
the command registry as `butter.macros.alias.<alias>`, with the macro's name as the title, the
category **Macros**, and `when: "selection"` for macros that need a selection. So macros appear in
the Toolbars page's search under Macros and sit on a bar like any other command.

- **Scope.** A bar is a per-profile preference; macros belong to a workspace. The bar stores the
  alias id, so the button shows in every workspace that has a macro with that alias and is simply
  not drawn elsewhere (the unknown-id rule above).
- **Parameters.** A macro with parameters opens the existing **Run…** dialog from
  `app/automation/macros-ui.js` when its button is pressed; one without runs at once. Edits still
  arrive through the existing guarded run and its receipt.
- **Face.** Macros have no icon, so they use the text face with the macro's name.
- **Gate.** Macros are registered only while `butter.macros` is on, so macro buttons follow that
  flag with no extra check.

## Sticky flyouts

Approved by the owner on 2026-11-27: this is the Altium behaviour. Choosing an item from a flyout
makes it that button's face, with its icon, name and shortcut. A click on the button then runs the
shown tool; long-press, right-click and ArrowDown still open the flyout. The last choice is
remembered per group and per document kind as view state, alongside the dock's collapsed-panel
state, and is not an edit to the stored bar. Restore Defaults clears it.

## Additions to the default bar

Approved by the owner on 2026-11-27. These change the shipped default, so they go into the static
markup like every other default button.

- **Widgets**, on schematic sheets, with a flyout of everything the notebook can insert: text block,
  calculation, image, table, to-do list and the other sheet widgets, including widgets from
  extensions. The flyout is **provided**, not listed: the notebook supplies the group from the same
  catalogue the "/" insert palette shows (`palette-actions.js` insert rows and the `sheet-widgets`
  provider in `widget-catalogue.js`), the way `AtriumDrawing.toolGroups` already supplies groups for
  drawings. Choosing an entry runs the palette entry's own `run`. The button is hidden while the
  notebook is off, through the existing `data-notebook-action` attribute. With sticky flyouts,
  choosing Widgets › Text block turns the button into Text block.
- **GND** and **VDD** power ports, on schematic sheets. They use the existing `power:<net>` key that
  the palette, aliases and shortcut hints already understand (`palette.js`, `palette-personal.js`,
  `keymap.js`), so a bar item may be a command id or one of these existing keys. Their faces are
  drawn from the power-port symbol geometry the schematic already renders, not from new artwork.

## Customise UI

A **Toolbars** page in Preferences, registered with `registerPage` like the other pages.

- A `segmented` control picks the document kind.
- A reorderable `list` of the bar's items. Each `row` shows the icon, the title, the shortcut badge,
  a drag handle and a remove button. A group row expands to show its flyout members (`row` already
  has `expanded` and `depth`).
- A `search` field adds commands, using the palette's search index so aliases work.
- Restore Defaults for this bar, using the page's existing reset pattern.
- The real bar updates as you edit; Preferences is already modeless.

Entry points: **View › Customise Active Bar…**, the same command in the palette (so it can be bound
to a key), and the bar's context menu on empty space. All three open Preferences on this page.

Nothing here needs a new control. If the reorderable list needs behaviour the kit lacks, it is added
to the kit, the gallery and `docs/ui-library.md` in the same change.

## Limits

- At most 24 items per bar and 16 per flyout.
- When the bar is wider than the canvas, trailing items move into a "⋯" flyout that uses the same
  `nav-flyout` menu. Today the centre placement scrolls sideways instead; this replaces that.

## Phases

1. **Butter.** Model, renderer, storage, the Preferences page, extension buttons as items, reset and
   export. Unit tests for the model; a browser test for the rendering contract; a gallery entry.
2. **Butter, if wanted.** Drag directly on the bar; placement (the `center` and `right` placements
   already exist in `.ui-canvas-tools`).
3. **Coconut.** Register the other bars with the same model: quick access, status bar, layer bar
   extras, then menus. Fold bars into saved workspace layouts. The Toolbars page lists every bar.

## Decisions for the owner

1. **Sticky flyouts.** Should choosing a flyout item make it the button's face, as Altium does?
   Today it only runs the command. Recommendation: yes, as a remembered state per group, not as an
   edit to the stored bar.
2. **Per-kind bars** (recommended) or one bar for all kinds.
3. **Home of the editor.** A Preferences page (recommended, and it scales to Coconut) or a
   standalone dialog.
4. **Commands without an icon.** Text face (recommended, already exists) or an icon picker.
5. **Overflow.** A "⋯" flyout (recommended) or keep sideways scrolling.

## Not verified

- That every tool pressed state is applied by `[data-action]` query and survives a re-render. Only
  three direct `#tools` readers were found (`active-bar.js`, `drawing.js`, `tutorial.js`).
- That the palette's search index can be queried for commands alone.
- Touch behaviour of a reorderable list in Preferences.
- What a parameterised macro's command does when run with no parameters today (the bar should open
  **Run…** in that case).
