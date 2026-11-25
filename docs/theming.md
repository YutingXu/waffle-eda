# Theming and customisation

Appearance settings live in **File → Preferences… → Appearance** (`Mod+,`) and **View → Theme → Appearance Settings…**.

## Presets and options

| Setting | Values |
| --- | --- |
| Theme | **Dark** (default), **Light**, **High Contrast**, **Classic** grey. "Follow system" switches between a light and a dark choice with the OS. |
| Accent | The desktop uses the system accent when available. The browser defaults to blue. You can choose a preset accent or enter a custom colour. |
| Density | Compact, Default, Comfortable (row and bar heights) |
| UI font size | 11, 12, 13 or 14 px |
| Animations | System (Full, or Reduced when the OS asks), Full, Reduced (fades only), Off (`motion`: `system`, `full`, `reduce`, `off`) |
| Canvas | Follow the theme, or set the PCB background, schematic background and sheet colour separately |

The built-in presets use contrast checks for text and control states (`tests/theme.cjs`). Waffle applies the theme before first paint.

PCB layer colours are separate: **View Configuration** (`L` on a board, or **View → View Configuration…**) edits layer colours, opacity and system colours. **Reset to Altium®-style defaults** restores the classic layer palette.

## Theme files

**Export…** and **Import…** in the Appearance page read and write a small JSON file:

```json
{
  "atrium-theme": 1,
  "preset": "dark",
  "accent": "#3794ff",
  "density": "compact",
  "fontSize": 13,
  "motion": "system",
  "canvas": {"follow": false, "pcbBackground": "#101418"},
  "tokens": {"panel": "#262a30", "selection": "#2d4f7c"}
}
```

- Missing keys take their defaults. The file is validated before it is applied.
- `tokens` overrides individual design tokens on top of the preset. The token names are listed in `TOKENS` in `app/theme.js`; they match the CSS custom properties in `app/style.css` without the leading `--`. Examples are `app`, `chrome`, `panel`, `ink`, `muted`, `accent`, `selection`, `focus`, `primary`, `canvas-bg` and `sheet`.
- Colours are `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.

Share a theme by publishing the JSON file. A theme cannot contain code.

## VS Code® themes and keybindings

- **Preferences → Appearance → Import VS Code theme…** accepts a theme `.json` (comments allowed) or a `.vsix`. Workbench colours map onto Waffle tokens, text is checked for WCAG contrast, and you can also take its colours for the canvas. Colours with no Waffle counterpart (editor syntax, terminal, minimap) are listed and skipped.
- **Preferences → Keyboard → Import VS Code keybindings…** accepts your `keybindings.json`. Commands with a Waffle equivalent are added on top of your key map. Nothing changes until you apply, and VS Code `when` clauses are ignored.

## Keyboard

Open **Tools → Keyboard Shortcuts…** to manage bindings.

- Record chords or Altium-style sequences and choose where they apply.
- See conflicts between bindings.
- Switch among the seven built-in shortcut profiles.
- Import or export a key map (`{"format": "atrium-keys", "version": 1, "preset", "bindings"}`).

The Mac interface uses the same modifier symbols as System Settings. For example, ⇧⌘P means Shift–Command–P and ⌃W means Control–W. Windows and Linux show modifier names joined with a plus sign. A comma separates the steps of a sequence. [All shortcut profiles](shortcuts.md)

## Everything at once

**Preferences → General → Settings sync** offers **Export all settings…** and **Import all settings…**. The bundle includes preferences, theme, key map and panel layout. Waffle filters recognised secret fields. Review the export for private settings or paths before sharing it.

## Further customisation

- **Project templates:** `AtriumTemplates.register(spec)` adds an entry to the start page and File → New from Template (see `app/templates.js`).
- **Extensions** can add commands, menus, Active Bar buttons, panels and status items ([extensions.md](extensions.md)).
- **Panels:** dock sections collapse and remember their state. **Window → Panels** shows or hides each panel (a check marks the open ones), and a dock's tab header ends in a menu of the tabs that do not fit.
