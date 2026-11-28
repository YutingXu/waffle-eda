# Design system

Waffle's UI is styled with a small set of tokens, kept close to VS Code's. Colours change
with the theme; the scales below stay the same in every theme. If you write new CSS, use
these tokens. `tests/maintenance/css-tokens.py` checks authored stylesheets and static inline styles in editor sources.

**Components.** The [UI library](ui-library.md) documents every control and pattern built from these tokens. It covers when to use each one, its markup or builder, its states and a composition guide. Its [living gallery](ui-library.md#using-the-library) renders each one. Build UI from the library, and do not add your own controls (`tests/maintenance/ui-library-lint.py`).

- **Colour tokens.** `app/theme.js` (`AtriumTheme.PRESETS`) is the source of truth. Dark
  is the `:root` block in `app/style.css`; Light, High Contrast and Classic are the blocks
  in `app/editor/theme.css`. `tests/editor/theme.cjs` checks that the three files agree.
  `app/vscode-theme.js` maps VS Code workbench colours onto the same tokens (its `MAP`,
  `derived()` and `TEXT` tables). The other built-in themes (Ember, Fjord, Obsidian,
  Clearview, Soldermask, Haze, Vellum, High Contrast Light), user themes and extension
  themes are `atrium-theme` documents in `app/theme-library.js`. They are applied as inline
  custom properties over the nearest CSS block; see `docs/themes.md`. A new token must
  also get a rule in `AtriumThemes.derive()`.
- **Scales and aliases.** Spacing, type, radii, elevation, layers, control heights and
  focus live in the same `:root` block in `style.css`. They are not theme dependent.
- **Audit.** `python3 scripts/css-audit.py [app] [--json]` inventories literal colours,
  font sizes, line heights, paddings, margins, radii, control heights, shadows, z-indexes,
  duplicate selectors and `!important` declarations.

## Tokens

### Semantic colours

Each semantic colour has a Dark, Light, High Contrast and Classic value, and a derived or
explicit value in every library theme. Text colours reach WCAG AA (4.5:1) on `--panel`,
`--chrome`, `--field` and `--menu-bg`. `tests/maintenance/css-tokens.py` checks every pair, in every
built-in theme.

| Role | Token | Notes |
|---|---|---|
| Surface | `--surface` (= `--panel`) | panels, dialogs |
| Raised | `--raised`, `--hover`, `--pressed` | hover and active fills |
| Overlay | `--overlay` (= `--menu-bg`) | menus, popovers |
| Chrome | `--chrome`, `--app`, `--panel-head`, `--tab-bg` | title bar, docks, tab strips |
| Canvas-adjacent | `--canvas-bg`, `--bar-bg`, `--bar-line`, `--ls-bg`, `--ls-ink` | Active Bar, layer strip |
| Text | `--text` (= `--ink`), `--muted`, `--faint` | Dark `--muted` is now #b0b0b0 (UX review 2) |
| Accent | `--accent`, `--accent-hover`, `--on-accent` | derived from the user's accent |
| Primary action | `--primary`, `--on-primary`, `--primary-line` | default dialog button |
| Success | `--success` (= `--ok-ink`) | |
| Warning | `--warning` | new in Dark; Light and Classic darkened to reach AA |
| Error | `--error` (= `--danger`) | new in Dark (#f0706a, 4.5:1 on panel) |
| Info | `--info` | **new** |
| Destructive fill | `--danger-fill` + `--on-danger` | **new**; solid red buttons and counts |
| Selection | `--selection`, `--selection-ink`, `--sel-bar` | list selection plus an accent bar |
| Tints | `--tint-danger`, `--tint-warning`, `--tint-success`, `--tint-info`, `--tint-accent` | 16–18 % `color-mix` fills behind status text |
| Focus | `--focus`, `--focus-w`, `--focus-ring` | 2 px ring, inset where space is tight. The design canvas never gets a ring: Tab focus shows a 2 px rule along the pane's top edge. Rings show only after keyboard navigation (`html[data-focus-nav=keys]`, set by `shell.js`), not after a click or a shortcut that moves focus; see [Native behaviour](#native-behaviour) |

### Scales

| Scale | Tokens |
|---|---|
| Spacing | `--s-2` `--s-4` `--s-6` `--s-8` `--s-12` `--s-16` `--s-24` (px). Module CSS may write the px value directly, but only values on this scale. |
| Type | `--fs-10` (badges only), `--fs-11`, `--fs-12` (body), `--fs-13`, `--fs-14` (dialog titles), `--fs-16`, `--fs-20`. Each follows the UI font-size setting (`--fs-scale`). |
| Weight | `--fw-regular` 400, `--fw-medium` 500, `--fw-semibold` 600 |
| Line height | `--lh-tight` 1.2, `--lh` 1.35 (body), `--lh-loose` 1.5 (prose, empty states) |
| Radius | `--chrome-control-radius` 6 px (buttons, fields, selects, chips), `--r-sm` 2 px (rows inside menus and lists), `--r-md` 4 px (cards, segments, checkboxes), `--r-lg` 6 px (dialogs, popovers, menus and dropdown lists), `--r-pill` |
| Elevation | `--elev-1` (tooltips), `--elev-2` (menus, popovers, floating panels), `--elev-3` (dialogs) |
| Layers | `--z-sticky` 1 (table heads), `--z-float` 30, `--z-toast` 35, `--z-popover` 40, `--z-alert` 60, `--z-top` 1000. Small local values (1–9) stay literal inside a stacking context. See [Layers](#layers). |
| Controls | `--ctl-h-sm` (20 px), `--ctl-h` (24 px), and `--ctl-h-lg` (28 px) each include `--d-row` for density and font scaling. `--ctl-px` is 8 px of horizontal padding. Touch input uses a 44 px minimum where these controls serve as individual targets. |

### Layers

The page is a stack of layers. The workbench is one layer (it isolates everything inside it). Above it,
in this order, sit the app bar (5, lifted to `--z-popover` while one of its menus is open), floating
panels, modeless windows and context menus (`--z-float`), toasts (`--z-toast`), popovers
(`--z-popover`), alerts such as Preferences and the recovery warning (`--z-alert`), and app-wide
feedback that must never be covered: tooltips, the panel drag preview, the keyboard-scheme switcher
and the Windows caption controls (`--z-top`). Modal dialogs and open popovers use the browser's top
layer.

A decoration that belongs to one element (a scroll thumb, the net-name completion over a field, the
pin-swap hint, the timing readout, the connection flash and the note editor over a canvas) joins its
owner's layer through `ui/owner-layer.js` (`AtriumLayer.attach`, `at`, `clip`). It is never
appended to the body at a high z-index: whatever is drawn over its owner then covers it too, and it is
cut to the part of its owner that can be seen. Its own z-index only orders it among its owner's
neighbours.

Numbers above 9 are not layers. `tests/maintenance/layer_lint.py` (run by `css-tokens.py`) rejects
them, keeps `--z-top` and `--z-alert` to the surfaces named above, and requires every resize handle to
be one of the shared handles in `ui/components.css` (they all light in `--focus` on hover, drag and
keyboard focus).

## Shared patterns

The [UI library](ui-library.md) is the full component reference. The notes below record the older shared patterns that it builds on.

- **Dialogs and sheets.** Use `AtriumShell.dialog({title, body, actions, sheet})` for a
  new prompt or `AtriumShell.adoptDialog(dialog, {title, body, actions, initialFocus})`
  to add the shell to existing markup. Use `modeless: true` with `show()` for a modeless dialog inside the window safe area. `body` contains DOM elements and `actions` in
  the builder is a list of action descriptors. For an existing dialog, pass the action
  row element to adoption and keep the feature’s existing `showModal()` or `show()`.
  For a custom modal built once per opening, `AtriumShell.openDialog(dialog, options)`
  adopts and shows it, removes the closed element, and calls an optional `onClose`
  cleanup. Its shell options match `adoptDialog`. Keep reusable and modeless surfaces
  on their existing lifecycle.
  The shell uses `--surface`, `--r-lg`, `--elev-3`, 16/24 px padding and a semibold
  `--fs-14` title. Titles, body sections and action rows carry `.ui-dialog-title`,
  `.ui-dialog-body` and `.ui-dialog-actions`. Add `.ui-sticky-actions` to keep a
  standard-padded dialog’s action row visible while its content scrolls. [Dialog inventory](dialog-inventory.md)
- **Dialog actions.** In-app action rows place the primary action first on Windows and
  last on macOS and Linux. The DOM order also sets the keyboard order. Pass
  `order:"provided"` for an action row with a meaningful fixed sequence. Operating
  system file pickers and native sheets use the host’s controls and order. Builder
  actions can set `variant`, `size`, `default` and `focus`. To set an explicit Enter
  action on existing markup use `data-ui-default` on the button. Give destructive
  choices a separate safe initial focus and set `data-ui-default="false"` when needed.
  Native form submission, Escape and modal focus containment remain available.
- **Buttons and fields.** Use `AtriumUI.button(node, variant, size)` for an ordinary
  action. Properties sections can use `host.ui.button(text, action)`. Both use the
  Button rules in `app/ui/controls.css`. Feature styles handle placement and grouping.
  Static markup uses `.ui-button` with `data-variant="primary"`, `"secondary"`,
  `"quiet"` or `"danger"`. Secondary is the default. Set `data-size="sm"`, `"md"`
  or `"lg"` on buttons. Use `.ui-field` on form controls
  outside an adopted dialog. Text inputs, selects and comboboxes share the same
  28 px height, 8 px leading text inset, system font and focus ring. A select
  reserves 28 px for its trailing chevron, with 12 px of space between the arrow
  and the inside of the field border. The arrow mirrors in right-to-left layouts.
  Properties dropdowns use the panel’s shared field row. Native numeric inputs and
  `.ui-field-number` use the 80 px number width. Put the unit in a
  `.ui-field-unit` next to the input inside a `.ui-field-measure` row. The
  visible field keeps the same height on touch screens. Use a native label to
  make the surrounding row tappable. The command palette's main search bar
  carries its own larger, borderless treatment. A `.ui-checkbox` remains a native
  checkbox, with the optional `.ui-checkbox-row` on its wrapping label.
- **Field text alignment.** A same-row caption, displayed value and inline unit
  share a typographic baseline within 0.5 CSS px. Associate the caption through
  a native label, `aria-labelledby` or the shared field row. Use the shared
  typography for both sides. Align a side-by-side multiline caption with the
  first editable line. A stacked caption precedes its control on a separate row.
  The Chromium check reads rendered text runs, including native select and
  input text, and records blank values, hidden or accessibility-only captions,
  and controls whose value is a swatch or toggle. Operating-system pickers use
  native layout. Register a new dock panel or dialog in the existing surface
  conventions so the live coverage gate can require an opened fixture.
  Run `node tests/editor/browser-dialog-geometry.cjs` for dialogs and Preferences, and
  `node tests/integration-browser.cjs` for dock and editor surfaces.
- **Shortcuts.** Pass the binding from the keyboard map to
  `AtriumShortcut.render(binding, {variant:"inline"})` for a plain hint or use
  `variant:"keycap"` for individual keys with a 20 px minimum size and 4 px
  spacing within a chord. Both forms use 8 px between sequence steps and the
  same 11 px system font and spoken labels. The macOS host supplies AppKit
  glyphs. The style check catches raw keycap markup and shortcut literals at
  direct DOM and CSS render sites.
- **Tables and grids.** Sticky `thead th` uses `--fs-11`, `--fw-medium`, `--muted`
  on `--panel-head`, with `z-index:var(--z-sticky)`. Selected rows use
  `--selection`/`--selection-ink`.
- **Tabs and segments.** Add `.ui-tabs` to the tablist and `.ui-tab` to each tab.
  Set `aria-selected` and the roving `tabindex` when rendering buttons. The kit
  draws one 2 px indicator at the block end. A `.ui-tab-wrap` extends the indicator
  under a close button. Use `.ui-segmented` with `.ui-segment` labels around native radio inputs
  or buttons that expose their pressed or checked states. The shared keyboard handler
  supports arrows, Home and End for tabs and button-based radio groups.
- **Chips, pills and badges.** Chips are `.ui-chip`: 22 px, the control radius, a hairline when off and a raised
  neutral fill when on. Badges are `.ui-badge`: `--r-pill`, `--fs-11`, `--s-6` inline padding, status ink on its
  tint (`--success` on `--tint-success`, and so on). See the [UI library](ui-library.md#chip).
- **Close buttons.** `.ui-close` in `ui/components.css` draws the `--icon-close` mask at 16 px. Fifteen feature
  close buttons (BOM, Constraints, Find and Replace, Library, Nets, Messages, PCB List, Navigator, Filter,
  Scripting, View Configuration, Selection Memory, Minimap, Variants, Clipboard and History) carry it beside
  their own class, which keeps only placement. Small remove buttons inside chips and rows (`.km-chip-x`,
  `.sch-entry-remove`, `.ui-chip-remove`) use the same icon at 12 px. The button is an inline flex box: in a
  grid, the hidden "×" text becomes a second row and pushes the icon off centre.
- **Empty states.** `.ui-empty` (UI library), or a module `*-empty` class listed in `polish.css`:
  `--muted`, `--fs-12`, `--lh-loose`.

## Icons

There is one style. Icons sit on a 24-unit grid and render at 16 px (14 px in dense
rows). They use a 1.6 stroke, round caps and joins, no fill and `currentColor` (the
`.icon` class in `style.css`, with symbols in the `index.html` icon bank).

The icon inventory found these styles in use:

| Source | Count | Style |
|---|---|---|
| `index.html` icon bank (`<symbol id="i-*">`) | 31 | The reference style |
| Inline SVG in JS | 6 modules | `fab-outputs`, `print`, `pour-manager`, `viastack`, `view-config` and `theme`. Mostly previews and diagrams, not icons. The `view-config` eye icons now use the `.icon` style (24-unit grid, 1.6 stroke). |
| Unicode glyphs | — | `×` as a close button in 17 modules (the worst offender: its size and weight followed each module's font), `▸▾▲▼` for disclosure and sort, `✓✕⚠★` for status, `→` in text |
| Emoji | 0 | The `🔒` on locked room tabs (`rooms.js`) is now a small vector padlock |

Changes made:

- **Converted.** The dialog and panel close glyphs now use the close icon through CSS.
  No JS change was needed; the "×" text remains for assistive technology.
- **Converted later (ux-polish).** The `view-config` eye icons, the locked-room padlock and
  the chip/row remove buttons.
- **Left as they are.** Arrows and maths symbols are text, not icons. Sort and
  disclosure triangles render in the UI font.

No icon font or third-party icon set is used.

## Audit: before and after

`scripts/css-audit.py`, before and after this pass. Other agents edited CSS during the
pass: there were 49 files before and 51 after.

| Measure | Before | After |
|---|---|---|
| Literal colours (bare) | 44 (26 distinct) | 27 (18 distinct), all allowlisted canvas, plot and print palettes |
| `var(--x, #fallback)` colour fallbacks | 84 | 0 |
| Private module colour palettes | 5 (erc, extensions, variants, polish, view-config fallbacks) | erc scoped Dark defaults and extension plot series only |
| Distinct font sizes | 25 (11 px written five ways; several unscaled px) | 5 literal (em-relative), plus 7 scale tokens (507 uses) |
| Distinct spacing px values (padding, margin, gap) | 26 | 20. The rest are structural indents of 17 px or more, or values inside calc() |
| Distinct radii | 17 | 3 literal (0, 50 %, one corner mix) plus 4 tokens |
| Control heights | 30 distinct | 49 rules on `--ctl-h*`; the rest are bar-relative or structural |
| Outer shadows | 9 hand-written, 3 of them invalid (`box-shadow:var(--shadow-lg)` is a colour) | `--elev-1/2/3` |
| Global z-indexes | 7 magic numbers (30–1000) | `--z-*` layers |
| Duplicate selectors in one file | 11 (grew to 29 as fix passes appended overrides) | 3, all intentional: the `style.css` motion `:root` block (see Motion) and `.active-bar` animation, and the `extensions.css` plot palette `:root` (ux-polish merged the rest) |

### Style lint

Use token references for colours, corner radii and shadows. The check covers CSS
files throughout the repository, embedded stylesheets and style attributes, and
static styles set by the editor's JavaScript. It checks literal fallbacks and
values within gradients, including colours in outlines. A zero radius or a
`none` shadow is a valid reset. Shape geometry, such as a board item's radius
or the `rx` attribute on an SVG rectangle, uses its model's dimensions.

Custom properties in the theme's token definition blocks can hold literals.
The existing scoped Messages/ERC and extension plot palettes define their own
set of named tokens. Other legacy styles, including paper and export palettes
and stack-up materials, are listed by file, rule, property and value in
[css-style-legacy.json](../tests/maintenance/css-style-legacy.json). Each entry allows one
existing declaration. Remove the entry when you replace its declaration with
tokens.

## Motion

Use [Motion rules](motion.md) to decide whether to animate. The
[Waffle surfaces table](motion.md#waffle-surfaces) specifies behavior for each surface, and
[The canvas](motion.md#the-canvas) covers camera and gesture behavior.

### Tokens

Shared timings are defined in the motion `:root` block in `app/style.css`.

| Token | Value |
|---|---|
| `--motion-none` | 0 ms |
| `--motion-instant` | 80 ms |
| `--motion-fast` | 140 ms |
| `--motion-base` | 200 ms |
| `--motion-ambient` | 240 ms |
| `--motion-slow` | 320 ms, reserved for large camera moves |
| `--motion-dialog-in`, `--motion-dialog-out` | 200 ms, 150 ms |
| `--motion-menu-in`, `--motion-menu-out` | 120 ms, 80 ms |

The [easing rules](motion.md#5-easing-duration-and-springs) list the approved curves and their uses.
`--motion` and `--ease` are aliases of `--motion-fast` and `--ease-decelerate`.
`--motion-move` is normally 1 and drops to 0 in Reduced and Off.

Loading indicators are the one looping exception to the 300 ms limit (approved 2026-11-23): the
library spinner turns and the indeterminate bar sweeps until the wait ends. Reduced holds them still,
Off stops them, and `tests/editor/motion.cjs` rejects a loop anywhere else.

`AtriumMotion` in `app/motion.js` mirrors the core timing and easing tokens.
`duration(name)` and `cssEase(name)` return the matching time and CSS curve. Canvas effects share
one animation frame loop through `animate({duration, ease, step, done})`, which returns a cancellable
handle. `tests/editor/motion.cjs` checks the shared values, CSS rules, motion levels, and canvas effects.

### Levels

Preferences › Appearance › Animations sets `data-motion` on `<html>`.

| Setting | `data-motion` | Effect |
|---|---|---|
| System (default) | absent | Uses Full or Reduced according to the operating system preference. |
| Full | `full` | Enables movement when the operating system allows it and follows Reduced when the system requests it. |
| Reduced | `reduce` | Keeps opacity and colour changes and suppresses spatial motion. |
| Off | `off` | Applies the final state immediately. |

## Touch

One scheme on every design canvas (schematic, PCB, footprint and symbol editors, drawings and
panels), recognised once in `app/canvas-input.js`. What a gesture does depends only on the gesture
and on whether the touched object is already selected, never on how dense the design is or how
large a hit target is. Text fields, panels and lists keep native scrolling; the 3D view navigates
with the same gestures (one finger orbits or pans, as its View options say).

| Gesture | Result |
|---|---|
| Tap | Selects what is under the finger; on empty space, clears the selection. Tap a selected object again to select the next object under the finger (Altium's repeated click); the status line counts them. |
| One-finger drag starting on anything not selected | Pans, also over parts, wires and pads. |
| One-finger drag starting on the selection (or one of its grips) | Moves the selection, with drag snapping and live re-routing. |
| Long press (450 ms, still), then drag | Picks up: on an object, selects and moves it in one gesture; on empty space, draws a selection box. A lift cue (a short scale pulse and shadow round the object, or the marquee corner) marks the moment; Reduced motion keeps the cue without the pulse. |
| Long press, release without moving | The context menu at the finger, the same menu as a right-click. |
| Two fingers | Pinch-zoom and pan together; never select or move. |
| Two-finger tap | Undo; the status line says `Undo: <step>`. |
| Three-finger tap | Redo; the status line says `Redo: <step>`. A three-finger swipe left or right also undoes or redoes. |
| Active tool (wire, track, place…) | One finger draws or places, a tap is a click, and two fingers still navigate. One finger pans only with the Select tool. |
| Stylus | A mouse: a drag on an object moves it, and a drag on empty space draws a selection box. No long press. |

Thresholds live together in `TOUCH` and the gesture commands in `GESTURES`, both in
`canvas-input.js`: 8 px of slop before a contact counts as a drag (a long press cancels past it),
450 ms for the long press, and 250 ms from the first finger down to the last finger up for a
two- or three-finger tap, which must also stay within the slop. Remap a gesture in `GESTURES`.

Touch never shows hover-only UI: no hover cards, no owner outline round a part's text, and no
sticky `:hover` on canvas chrome. A touch press sets `html[data-pointer=touch]` until a mouse or
pen moves again (`shell.js`); canvas chrome writes its hover fills under
`:where(:root:not([data-pointer=touch]))`. `tests/editor/browser-touch-scheme.js` checks every row on a
dense board.

## Native behaviour

Waffle must behave like a native desktop app and never reveal that its interface is a web page.
Each browser behaviour has one app-wide policy, set in the base CSS (`app/style.css`, plus the
focus rule in `app/polish.css`), in `app/shell.js`, or in the native host. Do not patch a single
component; extend the policy or add an exception here. `tests/editor/browser-no-quirks.js` checks every row.

| Behaviour | Policy | Where |
|---|---|---|
| Focus rings | Rings show only while the user navigates by keyboard, as on macOS with keyboard navigation on. Tab, and arrow, Home, End, Page, Enter or Space keys on a control, set `html[data-focus-nav=keys]`. A shortcut (any key with Command, Control or Alt, or a letter, digit or function key outside a field) or a pointer press clears it; typing in a field and Escape leave it unchanged. So focus that a shortcut, or a dialog opened by one, hands back never rings, while a dialog opened with Enter returns a visible ring. Text fields always show their ring. The design canvas never gets a ring; Tab focus shows a 2 px rule along the pane's top edge. A box-shadow ring must be written under `:root[data-focus-nav=keys]`. | `shell.js`, `polish.css` |
| Text selection | `html` is `user-select:none`. Text fields, `contenteditable`, `pre`, `code`, `samp`, `output`, `[role=log]` and `.ui-selectable` opt back in, as do report articles, the netlist source and Properties values. Give genuinely copyable text (messages, reports, help) `.ui-selectable`; never re-enable selection on chrome. | `style.css` |
| Context menus | The web view's menu never opens: `workbench.js` cancels every `contextmenu` and opens the app's own menus, with Cut/Copy/Paste in fields and selected text. The hosts strip Reload, Back, Inspect and open-in-new-window from any menu that still opens. | `workbench.js`, hosts |
| Drags | Images, SVG, links and canvases have `-webkit-user-drag:none`, and `shell.js` cancels any `dragstart` that is not from a `draggable="true"` source, a field or selected text. Dropped files never navigate (`editor.js` cancels `dragover`/`drop`). | `style.css`, `shell.js` |
| Scrolling | `html` and `body` never scroll or rubber-band (`overflow:hidden`, `overscroll-behavior:none`); `shell.js` resets the root if `focus()` or `scrollIntoView()` scrolls it. Panels scroll on their own and keep native elastic scrolling (`.pane-scroll` is `overscroll-behavior:contain`). | `style.css`, `shell.js` |
| Zoom | The canvas owns zoom. `html` is `touch-action:pan-x pan-y` (no pinch or double-tap page zoom). macOS turns off magnification, smart zoom and back/forward swipes; Windows turns off zoom control, pinch zoom and swipe navigation; Linux resets any page zoom level. ⌘+/⌘−/⌘0 run the canvas zoom commands. | `style.css`, hosts |
| Browser shortcuts | Reload (⌘R, F5), find (⌘F, ⌘G, F3), history (⌘[, ⌘], Backspace and Alt+arrows outside fields), print, save, open, address bar, bookmarks, downloads, view source, caret browsing and page zoom are cancelled when the keymap does not handle them. On macOS the menu bar's own key equivalents are left to `main.swift`. Windows also turns off browser accelerator keys. | `shell.js`, Windows host |
| Cursors | The arrow everywhere, as on macOS: buttons, rows and tabs never use the pointing hand. Only text links (`a[href]`, underlined link buttons) use it. Fields and selectable text show the I-beam; static text never does. Resize, move and crosshair cursors are unchanged. | `style.css` and module CSS |
| Fields | Single-line fields never check spelling, autocorrect or autocapitalise (identifiers, numbers, net names, queries, paths) unless they set `spellcheck="true"`. Multi-line and rich text are prose and keep spelling unless they set `spellcheck="false"` (code, CSV, JSON, pin lists). macOS also turns off smart quotes, smart dashes, text replacement and link detection in every field. Inputs without an `autocomplete` attribute get `autocomplete="off"`, and autofill and password saving are off in the hosts. | `shell.js`, hosts |
| Tooltips | `title` never shows the native tooltip: `ui/tooltip.js` moves it to the app's tooltip, which stays hidden while the control's own label is fully visible. | `ui/tooltip.js` |
| Links | External http(s) links open in the system browser through `AtriumHost.openURL` (macOS, Linux); the window never navigates and no host shows a link status bubble or a force-click link preview. | `shell.js`, `bridge.js`, hosts |
| Touch and paint | No tap highlight, no touch callout outside text, no text-size adjustment. The macOS window paints the theme background until the page's first frame, so there is no white flash. | `style.css`, macOS host |

## Contributing

1. Use `var(--token)` for every colour. If a role has no token, add it to every preset in
   `theme.js`, to `style.css :root` and `theme.css`, and to the mapping in
   `vscode-theme.js`. Then run `python3 tests/maintenance/css-tokens.py` and
   `scripts/test-jsc.sh theme vscode-theme`.
2. Take sizes from the scales above, and durations and curves from the motion tokens. `tests/maintenance/css-tokens.py` warns on raw `font-size:Npx`.
3. Before adding new CSS, use the [UI library](ui-library.md). Feature CSS only places components.
