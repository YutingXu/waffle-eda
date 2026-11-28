# GPU board renderer

Status: **the default board renderer where WebGL2 is hardware-accelerated** (Automatic, since 2026-11-19). The
renderer is `app/canvas/canvas-gpu.js`; the choice is Preferences › Display › Renderer (`display.renderer`: Automatic
(GPU when hardware-accelerated) / GPU / 2D), decided by `app/canvas/canvas-gpu-pref.js`. The 2D renderer in `canvas.js`
stays the fallback and draws print, PDF, exports, diff views, previews and thumbnails. Headless and MCP never load
either GPU file: without a page there is no probe, and boards stay 2D.

Automatic uses hardware-backed WebGL2. Preferences can also select either renderer explicitly. The release calibration exercised ten fault injections. The 2026-11-20 Chromium rerun caught all ten. The native live-pour comparison also caught an intentionally unclipped tile. The six-board comparison exercised ranked layer overlaps, retained editing and selection, live repour patches, native high-DPI output and the visibility lifecycle. See the measurements below and §5.


## Retained rendering measurements, 2026-11-20

The Chrome hardware run used ANGLE on Apple M6 Metal at 59.9 Hz. The design contained 25,610 items and 22,917 pour vertices. Scripted camera samples accounted for every displayed frame.

| Gesture | Frames | Missed frames | Main-thread p95 |
| --- | ---: | ---: | ---: |
| Fit pan | 89 | 0 | 0.5 ms |
| Fit wheel reversal | 63 | 0 | 2.7 ms |
| Zoomed pan | 89 | 0 | 0.3 ms |
| Zoomed wheel reversal | 63 | 0 | 3.9 ms |

At fit, exact GPU redraw and readback measured 1.6 ms median and 2.8 ms p95. Zoomed, the figures were 2.0 and 3.4 ms. Via edits used 2.4 ms p95 of main-thread rendering at fit and 1.2 ms zoomed. The following presentation took 33.2 ms p95 at both scales. A zoomed frame skipped 50,901 of 85,308 retained slots. Moving the via uploaded 56 geometry and state bytes, with zero lettering or copper coverage uploads and zero dead slots. Accounted GPU allocations were 16.16 MiB at fit and 15.63 MiB zoomed.

The native Apple GPU repeated the 25,610-item workload with a visible 1663 × 1510 Retina backing store, macOS 27.2.1 and WebKit’s 60 Hz preference disabled. Exact redraw and readback took 6 ms median at both zoom levels, with 7 and 9 ms p95 at fit and zoom. Pan work was 1 ms p95 at both scales and wheel work was 3 and 1 ms p95. Via edit rendering was 5 and 2 ms p95. The following presentation took 37 and 31 ms p95. The zoomed view culled 49,365 of 85,308 slots and a moved via uploaded 56 bytes. GPU allocations were 30.10 MiB at fit and 25.36 MiB zoomed. Single-colour coverage used one byte per device pixel and reduced the fit figure from 44.47 MiB with four-channel coverage. A mixed-colour layer retains four channels. WebKit exposed 1 ms timers and a 4 ms median animation callback interval. At its 6 ms slow-frame threshold, fit and zoomed pan counted 8/89 and 14/89 slow intervals. Wheel reversal counted 6/63 and 1/63. These intervals measure WebKit animation callbacks. Physical display scan-out was outside this test.

In 180 CPU-mode edit/undo/redo cycles, two uninstrumented browser runs grew by 37.1 and 37.9 MB against the 40 MB budget, with 28 MB undo history and byte-identical dirty-region and full-scene route and marquee renders. In a separate native energy check, the board submitted zero GPU calls at rest or occluded. Automatic renderer idle CPU was 0.51% on the dense board and about 1.12% on an anonymized comparison board. The power test was on AC.

With the native macOS header and the full PiDP project open, changing the shortcut preset, toggling the cheat-sheet preference, recording Ctrl+Alt+Shift+J, and opening or closing the Preferences, binding editor and shortcut reference submitted zero board frames, draw calls, buffer uploads and texture uploads. The PiDP project parameters resolved on the board, and the 1663 × 992 board image had the same checksum before and after the UI sequence. Physically uncovering the native window separately produced two frames and 52 draw calls. The screen-space origin cross and ring resubmitted 272 bytes across those frames. The retained scene, copper and textures were reused, and the board then returned to zero draws.


The full numerical comparison passed every original limit on 157 Chromium frames and 193 WKWebView frames. WKWebView used a 1× backing store on the 2× display for the original numerical budgets. A separate native Retina sample passed all 16 comparisons with zero solid or interior mismatches and a maximum mean edge difference of 0.94. An anonymized comparison board passed all 36 frames with zero solid or interior mismatches. That board exercises thermal vias, pad lettering underneath later copper, and overlapping mechanical layers of equal rank.

The PiDP board's high-contrast fit comparison measured 0.90 mean edge difference against a 1.50 limit. When a stored clearance curve has sampled edges shorter than one device pixel, an exact redraw can cache the native vector fill's coverage for that copper layer. It reuses the coverage after ordinary edits. Changes to stored contour bytes upload their old and new rectangle. The GPU's retained stencil geometry supplies live repours and camera frames that can reuse the cached artwork. A camera cache miss takes the exact redraw path, including any required copper masks. Ordinary disjoint pad captions stay in the text bands. A caption underneath later artwork on its own layer follows the original drawing order.

Eleven edit and selection cases, including insertion, deletion, undo, redo, a growing polyline, coalesced edits and selected lettering under translucent copper, matched new GPU scenes byte-for-byte. A separate test moved two stored regions in place, preserving their object identity. It exercised a subpixel clearance texture and an independent GPU stencil fan against the same geometry in a fresh project view. The changed copper layer uploaded 31,857 bytes in Chromium and 36,226 in WKWebView, with zero upload on the next unchanged frame. On a separate physical Retina board with translucent copper, Repour All finished on identical pixels with animations Off and Full on both renderers. Each comparison covered 2,511,130 pixels and the stored copper also matched. After idle processing changes the displayed contour detail, the affected translucent bands refresh. The suite also verifies the normal renderer selection, context restoration, explicit memory fallback, split contexts and live drag tiles.

## Design and original release measurements

- **API: WebGL2** (§1). Submitting a whole board frame takes 0.1–0.3 ms of main-thread time.
- **The GPU draws** the workspace, line grid, board area and edge, origin marker, board-shape edit handles, poured
  copper (live pour tile patches included), tracks, pads and vias (pad stacks, via stacks, blind and buried drill
  colours), custom pads, footprint line art and bodies, filled graphics, connection lines and net colours.
