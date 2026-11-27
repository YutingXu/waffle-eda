# Colour themes

Waffle's colour themes work like VS Code's. A theme is one JSON document. It colours the whole
workbench, the PCB canvas (system colours and copper and other layers), the schematic canvas and
the scripting console's syntax colours. You can pick a theme with live preview, customise any
colour on top of a theme, export it and share it, import Waffle and VS Code themes, follow the
operating system's light/dark setting, and install themes that extensions contribute.

| Where | What |
|---|---|
| **Ctrl/⌘+K Ctrl/⌘+T**, View › Theme › Color Theme… | Quick pick: ↑/↓ previews each theme live, Enter keeps it, Esc puts the previous one back, typing filters |
| Preferences › Appearance (Ctrl/⌘+,) | Gallery with a thumbnail of each theme (the sample board and sheet drawn in its colours), preferred light and dark themes, accent, density, font size, motion, canvas overrides |
| View › Theme › Customize Theme… | Theme editor: every token and canvas colour, live preview, contrast check, Export theme… / Import theme… |
| View › Theme | Every built-in theme as a menu item, Follow System, Toggle Light/Dark |
| Preferences › Appearance › Import VS Code theme… | A VS Code `.json` or `.vsix`; it becomes one of your themes |

## Built-in themes

All built-in themes are original. Each meets WCAG AA (4.5:1) for every text pair the library
checks (3:1 for focus rings and markers), and its copper layers are told apart by colour.
`tests/maintenance/css-tokens.py` checks both.

| Theme | Type | Character | Lowest text contrast | Closest copper pair (ΔE) |
|---|---|---|---|---|
| Dark | dark | The default; Altium's board colours | 4.5:1+ (CSS preset) | 29.0 (Altium layers) |
| Light | light | VS Code Light+-like workbench | 4.5:1+ | 29.0 |
| High Contrast Dark | hc-dark | Black, cyan outlines, blue fallback focus | 6.5:1 | 29.0 |
| Classic Grey | light | Windows-era grey | 4.5:1+ | 29.0 |
| **Ember** | dark | Warm charcoal, amber accent | 5.30:1 | 31.1 |
| **Fjord** | dark | Cool blue slate, glacial cyan accent | 5.35:1 | 26.7 |
| **Obsidian** | dark | True black for OLED: pixels off wherever nothing is drawn | 5.73:1 | 25.1 |
| **Clearview** | dark | Colour-vision friendly: copper layers chosen for deuteranopia | 5.32:1 | 41.9 (30.7 with deuteranopia) |
| **Soldermask** | dark | Just for fun: a green solder-mask bench, gold copper, white silk | 5.00:1 | 36.5 |
| **Haze** | light | Soft, low-glare warm grey instead of white | 4.67:1 | 29.0 (Altium layers) |
| **Vellum** | light | Paper and ink, with a light board, for review and screenshots | 4.68:1 | 27.3 |
| **High Contrast Light** | hc-light | Black on white, dark-blue outlines, red focus | 5.73:1 | 29.0 |

ΔE is CIE76 in CIE L\*a\*b\* between every pair of Top, Bottom and Inner 1–6. A theme that sets its
own layers must keep every pair at **ΔE ≥ 25** and every copper layer at **3:1 or more on the board**.
Clearview also keeps **ΔE ≥ 25 under simulated deuteranopia** (Machado, Oliveira and Fernandes 2009,
severity 1). The other themes are not tuned for colour-vision deficiency; use Clearview, or set your
own layer colours in the editor (it shows both ΔE figures live).

## The theme document (`atrium-theme` v1)

```json
{
  "atrium-theme": 1,
  "name": "Harbour",
  "type": "dark",
  "author": "You",
  "description": "Optional, shown as the gallery tooltip.",
  "extends": "fjord",
  "palette": {"background": "#11161d", "surface": "#1b232e", "foreground": "#dbe5f0", "accent": "#4fd1e0"},
  "colors": {"selection": "#24476b", "--muted": "#a9b6c4"},
  "canvas": {
    "pcb": {
      "system": {"workspace": "#18202a", "board": "#070a0e", "edge": "#8fb0cc"},
      "layers": {"Top": "#ff6b5e", "Bottom": "#3b8bff", "Inner 1": "#ffc94a", "Silk": "#f2f6ff"}
    },
    "sch": {"workspace": "#55606e", "paper": "#fbfcff", "grid": "#e2e8f0"}
  },
  "syntax": {"keyword": "#82aaff", "string": "#a5e3a0", "comment": "#7f8fa3"},
  "iconTint": "#c8d4e0"
}
```

| Key | Required | Meaning |
|---|---|---|
| `atrium-theme` | yes | The format version, `1` |
| `name` | yes | Up to 80 characters |
| `type` | yes | `dark`, `light`, `hc-dark` or `hc-light`. It picks the derivation defaults, the CSS base block and `color-scheme` |
| `extends` | no | A theme id to start from (`ember`, `user:…`, `ext:…/…`). Missing bases fall back to the type's defaults, with a warning |
| `palette` | no | Base colours: `background`, `surface`, `foreground`, `accent`, `primary`, `selection`, `focus`, `border`, `error`, `warning`, `success`, `info`. Opaque hex |
| `colors` | no | Any UI token from `AtriumTheme.TOKENS` (with or without `--`). Hex; `#rrggbbaa` is allowed for shadows and translucent fills |
| `canvas.pcb.system` | no | PCB system colours (`AtriumPCBAppearance.defaultSystem` keys: workspace, board, grids, edge, holes, dim, selection, connection, origin, padText) |
| `canvas.pcb.layers` | no | Layer colours by Waffle layer name: `Top`, `Bottom`, `Inner 1`…`Inner 126` (Inner 13+ repeat 1–12), `Silk`, `Bottom silk`, `Multi`, masks, pastes, `Keepout`, `Mechanical`, `Mechanical 1`…`32`, `Drill guide`, `Drill drawing` |
| `canvas.sch` | no | Schematic `workspace`, `paper` (must stay light) and `grid` |
| `syntax` | no | Scripting-console colours: keyword, string, number, comment, function, type, variable, operator, constant, punctuation. Applied as `--syn-<name>` |
| `iconTint` | no | Sets `--icon-ink` |
| `id`, `author`, `description` | no | Metadata |

