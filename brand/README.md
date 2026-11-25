# Waffle EDA: brand assets (Stack mark)

This folder holds the Stack mark, the "waffle" wordmark and the full asset set for integration. The public name is **Waffle EDA**.

- `png/overview.png`: the mark, app icon, lockups (primary and "EDA"), small sizes and the first four release flavours.
- `png/contact-sheet.png` is not checked in. Run the build with `--contact` to produce it: 1024, 256, 64, 32 and 16 on light and dark, monochrome, the menu-bar template, the macOS icon, and menu bar + Dock mocks with neutral placeholder icons.

## What changed from the concept

The exploration version was three identical flat rhombi seen dead-on. That is the shape of Buffer's logo and of the generic "layers" UI glyph. The final mark changes almost every property of that silhouette:

| | Concept (risky) | Final |
|---|---|---|
| View | symmetric 2:1 isometric | **turned ~37°, 30° elevation**: wide left face, narrow right face, asymmetric silhouette |
| Slabs | three equal flat chevrons | **three different thicknesses**: thick waffle (92), thin copper foil (30), core (78) |
| Outline | sharp corners | **rounded plan corners** (a real waffle's edge); the side faces turn smoothly round the front corner |
| Waffle reading | flat dark holes | **3 × 3 recessed pockets with visible far walls and floors**, plus a light bevel on the top face's front edge |
| Stackup detail | none | **a plated via** (ring, drill and visible barrel) in the front channel, and **two inner copper layers** drawn on the core's side, so it reads as a multilayer board |
| Depth | none | soft contact shadow from each slab onto the one below |

### Resemblance check (re-done)

- **Buffer** (three stacked isometric layers, symmetric, equal and flat): no longer similar. The asymmetric view, unequal thick slabs, rounded corners, pocket grid and colour all differ, and the silhouette is a single rounded block, not a chevron stack.
- **Generic "layers" glyph:** the large mark doesn't read as that glyph. The 16 pt menu-bar template is the closest, since at that size it is two slabs. Its top still carries a 2 × 2 pocket grid, and it is off-axis and rounded, unlike the symmetric chevrons of the stock icon. I consider the risk low.
- **Stacked-sandwich and food icons:** the top slab has a gridded waffle top but no drips, butter or face. A green layer under copper could read as "lettuce" to a non-engineer. The inner copper lines and the PCB-green tone push it towards a board, and that reading is mild at app-icon size.
- **Waffle House, Altium, KiCad, Autodesk:** no shared shapes or colour schemes.
- **Wordmark:** a plain geometric lowercase (and, for the "EDA" lockup, small capitals E, D and A of the same construction), drawn here from lines and arcs, not traced from any typeface. Geometric sans "waffle" settings will always look somewhat alike, but nothing here is copied.
- A formal trademark search (classes 9 and 42) is still recommended before public launch.

## Palette

| Role | Colour | Source |
|---|---|---|
| Waffle top | `#FFD781` to `#F3A93A` | close to the dark-theme `--accent #f0a32e` |
| Pockets (default) | floor `#8A4208` to `#A65300`; walls `#4E2302` to `#7A3C05` | the light-theme `--accent #a65300` |
| Copper foil | `#F7B27E` / `#DC7A3E`; sides `#C9652C` / `#8C4217` | |
| Core | `#4BA864` / `#2E8540`; sides `#2A7A3B` / `#184D24` | `--icon-pcb #2e8540` |
| Inner copper layers | `#E98A4E` | |
| Via | cream ring `#FFFFFF` to `#E7B77F`; copper barrel `#C8763C` | |
| macOS plate | cocoa `#43362C` to `#1A1410` (default); cream `#FFFBF3` to `#EADBC2` (alternative) | |
| Wordmark ink | `#2A1D07` on light, `#FFF3DC` on dark | |

## Wordmark and lockups

- **Primary:** the lowercase "waffle" wordmark, alone or locked up with the mark (`waffle-lockup-on-light.svg`, `waffle-lockup-on-dark.svg`). Use it wherever the product is already in context: the app's About box, splash, docs header and favicon pages.
- **Secondary, "Waffle EDA":** the same lockup followed by a small "EDA" (`waffle-lockup-eda-*.svg`, `waffle-wordmark-eda*.svg`). Use it where the name has to stand on its own: store listings, the website hero, press and social cards.
  - The capitals share the wordmark's construction (straight lines, a circular bowl, a mitred apex cut flat) at a lighter stroke: 13 units against 22.
  - Optical alignment: cap height equals the lowercase x-height, so the flat tops of E and D sit on the x-height line and every letter stands on the baseline. The A's apex overshoots by 3 units, like the round lowercase letters, so it doesn't look short.
  - The capitals are tracked wider (18–20 units between letters) and set one word space (52 units) after the "e".
  - They take the same ink as the wordmark. Don't recolour "EDA" or set it in another typeface.

## Release flavours

Names come from `docs/releases.md`. They are labelled by build order, not version number: Apricot, Butter, Cinnamon, Dark Chocolate, Espresso, Fig, Ginger, Hazelnut. A flavour **glazes the pocket floors and walls and tints the via ring**. Nothing else changes, so every release is recognisably the same icon and the colour shows at Dock size.

| Order | Flavour | Pool (far / near) | Walls | Via ring |
|---|---|---|---|---|
| 1 | Apricot | `#E2632A` / `#FFB27E` | `#93300D` / `#C04A18` | `#FFEBDD` to `#F39058` |
| 2 | Butter | `#E9B93A` / `#FFE9A0` | `#A8770E` / `#CF9E2C` | `#FFFCEB` to `#F2D27A` |
| 3 | Cinnamon | `#8E3416` / `#C8643A` | `#4E1806` / `#74290E` | `#FFE6D6` to `#C0582C` |
| 4 | Dark Chocolate | `#24120A` / `#5A3424` | `#120803` / `#24120A` | `#EADBD0` to `#6B4030` |

Apricot is a peach-orange glaze. It is lighter and pinker than the copper foil (`#DC7A3E`), redder than the gold top and Butter, and much lighter than Cinnamon. "Apple" is not used, following the trademark check.

Each flavour pool also gets a small glossy glint, to say "glaze" rather than "hole".

The 16/32 icon slots and the menu-bar template stay unflavoured: the tint is invisible there, and template icons are monochrome by definition.

Later flavours (Espresso, Fig, Ginger, Hazelnut and so on) need only a new pool, wall and via entry in `tools/build.js`.

## Files

```
svg/
  waffle-mark.svg               colour master (1024 viewport, no transforms, no fonts, no raster)
  waffle-mark-mono.svg          single colour, uses currentColor
  waffle-mark-small.svg         two-slab variant for 16-32 px (also favicon.svg)
  waffle-mark-small-mono.svg
  waffle-menubar-template.svg   16 pt template: black + alpha, bigger holes and gaps
  waffle-macos.svg              macOS icon, cocoa plate (824 pt plate on the 1024 grid)
  waffle-macos-cream.svg        same, cream plate (alternative)
  waffle-macos-16-32.svg        simplified art for the 16 and 32 px icon slots
  waffle-macos-<flavour>.svg    apricot, butter, cinnamon, dark-chocolate
  waffle-mark-<flavour>.svg
  waffle-wordmark.svg, waffle-wordmark-on-dark.svg
  waffle-lockup-on-light.svg, waffle-lockup-on-dark.svg            primary lockup
  waffle-wordmark-eda.svg, waffle-wordmark-eda-on-dark.svg          "waffle EDA" wordmark
  waffle-lockup-eda-on-light.svg, waffle-lockup-eda-on-dark.svg      secondary "Waffle EDA" lockup
macos/
  Waffle.icns                   built with iconutil from a temporary 10-PNG .iconset (16-32 px slots use the small art);
                                pass --keep-iconset to also write macos/Waffle.iconset/
  Waffle-<flavour>.icns         apricot, butter, cinnamon, dark-chocolate
  WaffleTemplate.png, WaffleTemplate@2x.png, WaffleTemplate.svg   NSStatusItem image; the "Template" suffix lets AppKit tint it
windows/
  waffle.ico                    PNG entries: 16, 24, 32, 48, 64, 256
linux/hicolor/
  {16,22,24,32,48,64,128,256,512}x…/apps/waffle.png
  scalable/apps/waffle.svg
  symbolic/apps/waffle-symbolic.svg
web/
  favicon.svg, favicon.png (32), favicon-16.png, favicon.ico, icon-192.png, icon-512.png
png/
  overview.png                  (contact-sheet.png with --contact)
tools/
  stack.js       geometry: an affine projection of cubic-Bezier rounded squares, so the output has no transforms
  icon.js        plate and shadow
  wordmark.js    the "waffle" letters and the "EDA" small capitals
  base.js        number formatting, the continuous-corner plate, SVG and gradient helpers
  build.js       writes everything above
  sheet.css
```

Notes for integration:

- **macOS app icon:** the default is the cocoa plate. Gold reads strongly against it in both Dock themes. The cream plate is a drop-in alternative.
- **Windows and Linux icons:** these use the bare mark with transparency, no plate, which is what Windows 11 and GNOME/KDE expect. Sizes of 32 px and below use the two-slab small variant; larger sizes use the full mark.
- **App surfaces:** the brand build copies the favicons and both About lockups into `app/brand/` so the restricted desktop webview can read them. It also renders the three sizes required by the Windows MSIX manifest.
- **Icon Composer:** if Waffle later adopts the macOS 26 layered "glass" icons, the art splits naturally into these layers: plate, core, copper, waffle, and pockets plus via.

## Rebuilding

```sh
cd brand
NODE_PATH=<dir containing playwright> node tools/build.js                 # all assets + png/overview.png
NODE_PATH=<dir containing playwright> node tools/build.js --contact       # also png/contact-sheet.png
```

The build:

- is self-contained in `tools/`. It needs only Node, Playwright and macOS `iconutil`;
- is deterministic: unchanged sources reproduce byte-identical SVG, PNG, `.icns` and `.ico` files;
- renders with Playwright using `chromium.launch({ channel: 'chrome' })`, since Playwright's bundled Chromium is not downloaded on this Mac (set `PW_CHANNEL` to change it);
- calls `/usr/bin/iconutil` for the `.icns`;
- renders the sheets at deviceScaleFactor 2 and the platform PNGs at exact pixel size.