- **Text stays with the 2D engine** (designators, labels, footprint text, keepouts, dimensions): drawn on the view's
  canvas, copied into one texture per gap between GPU passes and composited by the GPU in layer order. The copy is
  cached: pointer, tool, selection frames and every pan or zoom gesture frame reuse it (§2, "Text layer"). Pad numbers, net names and selected part lettering keep their original layer order. Via marks, selection boxes and tools use the top overlay.
- **Pixel test** (§5): GPU against 2D on five boards × three views × thirteen cases (Board Planning and a live pour
  drag included), Chrome and WKWebView. Edge-tolerant comparison with strict interiors, per-object-class masks and
  per-case budgets from the real GPU output; a fault-injection suite of ten deliberate faults (hole colours, a layer
  1 px off, layer order, pad text, net colours, small vias, selection layering, tracks 10 % thin, pour patches,
  Board Planning) must each fail it. The native tile case recorded 37 interior differences and 76 solid differences against limits of 6 each. Robustness checks (lost context, memory cap, parked documents, split
  pane) pass in both.
- **2026-11-19 WKWebView results** (§4): exact frame at fit 44 → 5 ms; pan and wheel zoom 0 ms work and 0 dropped frames;
  repaint after an edit 41 → 6 ms; edit input-to-paint 83 → 48 ms; click select 0–1 ms (2D 1–2). `frame.sh` passes every WebKit budget with the
  GPU on (with 2D, `zoomed.moveDrag` drops 7 of 39 frames and fails).
- **Click-through** passes with Renderer GPU and 2D (pcb, warm and cold, 0 failures, 2026-11-20).

## 1. API choice: WebGL2 vs WebGPU

| Host | WebGL2 | WebGPU | Evidence |
|---|---|---|---|
| macOS WKWebView | yes | **yes** | Verified in the harness on WebKit 22625.2.8.11.9, macOS 27.2.1 (see below). |
| Linux WebKitGTK | yes, on current releases with working GL (ANGLE over EGL) | not shipped by default in the releases we know of; treat it as absent | Not verified here: the Linux runner was not reachable from this session. Check with the probe below. |
| Windows WebView2 | yes (ANGLE on D3D11) | yes (Chromium 113+, D3D12) | Chromium's platform support. WebView2 follows Edge stable. |
| Chrome (dev/tests) | yes | yes | Chrome 158 headless: "ANGLE Metal Renderer: Apple M6". WebGPU adapter "apple / metal-3". |

**WKWebView probe.** The harness ran `navigator.gpu` and `getContext("webgl2")` inside the real `Desktop` class:
- **WebGPU:** `navigator.gpu` is present. `requestAdapter()` returns vendor "apple", and `requestDevice()` succeeds.
  - Features include `timestamp-query`, `shader-f16`, `float32-blendable` and `primitive-index`.
  - `maxBufferSize` is 2 GiB.
  - So WebGPU did ship in Safari 26 / macOS 26-era WebKit, and it is on in WKWebView.
- **WebGL2:** the renderer is "Apple GPU", with 4× MSAA and an 8-bit stencil.

**Why WebGL2.**

1. **It is everywhere we ship.** WebKitGTK is the open question for WebGPU. A renderer that only works on two of
   three platforms would need a second GPU backend or would fall back to 2D on Linux. The Linux runner (an aarch64
   NVIDIA machine) is exactly where a GPU path pays off.
2. **The workload is tiny for a GPU.** It is about 30 draw calls a frame: instanced quads, stencil fans for pours,
   and a full-screen grid. WebGL2 submission measured **0.07–0.3 ms** a frame in both browsers. All other frame
   time is JavaScript: the 2D overlay and the editor. WebGPU's advantages here would not show up in the numbers:
   - render bundles;
   - storage buffers;
   - compute;
   - less driver validation.
3. **Simpler failure handling.** WebGL2 contexts are synchronous to create and can be lost and restored. WebGPU's
   setup is asynchronous, so the first frame would need a 2D fallback anyway, and device loss works differently.
4. **There is precedent.** `view3d.js` already uses WebGL.

**Keep the door open.** The design keeps all geometry in flat typed arrays with fixed strides. A WebGPU backend
would upload the same arrays to storage buffers and draw them with the same shaders, translated to WGSL. Revisit
WebGPU when WebKitGTK ships it, or if GPU compute becomes useful, for example:
- tessellating or clipping pours on the GPU;
- GPU-side DRC heat maps.

**Fallback.** See §6. On Linux, WebKitGTK’s `hardware-acceleration-policy` controls access to hardware acceleration. Automatic uses the 2D renderer when WebGL reports a software driver. [Linux host](../../native/linux/waffle.py)

**Probe for Linux and Windows.** Run this in the app's web inspector console:
`[!!navigator.gpu, (c=>{const g=c.getContext("webgl2");const e=g&&g.getExtension("WEBGL_debug_renderer_info");return g&&g.getParameter(e?e.UNMASKED_RENDERER_WEBGL:g.RENDERER)})(document.createElement("canvas"))]`

## 2. Design

### Canvases

- **The WebGL2 canvas** (`.atrium-gpu-board`) is inserted just before the 2D `<canvas>` in its pane: absolutely
  positioned at the same place and device size, `pointer-events: none`; the 2D canvas gets `position: relative`.
  The context is `alpha: false`, `antialias: true` (4× MSAA), `stencil: true`, and Automatic asks
  `failIfMajorPerformanceCaveat`.
- **Resizing panes.** Reallocating the multisampled backing took 14 ms for a 1758 × 1568 pane in Chrome on Apple
  M5 Pro. A pane that resizes (a dock or split sash, the window, a panel shown or hidden) keeps a backing that holds
  its view and grows one with a quarter to spare each way; the view is drawn in the backing's bottom-left corner,
  placed and clipped (`clip-path`) to lie exactly under the 2D canvas. The frame at rest trims the backing to the
  view. The editor marks a frame whose only change is the pane's size as camera-only, so it is drawn like a zoom
  gesture frame: the retained text bands and world overlay, drawn for the old size, are moved to keep the centre,
  and the exact frame follows once the size rests.
- **Per frame** (`render(I, doc, defs, opts, gesture)`): scene update, the text layer (redrawn only if its key
  changed), GL draw with the text texture composited in layer order, then the top 2D layer.
- **Which frames.** Editor frames only: the active pane's (`reuseBase` in opts) and the other split pane's
  (`editorPane: true`, one flag added in `editor.js renderOther`). Print, PDF, diff, previews and thumbnails stay
  2D.