**Fallbacks.** Whatever a theme leaves out is derived. `palette` (or the type's defaults) gives every
surface, line, ink, status and shadow token (`AtriumThemes.derive`). Explicit `colors` override the
derived ones. Then every text pair is checked: a derived colour that falls short is nudged until it
passes, and derived surfaces move away from the ink when a mid-grey base would leave no legible ink.
A colour the theme sets itself is never changed. It is reported instead: the editor lists it, and
importing it shows the count. Canvas colours default to Altium's; the workspace grids follow the
workspace, and the sheet grid follows the paper.

**Schematic inks** (navy wires, maroon parts, green selection) are the design's own Altium colours
and are not themed. That is why the sheet must stay light.

## Untrusted input

Theme files come from anywhere, so `AtriumThemes.validate` treats them as data:

- Only the keys above are read. An unknown key is an error, and every problem is listed.
- Every colour must be a hex literal. Named colours, `rgb()`, `var()`, `url()` and anything with
  `;`, `{` or `}` are rejected. Values are lowercased.
- Names lose control characters. Layer names come from a fixed set.
- Colours are applied with `style.setProperty("--token", "#hex")` on `<html>`. No CSS text, selector
  or stylesheet is ever built from a file.
- The pre-paint cache (`atrium.theme.cache` in localStorage) is filtered again when it is read:
  known token names and hex values only.
- Imports are capped at 512 KB, user themes at 50 and extension themes at 20 per extension.

## Following the OS

Preferences › Appearance › **Follow the operating system's light/dark setting**, with a
**Preferred light theme** and a **Preferred dark theme** (any theme of that kind, including yours
and extensions'), works like VS Code's `window.autoDetectColorScheme`. While it is on, picking a
theme of the current kind in the quick pick makes it that kind's preferred theme. Picking a theme
of the other kind turns following off, so the choice shows.

## Extension themes

Themes are data, so no code runs and no permission is needed. List them under
`contributes.themes` in `waffle-extension.json`:

```json
"contributes": {
  "themes": [
    {"id": "harbour", "label": "Harbour", "uiTheme": "vs-dark", "path": "themes/harbour.json"},
    {"id": "dawn", "label": "Dawn", "uiTheme": "vs", "path": "themes/dawn-color-theme.json"}
  ]
}
```

Each `path` names a JSON file in the package of 512 KB or less. It can be a Waffle theme document,
or a VS Code colour theme, which is converted by `vscode-theme.js`. The files are read from the
trusted package, parsed as JSON (comments are allowed in VS Code files) and validated like any
import. They appear as `ext:<extension id>/<id>` under **From extensions** in the gallery and the
picker. Disabling or uninstalling the extension removes its themes, and a theme in use falls back
to Dark.

## VS Code themes

Preferences › Appearance › Import VS Code theme… (or Import theme… in the gallery and editor) reads a VS Code
theme's workbench colours, maps them onto Waffle's tokens and derives the rest. `AtriumVSCode.convert`
checks contrast. Syntax colours become the scripting-console syntax. Optionally they can also become
copper layer colours. The result is saved as one of your themes (`AtriumVSCode.toDocument`,
`importAsTheme`).

## No flash on start

`theme.js` is eager and small (42 KB, down from 51 KB; the dialogs moved to lazy modules). It sets
`data-theme` (the CSS base block) and, for a library, extension or user theme, writes the cached
token values inline on `<html>` before the first paint. The cache holds only the themes the
settings name: the current theme and the preferred light and dark themes. When a theme is not
cached (the first start after an update), the CSS base paints first and the library loads and
applies the theme.

## Modules and API

| File | Loaded | Role |
|---|---|---|
| `app/theme.js` | eager | Settings, CSS presets, accent derivation, the pre-paint cache, `register(id, entry)`, `useResolver`, menus |
| `app/theme-library.js` | lazy (`AtriumThemes`) | Schema, `validate`, `derive`, `resolve`, built-in themes, registry, user and extension themes, `importText`, `exportJSON`, `select`, `preview`, `layerReport` |
| `app/theme-picker.js` + `theme-ui.css` | lazy (`theme-picker`) | Quick pick, Appearance gallery with thumbnails, standalone Appearance dialog |
| `app/theme-editor.js` | lazy (`theme-editor`) | Theme editor |
| `app/pcb-appearance.js` | eager | Theme layer colours (between Altium's defaults and View Configuration overrides), `withPalette` for thumbnails |

Precedence on the board, lowest first: Altium defaults, then the theme's system and layer colours,
then your View Configuration (L) overrides.

## Tests

- `python3 tests/maintenance/css-tokens.py -v`: text contrast for every built-in theme, resolved by the app's
  own code in JavaScriptCore or Node. It also checks copper ΔE, deuteranopia ΔE and contrast on
  the board, computed independently in Python.
- `scripts/test-jsc.sh theme theme-library vscode-theme`: schema, validation (including injection
  attempts), derivation, the cache, following the OS, user, extension and VS Code themes.