- **Hook into canvas.js:** `render()` offers the frame to `AtriumCanvasGPU.render(I, doc, defs, opts, g)` before the
  gesture blit (`g`: canvas.js's camera-only flag). `I` exposes `drawBoard`, `paintTop`, `query`, `pourState`,
  `airwireConnectivity` and `padText`. `drawBoard` takes `opts.gpu` (objects the GPU draws are skipped).

### Text layer

canvas.js's `drawBoard` of the objects the 2D engine keeps (parts for their text, labels, keepouts, dimensions) is
drawn on the view's own 2D canvas, copied into a texture (`texSubImage2D` from the canvas) and composited by the GPU
in layer order. A layer painted above everything (the active layer in dim and single-layer modes, or an active
non-copper layer) has its text on the top 2D layer instead, and the text of other layers is in the textures under it.

- **Bands.** canvas.js paints a layer's text in that layer's pass, so the text is split into one texture per gap
  between GPU passes that holds text: each band is drawn by `drawBoard` with every other band's layers hidden, and
  composited just before the first GPU pass whose order is above its layers'. Usually two or three: Mechanical and
  Keepout text under the copper, Bottom-overlay text under the Top overlay's line art, Top-overlay text under
  through-hole copper (connection lines stay above all). The bands needed come from a scan of the text objects'
  layers (`textLayers`); the last band also takes any layer the scan missed. In Board Planning a band above every
  pass carries the tints and the pad text under them.
- **Selection.** A selected part's reference and footprint text use the selection colour in their layer bands.
  The top canvas paints its selection rectangle after the copper. In a stable opaque view, selecting or deselecting
  text updates the texture rectangle covered by the affected objects. The pixel test compares these updates
  byte-for-byte with a fresh GPU render and checks that the scene geometry stays cached.

- **Why the view's canvas.** A detached canvas (element or OffscreenCanvas) rasterizes glyphs with different
  coverage (measured: alpha 228 vs 157 at the same edge pixel in Chrome); the view's canvas gives the 2D path's
  pixels exactly.
- **Cache key:** scene revision, document signature, camera, size, dpr, active layer, layer mode, hidden layers,
  highlight, route-preview hidden ids, system and layer
  colours, opacity, whether the designator and PCB text modules are loaded.
- **Measured.** Text redraw and copy took 0.4–0.6 ms in Chrome and 1.1–1.9 ms in WebKit on the original edit workload.
  Copying accounted for 3 ms of a separate 3.8 ms WebKit text frame at fit.
- **Gesture frames.** The GPU draws retained geometry at the current camera. For zoom it resamples the text bands
  from the current or half-scale raster when one covers the view at adequate resolution. A same-scale pan can
  repair exposed strips. If neither path covers the required artwork, the renderer draws the exact viewport
  synchronously, including its text and any subpixel copper coverage. Cache misses can therefore delay the next input.
- **After a gesture.** At the end of a wheel glide, or after 140 ms of stillness for other gestures, the renderer
  can show a retained frame and sharpen its text in cancellable row slices. A final task prepares copper coverage
  before the exact composite. The half-scale raster becomes eligible after 250 ms at rest. On the original
  four-layer WKWebView workload, slicing reduced the frame that ended a zoom from about 37 ms to 2 ms.
- **Glyph rendering.** Designators and pad captions can use system glyphs, whose coverage depends on the native
  canvas. PCB stroke-font labels and footprint text use vector paths.

### Top 2D layer

Cleared every exact frame, it draws: pad numbers and net names once a pad is over 15 px (`canvas.js padText`,
after the land and stack lookup), via marks (tented, filled, back-drilled, via-in-pad) once the hole is 6 px,
boxes of selected pads and vias, the selected text objects (text in the selection colour and part boxes), the top
layer's text (above) and `paintTop` (router preview, tuning, via
fence, guides, DRC markers and caller overlays, route feel, marquee, measure, paste ghost, snap glyph).

### Static geometry: per-layer instance buffers

Each layer has six buffers: item triangles, segments and blobs, and the same three for parts. Within a pass, part
geometry draws after item geometry, as in `drawBoard`.

- **Segments** (8 floats an instance): `ax, ay, bx, by, width, minimum width in CSS px, kind, butt`.
  - Tracks, graphics, footprint line art, the board edge and connection lines all use this.
  - The vertex shader expands a 4-vertex strip around the segment, plus a margin of 1.5 device pixels.
  - The fragment shader evaluates the distance to the segment (round caps) or to a box (butt caps, for connection
    lines).
  - Round joins come from consecutive capsules, as Canvas's `lineJoin = "round"` does.
  - Minimum widths match canvas.js: `max(1/scale, w)` for tracks, `max(.9/scale, w)` for line art, `1.25/scale`
    for the edge, and 1 or 1.5 px for connection lines.
- **Blobs** (12 floats an instance): pads, vias and footprint circles.
  - The fields are: `x, y, half-w, half-h, angle, shape, shape parameter, kind, drill radius, hole colour, —, npth`.
  - Shapes are signed distances:
    - an ellipse (round, oval, circle and ellipse are all ellipses in `drawPad`);
    - a rectangle;
    - a rounded rectangle (r = 0.18·min);
    - an octagon (chamfer 0.25·min);
    - a ring (a circle stroke).
  - The drill is composited in the shader, in the same order as `drawPad`: land, then the hole in the via-hole or
    pad-hole colour, then the drill edge for a non-plated hole.
- **Triangles** (3 floats a vertex): filled footprint bodies (in the board colour, as `drawShape` does) and filled
  graphics. These are small simple polygons, ear-clipped once.

### Colour, order and opacity are uniforms

- **Colour.** Each frame, a layer pass reads its ink from `PCB.ink(layer, null, opts)`. That covers dim mode, the
  theme, View Configuration and user colours. The pass also reads the selection, hole, pad-hole and drill-edge
  colours.
- **Layer order.** It is `PCB.order` with the flipped-board side swap, the same sort as `drawBoard`.
- **Opacity.**
  - Per layer: `PCB.layerAlpha`.
  - Per object kind (track, via, pad, pour): `PCB.opacity`, applied with a kind code on each instance.
- **Upload.** Changing any of these uploads nothing.

### Camera

The camera uniforms carry the centre, device pixels per millimetre, flip and device size. The same geometry
buffers draw at each camera. Raster layers follow the reuse and exact-redraw rules in [Text layer](#text-layer).

### Pours: stencil-then-cover, no tessellation

A poured region is an even-odd set of rings (outline plus clearance holes); here, 64 regions.

- **Upload, once per region object.** Every ring becomes a triangle fan from its first vertex. This needs no
  triangulation, just an index buffer of `3·(n−2)` per ring.
- **Pass 1 (stencil only).** Draw the fans with `INVERT` on stencil bit 1. A sample inside an odd number of rings
  ends with the bit set: this is the even-odd rule, exactly, per MSAA sample.
- **Pass 2 (cover).** Draw the same triangles where the bit is set, in the pour colour times its opacity, and zero
  the bit. Each sample is painted once, so the 0.55 pour alpha never doubles.
- **Board outline.** It uses the same mechanism. Its stencil bit is left set while the board-grid pass draws, which
  clips the board grid to the board as canvas.js does with `clip(rule)`.
- **Caching.** Buffers are cached in a `WeakMap` keyed by the region object. Live pours replace only the regions
  they repour, so an unchanged region is never uploaded again.
- **Cost.** On this board: 11.0 MB of GPU memory, uploaded in 2.5–4 ms, plus a 5–11 ms one-time shader setup. Fan
  building is a loop over decoded rings. A worker is not needed at this size, but it is the natural next step for
  1M-vertex pours (see §7).

### Grid

The grid is drawn by a fragment shader on a full-screen triangle.

- **Placement.** It reproduces `lineGrid` exactly:
  - lines at `round((origin + k·spacing)·dpr)`, `max(1, floor(dpr))` device pixels wide;
  - every fifth line coarse;
  - coarse painted over fine;
  - spacing doubled until it is at least 12 px.
- **Two passes.** The first draws the workspace colours everywhere. The second draws the board colours under the
  board stencil.
- **Verified.** Outside the board, the diff image is all zero (see §5).

### Incremental updates

The editor and both renderers share the committed undo-store changes. The view reads `recordedChanges()` without forcing an undo snapshot during paint. When a cursor is unavailable, it compares its own item snapshots. Project replacement, changed library geometry or unknown structural edits rebuild the affected view. The `prints` comparison mode remains available for benchmarks.

A retained view coalesces successive changes by item ID and keeps the union of their old and new paint bounds. Moving a track or pad overwrites its original slots. An insertion or expanded line that changes same-layer paint order reorders the affected buffer. The parked scene for another document remains available on return. A superseded scene for the same document releases its buffers immediately.

Repeated camera frames reuse geometry. Each sufficiently large layer buffer has world bounds for groups of 384 slots. A zoomed view draws consecutive visible groups in their original order. On a stationary camera, ordinary edits can upload only the affected text-band rectangle. A change to layer order, camera, transparency composition or planning regions refreshes the relevant full texture.

The earlier comparison measured 1.9–2.2 ms for a synchronous journal scan and 1.2 ms for comparing snapshots on the 25,600-object board. The November 20 revision removes that synchronous scan. The current interaction measurements appear below.

### Selection and highlight

- **Per-instance state.** Each instance has a state in its own small buffer: −1 hidden (dead, or hidden by the
  router's shove preview), 0 normal, 1 selected or on the highlighted net.
- **Highlight.** Highlighting compares a per-slot net number.
- **When it is recomputed.** Only when the selection or highlight key changes, and otherwise only for the slots an
  edit added. Above 64 selected objects, it is recomputed every frame (about 1 ms for 85k slots).
- **Pours.** A pour takes the highlight colour per region, as in the 2D path.

### Anti-aliasing

- **Segments and blobs.** Coverage is analytic, a linear ramp over one device pixel of signed distance. This is
  close to Canvas's area coverage for edges and round caps.
- **Pours, fills and the board area.** The renderer requests an antialiased stencil framebuffer. The driver
  chooses the sample count. Exact redraws can use native Canvas coverage for narrow pour clearances.
- **Grid.** It is not anti-aliased in either path, and the pixels are identical.


### Additions for parity

- **Pad and via stacks.** Objects whose land depends on the active layer (pads with `padStack` and a stack mode,
  vias with a stack mode through `AtriumViaStack.display`) are re-emitted when the active layer changes.
- **Custom pads** (`shape: "custom"`, `p.poly`) are ear-clipped into the triangle buffer (kind pad, so pad
  opacity applies); their drill is a blob with shape 5 (hole only).
- **Blind and buried vias.** Multi objects with a layer span get a bucket per span: visibility and dim ink follow
  `PCB.onLayer` with the object, and the drill is drawn in the span's two copper colours (second colour on the
  local +y half, from 3 px, not on dimmed spans), as `drawPad`.
- **Net colours.** A palette texture of `opts.netColors`; each slot's state carries a colour index, recomputed when
  the colours change. Tracks and polygons take them (not on dimmed layers), connection lines too (1.5 px, 2 px when
  highlighted).
- **Live pour patches** (polygon-pour.js tiles while a part is dragged): a patch region is filled inside its clip
  rectangles (stencil bit 2, rectangles snapped to device pixels), the stored regions of the patched pour outside
  them, with the patch's fade alpha. Pour buffers are freed when their region leaves the board.
- **Origin marker and board-shape handles** are screen-space blobs and segments drawn after the board edge and
  before copper, as canvas.js paints them (squares filled with the workspace or selection colour and a 1 px ring,
  circles likewise).
- **Opacity below 1.** A layer's segments are drawn with MAX blending into a texture and composited once with the
  layer alpha, so a track's joints are covered once (one Canvas stroke). Overlapping tracks of one layer are also
  unioned, where the 2D engine blends two strokes twice (§5).
- **Selection.** Selected objects are drawn once, by the GPU in the selection colour in their own layer; a selected
  track's edit handles too (a selection-coloured square in a 1 px board-coloured ring, after the layer's segments);
  only the boxes of pads, vias and parts are on the top layer.
- **Filled polygons** (footprint bodies, filled graphics, custom pads) are ear-clipped; touching keyhole bridges and
  collinear spikes (imported text and logos) are handled as earcut does, so the fill is complete.

## 3. Files

| File | What |
|---|---|
| `app/canvas/canvas-gpu.js` (lazy, 73 KB) | The renderer. API: `render(I, doc, defs, opts, gesture)`, `status(I?)`, `stats(I?, reset)`, `finish()`, `composite()`, `reset()`, `refresh()`, `loseContext(I?, restoreAfterMs)`, `enable(true | false | null)` (a session override for tests), `mode("prints" | "journal")`. |
| `app/canvas/canvas-gpu-pref.js` (lazy) | Preferences › Display › Renderer, the hardware probe and the renderer choice. The editor requests the GPU after a visible PCB frame. AtriumPrefs stores the choice and migrates the old experimental switch. |
| `app/canvas.js` | `padText` on `I`, and the gesture flag passed to the hook. |
| `app/editor.js` | `editorPane: true` on the other split pane's render. |
| `app/about.js` | About shows "Board renderer: GPU (WebGL2, device)" or "2D: reason". |
| `tests/canvas/gpu-pixels.js`, `scripts/gpu-pixels.sh`, `scripts/gpu-pixels-report.py` | The pixel test in Chrome with its GPU (§5); `FAULTS=all` the fault matrix, `CALIBRATE=1` the budgets. |
| `tests/canvas/gpu-pixels-budgets.json` | Per-case, per-host budgets of the pixel test (calibrated from the real GPU output). |
| `native/tests/macos-harness/gpu-pixels.sh`, `gpu-pixels-probes.js` | The same in WKWebView through the real `Desktop` class. |
| `tests/canvas/gpu-pref.cjs` | The decision: software rasterizers by name and by caveat, GPU and 2D choices, no WebGL2, migration, no page. |
| `tests/canvas/perf-gpu.js`, `scripts/perf-gpu.sh`, `native/tests/macos-harness/gpu.sh` | The benchmark (§4). |
| `scripts/click-through.sh` | `RENDERER=gpu|2d|auto` sets the renderer for every page (gpu: Chrome with its GPU) and prints the renderer in use. |
| `native/tests/macos-harness/frame.sh` | `FRAME_RENDERER=2d|gpu|auto`. |
| `scripts/ci-local.sh` step `gpu`, `.github/workflows/ci.yml`, `scripts/ci/linux-steps.sh` (browser step) | Pixel test in Chrome (skipped cleanly without WebGL2) and WKWebView, click-through pcb with Renderer GPU. |

Eager JS is unchanged by the GPU files (both lazy); `tests/maintenance/startup-budget.py`: 1030.4 KB of 1050 KB.

## 4. Benchmarks

The 25.6k-object board (`tests/pcb/dense-board.js`) with 64 nets and ten poured polygons; both renderers in the same
session, 2D first. WKWebView: WebKit 22625.2.8.11.9, macOS 27.2.1, Apple GPU, 58.8 Hz display, canvas 875×755 at
dpr 1, 1 ms timers. Chrome 158 headless with its GPU (ANGLE Metal, Apple M6), 914×652 at dpr 1, 2D GPU-rastered.
`work` is the main-thread time of the editor's render; `lat` input to the frame after it; "flush" rows include a
readback. p50 (p95).

| Metric | Chrome 2D | Chrome GPU | WKWebView 2D | WKWebView GPU |
|---|---|---|---|---|
| First draw (flush; GPU includes context, shaders, build, uploads, text; 2026-11-20 runs, see below) | 21–47 | 33–59 | 45–79 | 34–55 |
| Exact frame at fit (flush) | 39 (44.6) | **4.1 (7.4)** | 44 (53) | **5 (9)** |
| Exact frame zoomed (flush) | 12.1 (14.4) | 3.6 (4.8) | 8 (12) | 4 (6) |
| Pan at fit: work; dropped of 89 | 0.5 (2.4); 2 | **0.3 (0.6); 0** | 1 (11); 4 | **0 (1); 0** |
| Wheel zoom at fit: work | 0.1 (0.7) | 0.1 (0.2) | 0 (1) | 0 (1) |
| Pan zoomed: work | 0.9 (1.6) | 0.1 (0.4) | 1 (2) | 0 (1) |
| Wheel zoom zoomed: work | 1.1 (3.4) | 0.2 (0.3) | 2 (6) | 0 (0) |
| Click select at fit: work (2026-11-20) | 0.5–0.8 | **0.4** | 1–2 | **0** |
| Edit at fit (via moved): render work | 14.7 | **7.8** | 25 | **7** |
| Edit at fit: input to paint | 30.8 | 28.1 | 83 (97) | **48 (54)** |
| Edit zoomed: render work; input to paint | 7.4; 30.5 | 6.9; 28 | 12; 55 (82) | 8; 42 (68) |
| Repaint after an edit (flush): fit / zoomed | 47.4 / 11.5 | **5.0 / 3.8** | 41 / 24 | **6 / 4** |
| The `edit()` call | 14.3 | 14.8 | 10 | 11 |
| GPU memory | — | 19 MB (pours 11, instances 5–6, text texture 2.3) | — | 19 MB |

**Click select** (2026-11-20): 0–0.4 ms at fit and about 1 ms zoomed on the GPU, against 0.5–2 ms for the 2D
path's selection shortcut. It was 3–5 ms: the benchmark's clicks land on parts as often as on vias, and selecting a
part redrew and re-uploaded the text layer (3 ms of it in WebKit). The text layer now draws everything unselected and
the selected objects' text and boxes go on the top 2D layer (§2), so a click is a GL frame plus the top layer.

**First draw.** In the app a view's first frame is the 2D renderer's: the context, shaders and scene are built in
idle time after it and the view then redraws on the GPU (`render` defers when the view has no GPU state yet; tests
and benchmarks with `noReuse` build at once). So the synchronous build (row above) is never on the first frame the
user waits for. Measured as a synchronous build it is 34–55 ms in WebKit against 45–79 ms for the 2D frame across
three runs on 2026-11-20 (the machine was shared with other test runs; the spread is run to run), so the old
"67 against 56" no longer holds either way. Exact frames with a flush were 7–10 ms (Chrome) and 8–9 ms (WebKit) at
fit in the same runs, against 4–5 ms on 2026-11-19; most of a flushed frame is the GPU finishing the pours, and the
2D numbers moved by as much between runs.

**`frame.sh` (WebKit budgets, the real editor)**, Automatic = GPU: every interaction passes; pan, wheel, pinch,
drag-pan, box drag and DRC pan at 0 ms work p50 and 0 dropped frames; move drag 4 ms, 0 dropped (2D: 7 of 39
dropped, FAIL); click 0–1 ms (2026-11-20); undo 9 ms; DRC hover at fit 9 ms (paintTop with 1,000 markers, every pointer frame).

### Where an exact GPU frame's time goes (WebKit, edit at fit)

`stats().acc`, ms a frame: update 1.6 (the changed objects' instances), GL 2.6 including the text layer 1.15
(redraw 0.1 plus copy), top 2D layer 0.04. Gesture frames: GL 0.1–0.3, nothing else.

### Edit to screen in WKWebView, broken down

From a timer-gap probe at fit (six edits each), measured from the input:

| | 2D | GPU |
|---|---|---|
| `edit()` call | 18–34 ms | 10–32 ms |
| Further main-thread tasks before the first rAF (live pour repour and connectivity) | about 15 ms and about 30 ms | about 15 ms and about 30 ms |
| First render starts at | 72–82 ms | 55–81 ms |
| First render takes | 24–26 ms | 4–6 ms |
| A second render after the deferred pour and connectivity work, at about 140 ms | 25 ms | 3 ms |

**What this means.**
- **The GPU removes about 20 ms from each of those two renders.** The live pour and connectivity work that runs
  before the first frame is untouched.
- **The 2D path's gesture shortcuts hide pan costs during the gesture.** They are the blit plus the exact repaint on
  idle. That idle repaint is 46 ms in WebKit at fit, a visible hitch whenever the user pauses and resumes. The GPU
  path has no such frame.
- **120 Hz.** Every GPU frame measured here fits in 8.3 ms of main-thread time.

**What this means.** Rendering is now 5–8 ms of an edit's 48 ms input-to-paint in WebKit; the rest is the
`edit()` call and the live pour and connectivity work before the first frame (the edit-latency work moves it after
the paint).

**Undo-store journal path, re-measured** after the idle scheduler and post-frame deferral landed (Chrome, GPU,
edit frames): journal mode 10.4 ms render work and 2.8 ms update against 7.8 and 1.9 for snapshot ("prints")
mode. `AtriumUndoStore.changed()` still runs the store's pending `sync()` when called, which moves the deferred
recording back into the edit frame. "prints" stays the default; journal mode would pay off only if `changed()` could
answer from entries recorded so far without syncing.

**How to reproduce.** Chrome: `scripts/perf-gpu.sh out.json` (`MODE=journal`, `ONLY=gpu`). WKWebView:
`HARNESS_INSTALL=$PWD/native/tests/macos-harness/target/gpu native/tests/macos-harness/gpu.sh <work>`, then delete
`target/`.

## 5. Pixel test

`tests/canvas/gpu-pixels.js` renders each case twice with the same options, 2D then GPU (`noReuse`, caller overlays such as
DRC markers left out), and compares the composited GPU frame (WebGL canvas plus 2D canvas) with the 2D frame.
Run: `scripts/gpu-pixels.sh [out.json]` (Chrome with its GPU) and `native/tests/macos-harness/gpu-pixels.sh <work>`
(WKWebView through the real `Desktop` class); env `IMAGES`, `BOARDS`, `CASES`, `VIEWS`, `BUDGET`, `BUDGETS=none`,
`CALIBRATE=1`, `CAPTURE_RASTER=board.view.case,...`, `FAULTS=all`.

The grid uses device-pixel positions rounded by the same JavaScript calculation as Canvas 2D. The GPU
draws those lines as one-pixel quads. At one device pixel, narrow track bodies use the area of the pixel
square between their edges. Settled connection lines share Canvas 2D's path rasterizer on the existing
tool canvas. During gestures, retained WebGL connection lines paint in the same order as their 2D tint
groups, and the first moving frame refreshes the tool overlay before scrolling it.

Chrome uses a 1440×813 CSS viewport independent of the outer browser window so the dense fit
fingerprints use the same fit geometry on each run. The layout resize check shrinks and restores
the live workbench and checks the 2D overlay, WebGL backing, drawing buffer and composite readback.
Use `ROBUSTNESS=layoutResize` to select it.

The WKWebView comparison pins `DPR=1` for its per-case budgets and records the canvas backing size and display
scale. Set `DPR=2` or `DPR=native` to view results at another scale using the general limits.

- **Boards:** the dense board plus objects it lacks (a T-M-B stacked via, tented, filled and back-drilled vias, a
  blind and a buried via, a custom pad, a large pad with a net name, an octagonal through-hole pad, a non-plated
  hole, a pad stack, a filled graphic); a 900-object board with its own two pours ("pours", for live pour patches);
  the starter board; the KiCad demo board; the PiDP-11 I/O Expander (Altium PcbDoc).
- **Views:** fit, zoomed (an eighth of the board), close (pads large enough for numbers and net names).
- **Cases (13):** base, dim, single (Bottom), flipped, selection (a track, a via, a part), highlight, net colours, a
  light canvas, the high-contrast canvas, board-shape handles, **Board Planning** (key 1: region tints and labels),
  opacity (tracks and pours 0.5, Bottom layer 0.6), and **pourDrag**: a frame in the middle of a part drag with live
  pour tile patches (zoomed; up to four parts nearest the middle are tried until the tiles patch the pours).
- **Determinism.** Connection lines are computed before each view and the 2D path's idle-time indexes are built
  first. Selecting `CASES` still runs prior paints and readbacks to keep the browser's Canvas raster backend
  consistent with a full run. Selecting `BOARDS` can change the window layout after fixture import.

### Metrics (2026-11-20)

The old metric (pixels over 8 levels, ≤ 40 % of the frame) let a frame with blind and buried hole colours missing
pass. It is replaced by:

| Metric | What |
|---|---|
| `interiorPx` | **Edge-tolerant, strict interiors.** The 2D frame's edges (a channel step over 16 levels to a neighbour) dilated by one pixel hold every anti-aliasing difference. Everywhere else the frames must agree within 24 levels; this counts the pixels that do not. A missing, extra, recoloured or reordered object shows here. |
| `c_hole`, `c_sel`, `c_top`, `c_bottom`, `c_inner`, `c_silk`, `c_conn`, `c_other` | **Per-object-class masks:** `interiorPx` split by the class whose colour the 2D pixel (else the GPU pixel) has, within 12 levels: via and pad holes and drill edges, the selection colour, Top / Bottom / inner copper (solid, or poured at the pour opacity over the board), silk and pad text, connection lines; "other" is blended, dimmed and highlighted colour. Each class has its own budget, so a small class (holes, the selection) cannot hide inside a case's total. |
| `edgeMean` | The mean difference on the dilated edge pixels: a shifted, thinner or reordered object raises it. |
| `solidPx` | Centres of 3×3 blocks all over 48 levels anywhere. |
| `over8`, `over48`, `meanAbs` | For information only. |

**Budgets are per case and per host** (`tests/canvas/gpu-pixels-budgets.json`, 157 Chrome and 157 WebKit cases: "starter"
has one view): from a calibration run of the real GPU output (`CALIBRATE=1 BUDGETS=none`), `interiorPx`, `solidPx`
and every `c_*` at 1.2 × measured + 6 px, `edgeMean` at 1.1 × measured + 0.15 levels. Ranges (Chrome; WebKit):

| Board, view | interiorPx | largest class budget | edgeMean | solidPx |
|---|---|---|---|---|
| Dense, fit | 6–32; 6–345 | 32 (conn); 336 (conn) | 3.0–20.0; 7.5–11.9 | 6–9; 6 |
| Dense, zoomed | 6; 6–13 | 6; 13 | 2.5–5.6; 3.7–6.3 | 6; 6 |
| Dense, close | 6–18; 6–22 | 18 (top); 22 | 2.0–2.9; 2.2–4.2 | 7–21; 6–20 |
| Pours, all views | 6 | 6 | 0.8–6.2; 0.4–2.6 | 6 |
| Starter | 6 | 6 | 0.15–0.17; 0.15 | 6 |
| KiCad demo | 6–63; 6–96 | 63; 96 (opacity) | 0.4–1.6; 0.4–1.2 | 6–97; 6–139 |
| PiDP-11 (Altium) | 6–129; 6–138 | 120; 129 (opacity) | 1.8–4.2; 1.4–2.5 | 6–374; 6–408 |

The table records the original calibration. The dense fit interior and connection-line limits were tightened
after sharing the settled stroke rasterizer. Dense Fit Single Layer and Net Colours also compare signed RGB
differences tile by tile at DPR 1. An unchanged aggregate can still fail if the residual changes in one tile.
`CAPTURE_RASTER` prints observations to the result JSON for review. `CALIBRATE` updates aggregate limits and
preserves the fixed tile fingerprints.

The focused probes check connection-line ink and track ink at four angles and two pixel phases, colour
ordering in settled and moving frames, and grid placement on both sides of a half-pixel boundary. The
`wireGeometry` and `wireTintOrder` faults must change residual tiles in their respective dense fit cases.

### Fault injection

`FAULTS=all` (both runners) reruns the suite once per fault; `app/canvas/canvas-gpu.js` `fault()` breaks one thing on
purpose (`globalThis.__atriumGpuFault`, test pages only). Every fault must fail at least one case. Result
2026-11-20 (cases over budget; first cases caught):

| Fault | Chrome | WKWebView |
|---|---|---|
| holes: hole and pad-hole colours swapped, blind/buried two-colour holes off | caught, 86 (dense close.base: interiorPx 161 > 14, c_hole) | caught, 97 (dense close.base: interiorPx 137 > 16, c_hole) |
| offset: the Top layer 1 device px to the right | caught, 133 (dense fit.dim: solidPx 14636 > 6) | caught, 132 (dense fit.dim: solidPx 22671 > 6) |
| order: the Bottom layer drawn last | caught, 133 (dense fit.base: solidPx 48341 > 6) | caught, 132 (dense fit.base: solidPx 43801 > 6) |
| padText: pad numbers and net names missing | caught, 71 (pours zoomed.base: solidPx 35 > 6) | caught, 84 (pours zoomed.base: solidPx 40 > 6) |
| netColor: net colour channels rotated | caught, 12 (dense close.netColors: solidPx 2187 > 20) | caught, 12 (dense close.netColors: solidPx 2020 > 15) |
| smallVias: vias under 0.7 mm not drawn | caught, 107 (dense zoomed.base: edgeMean) | caught, 120 (dense zoomed.base: edgeMean) |
| selection: selected copper drawn again above every layer | caught, 7 (dense zoomed.selection: solidPx 58 > 7; pours close.selection: interiorPx 442 > 6) | caught, 6 (pours close.selection: interiorPx 349 > 6) |
| trackWidth: tracks 10 % thinner | caught, 83 (dense close.base: edgeMean 4.1 > 2.71) | caught, 114 (dense zoomed.base: edgeMean) |
| pourPatch: live pour patches drawn unclipped | caught, 1 (pours zoomed.pourDrag: interiorPx 48 > 6, c_bottom 15 > 6) | caught, 1 (pours zoomed.pourDrag: interiorPx 15 > 6, solidPx 83 > 6, c_bottom 9 > 6) |
| planning: Board Planning tints missing | caught, 12 (dense zoomed.planning: interiorPx 60435 > 6) | caught, 12 (dense zoomed.planning: interiorPx 69854 > 13) |

Chrome: `PASS fault injection (Chrome): 0 fault(s) missed`. WKWebView: every fault caught (pourPatch since the fix below). Faults caught only by `edgeMean`
(smallVias at 0.7 mm, trackWidth −10 %, padText on some cases) are caught in 71–120 cases each, never by one margin.

**Live pour patches in WKWebView** (fixed 2026-11-20). The pourDrag case used to find no patch there: the tiles
re-solved every drag frame and the worker reported changed tiles, but the exact live repour cleared the patches
again at once. Every board frame calls `displayState`, which schedules the live job; in WebKit `idle()` is
`AtriumIdle.afterFrame`, so the job ran after every frame, found nothing stale (a drag moves items in place
without a new revision, so its cached answer for the revision still held) and called `tileSettled`, which drops
the patches as "exact". A real AppKit drag (NSEvent mouse down, dragged, up through the harness) showed the same:
no patch on any frame. `tileSettled` now leaves the patches alone while a drag is moving items (`H.drag().before`);
the drop's edit (or its "no change" frame) settles them as before. The copper after the drop is the same.

### Fixed by this test

- **Filled polygons with keyhole bridges** (imported text and logos: the PiDP-11 "open source hardware" logo, 227- and
  2272-point silk regions) lost part of their fill: the ear clipper stopped at touching bridge vertices. It now
  ignores vertices at a corner's coordinates, drops zero-area corners and, when stuck, cuts a convex corner (as
  earcut does); the clipped area matches the polygon's on every fill of the board.
- **Text order across layers.** One text texture under through-hole copper put Bottom-overlay text above Top-overlay
  line art (and Mechanical text above copper). The text layer is now split into bands, one per gap between GPU
  passes (§2), so each layer's text is under the next GPU pass above it, as canvas.js paints it.
- **Track handles.** A selected track's edit handles were on the top 2D layer, above later layers' copper; they are
  now drawn by the GPU in the track's layer, after its segments.
- **Board Planning on gesture frames** composited the text at through-hole order; the planning band is above every
  pass on both.

### Via lands and tenting marks, 2026-11-21

Headless Chrome 158 used hardware WebGL2 through ANGLE Metal on Apple M6, with an 836 × 708 canvas at DPR 1. Run the full comparison from the repository root.

```sh
DPR=1 scripts/gpu-pixels.sh --skip-if-no-webgl
```

The baseline and the corrected renderer each passed all 170 comparisons against the checked-in Chrome budgets. Twelve dense-board views and five views of the public PiDP-11 Altium board exceeded those budgets before correction.

| Board and view | Metric | Before correction | After correction | Existing limit |
| --- | --- | ---: | ---: | ---: |
| Dense, close | Interior pixels | 43 | 0 | 14 |
| Dense, close | Solid-difference pixels | 165 | 0 | 20 |
| PiDP-11, zoomed, dim | Interior pixels | 45 | 0 | 6 |
| PiDP-11, zoomed, single | Interior pixels | 40 | 0 | 28 |
| PiDP-11, close, dim | Interior pixels | 52 | 0 | 6 |
| PiDP-11, close, single | Interior pixels | 65 | 0 | 6 |

The dense board’s 1.2 mm via land disappeared around its 0.35 mm drill because 2D read its diameter-based stack row as a rectangular pad. Both renderers now use the same active-layer land. On PiDP-11, the GPU drew green tenting rings over connected traces. Compositing the marks in their copper layer restores the drawing order for active copper and Board Planning tints.

Tenting one via changed 191 output bytes and uploaded 15,984 texture bytes for the edited area. The GPU reused the scene. Both the edited frame and the frame with via marks hidden matched fresh renders byte for byte.

### Results, 2026-11-20 (worst case per board and view; interior px / edge mean / solid px)

| Board, view | Chrome | WKWebView |
|---|---|---|
| Dense, fit | 22 (base, connection lines) / 18.1 / 3 | 283 (contrast, connection lines) / 10.7 / 0 |
| Dense, zoomed | 0 / 4.9 / 1 | 6 / 5.6 / 2 |
| Dense, close | 10 / 2.5 / 13 | 14 / 3.7 / 12 |
| Pours (incl. pourDrag in Chrome) | 0 / 5.5 / 0 | 0 / 2.3 / 0 |
| Starter | 0 / 0.02 / 0 | 0 / 0 / 0 |
| KiCad demo | 48 (zoomed selection) / 1.4 / 76 (opacity) | 75 (opacity) / 1.0 / 111 (opacity) |
| PiDP-11 (Altium) | 103 (opacity) / 3.7 / 307 (opacity) | 110 (opacity) / 2.2 / 335 (opacity) |

Every case is within its budget in both, two runs in a row; robustness checks pass in both.

- **Robustness checks** on the last board: lost context (`WEBGL_lose_context`, restored after 300 ms: 2D meanwhile,
  GPU after, frames match), memory cap (1 MB: 2D with the reason; back on the GPU when lifted), document switch
  (the parked scene comes back, no rebuild), split pane (frames match while split and after closing). They wait for
  the idle-time first GPU frame (§6) after each reset.

**Antialiasing and draw order.**
1. **Anti-aliasing**, one or two levels on every edge: analytic coverage on a one-pixel ramp and 4× MSAA for fills,
   where Skia and CoreGraphics compute area coverage. Grid and workspace pixels are identical. On edges only.
2. **Hairlines.** Connection lines are one CSS pixel. Skia draws them lighter (hairline coverage); CoreGraphics
   strokes all connection lines as one path, so nearly coincident lines cover a pixel once. The GPU blends each line.
   MAX-blending them was tried and was worse in both engines. This is the `c_conn` budget at fit (WebKit 336 px).
3. **Copper overlaps.** Translucent layers and mixed filled graphics with net-coloured tracks use ordered layer
   composition. Settled pours under translucent tracks share the same coverage pass. Live patches and animated
   reveals use their GPU draw. Pad numbers and net names use their pad's layer.
4. **Selection.** Track handles paint after their own track, so later artwork can cover them. A selected part's
   text keeps its layer order and its selection rectangle draws over the board geometry.

## 6. Robustness

- **Power and visibility.** Automatic requests WebGL2 with the low-power hint. An explicit GPU setting requests
  high performance. Home and Preferences can show the setting before a board needs any GPU work. Hidden windows
  pause editor frames and cancel pending GPU preparation. A restored WebGL context rebuilds its shaders and
  uploads buffers when its pane draws again in the foreground.
- **Software renderers.** `canvas-gpu-pref.js` probes each requested power hint with `failIfMajorPerformanceCaveat`
  and `WEBGL_debug_renderer_info`. Automatic uses the 2D renderer when the context needs the caveat or the renderer
  says SwiftShader, llvmpipe, softpipe, lavapipe, Mesa OffScreen, GDI Generic, Microsoft Basic Render Driver or
  "software". Renderer GPU uses any WebGL2. Headless Chrome with `--disable-gpu` (click-through, perf-canvas) gets
  "WebGL2 is not available here" and stays 2D.
- **Lost context.** `webglcontextlost` hides the GPU canvas and the 2D renderer draws; `webglcontextrestored`
  recreates programs and re-uploads everything on the next frame, on a fresh canvas: after a real GPU process
  restart Chrome never composites the restored canvas again (the view showed the overlays over an empty board).
  A loss also drops every retained 2D copy (zoom layers, board copies), whose surfaces lost their pixels with it;
  Chrome's `contextlost`/`contextrestored` on the view's 2D canvas do the same and redraw it in full
  (the `surfaces` case in `tests/canvas/browser-zoom-geometry.js` ends the GPU process mid-zoom). After four losses the view stays 2D.
- **Memory cap.** 768 MB a view (instances, pours, outline, union and text textures); parked scenes are dropped
  first; a board over the cap, or `OUT_OF_MEMORY` after an upload, falls back to 2D for that document with the
  reason in `status()`. Pour buffers of replaced regions are freed.
- **Device pixel ratio and resize.** The GPU canvas follows the 2D canvas's device size and offset every frame;
  textures are reallocated on a size change.
- **Views.** One context per view, at most six; a view whose canvas left the page (a closed split pane) gives its
  context back on the next frame. The other split pane renders on the GPU (`editorPane`).
- **Document switches.** Up to two scenes are parked per view, keyed by canvas.js's cache object (canvas-fast.js
  parks the same cache), so switching back costs no rebuild.
- **Errors.** Any exception while drawing turns the GPU renderer off for the session (`status()` gives the error).
- **Status.** Preferences › Display shows "In use: GPU (WebGL2, device)" or "In use: 2D: reason"; About shows the
  same line.

## 7. Parity: status per gap

| Gap (from the experiment) | Status |
|---|---|
| Pad numbers and net names on large pads | Done. Captions share their copper layer and preserve occlusion by later artwork |
| Pad stacks | Done (active layer's land, re-emitted on a layer change) |
| Via stack display and via marks | Done (stack lands on the GPU; marks on the top layer from 6 px, as canvas.js) |
| Custom-shape pads | Done (ear-clipped) |
| Blind and buried two-colour holes | Done (span buckets) |
| Net colours | Done (tracks, polygons, connection lines) |
| Pour patches while dragging | Done. The 2026-11-20 native and Chrome runs both rendered an active drag with tile patches against Canvas2D (§5) |
| Per-object visibility in dim and single-layer modes | Done (span buckets use `PCB.visible` / `PCB.onLayer` with the object) |
| Board-shape edit handles | Done (GPU, under copper as in canvas.js); Board Planning no longer falls back |
| Origin marker above copper | Done (GPU, under copper) |
| Track joint double-blend below opacity 1 | Done (union pass); overlapping tracks differ, §5.4 |
| Selected objects' layering | Done (drawn once in their layer, track handles too; pad, via and part boxes above) |
| Text | Kept on the 2D engine, cached, in bands between GPU passes (§2) |

## 8. What remains

- **Linux and Windows hardware.** Verified on macOS (WKWebView, Chrome). WebKitGTK on the Linux runner (NVIDIA) and
  WebView2 are untested on hardware; the Linux CI container has no GPU, so its pixel test is skipped (or runs on
  SwiftShader if that Chromium offers WebGL2) and Automatic stays 2D there.
- **Edit latency** is now dominated by the `edit()` call and the work before the first frame, not rendering.
- **DRC hover at fit** (9 ms with 1,000 markers) redraws `paintTop` every pointer frame on both paths; caching the
  caller overlays would help both.
- **Cross-platform live copper.** Current Chrome and WKWebView runs both exercise a live tile patch while dragging a component. Native Windows and Linux hardware still need equivalent runs.
- **Text bands.** An ordinary committed edit can reuse the entire texture or upload its old and new painted bounds. A change to the camera, layer composition or board-planning display can still require a whole texture upload.
- **WebGPU** later, as a second backend behind the same scene arrays, once WebKitGTK ships it (§1).
