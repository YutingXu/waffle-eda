# Continuous integration and release builds

Waffle EDA's CI runs on **self-hosted** GitHub Actions runners: a Mac (Apple Silicon), a Linux arm64
host with Docker, and a Windows x64 machine. The workflows call
repository scripts, so CI and a local run do exactly the same thing.

| What | Where |
|---|---|
| CI on push to `main`, pull requests and manual runs | `.github/workflows/ci.yml` |
| Release builds on `v*` tags and manual runs | `.github/workflows/release.yml` |
| macOS steps (also run locally) | `scripts/ci-local.sh [jsc mcp static swift windows harness click perf]` |
| Linux steps (also run locally on any Docker host) | `scripts/ci-linux.sh [images node mcp static native webkitgtk deb browser]` |
| Linux CI images | `scripts/ci/linux.Dockerfile`, `install-node.sh`, `package.json` + `package-lock.json` |
| Rust/WebAssembly kernels (`engine/`, `app/engine-core.js`) | `scripts/build-engine.py --check`; toolchain `engine/rust-toolchain.toml`, `scripts/ci/install-rust.sh` (macOS), `rust` image stage (Linux) |
| Known test failures (one list for every runner) | `tests/known-failures.txt`, checked by `scripts/ci/check-results.py` |
| WebKitGTK UI probes (the Linux counterpart of the macOS harness's `ui.sh`) | `native/tests/linux-harness/ui.py` |
| Installed Debian package UI and native bridge probes | `native/tests/linux-harness/package.py` |
| Registering and removing runners | `scripts/runners/` and its `README.md` |

## Build the developer preview locally

On macOS with Xcode, Python 3.9 or later and the pinned Rust toolchain, run `scripts/release-preview.sh` from the tested commit. The command generates the runtime assets from a clean Git archive. The command stages the universal app, disk image, Windows portable ZIP, and Debian package in a temporary directory. It uses the pinned .NET SDK for the Windows cross-build, or the SDK selected by `DOTNET`.

The command checks the packages before moving the complete set to `dist/preview-<version>`. Pass a path to use a different new or empty folder. `SHA256SUMS` covers the downloadable packages and the accompanying release notes. The macOS package uses ad hoc signing unless `WAFFLE_SIGN_IDENTITY` selects the stable identity (below). This command runs locally.

The package version comes from `app/VERSION`. When updating it, update the browser and native metadata mirrors and run `python3 scripts/release-version.py --check`. About and the disk image’s Read Me First show the full release name. For Butter Official, `--name` returns `Butter`, `--flavour` selects Butter artwork and `--notes` selects the formal release notes.

## Stable macOS signing identity

Ad hoc signing makes the app's identity the hash of that exact build. macOS then treats every release as a new app: an earlier **Open Anyway** approval and granted permissions do not carry over. Release builds can instead sign with one self-signed certificate, so each release has the same designated requirement: `identifier "org.waffle.editor" and certificate leaf = H"<SHA-1>"`. The certificate's public SHA-1 is in `native/macos/signing-leaf.txt`, and the build fails if a signature carries another one.

- Create the identity once on the build Mac with `scripts/create-signing-identity.sh`. It writes its own keychain, a password-protected backup `.p12` in `~/Documents`, and both passwords in `~/Library/Application Support/waffle-release-signing`. Move the backup and its password to safe storage. Nothing goes into the checkout.
- Build with `WAFFLE_SIGN_IDENTITY="Waffle EDA" scripts/release-preview.sh`. Without the variable, builds stay ad hoc.
- The certificate is not from Apple, so a browser download is still unnotarised and asks for **Open Anyway** on first launch. Developer ID signing and notarisation (`ATRIUM_SIGN_IDENTITY`, `ATRIUM_NOTARY_PROFILE`) remain the way to remove that prompt.
- Replacing the certificate changes the app's identity once, like a move from ad hoc. Update `signing-leaf.txt` in the same commit.

## Release source privacy

The macOS and Linux static checks run the public scanner's synthetic tests without private data. To qualify a release locally, stage the exact candidate tree and run `python3 -B scripts/check-public-tree.py --require-policy`. The command reads the Git index. The same private policy must be used for the separate reachable-history check before transferring source or building packages for distribution.

For a local release, provide a runner-owned regular mode-0600 policy file outside the checkout. Set `WAFFLE_PRIVACY_POLICY_FILE` to its absolute path and `WAFFLE_PRIVACY_POLICY_SHA256` to its independently recorded SHA-256.

For GitHub Actions, provision `WAFFLE_PRIVACY_POLICY_JSON` and `WAFFLE_PRIVACY_POLICY_SHA256` as secrets in the protected `release` environment. Record the digest of the exact payload bytes, including any final newline. The reviewed release workflow pins the public scanner digest. It verifies the scanner as a regular file before passing private data to the verified bytes under isolated Python. Update the pin in the trusted workflow when reviewing a scanner change. Restrict the protected environment to reviewed workflow revisions. The preflight writes the payload to a temporary mode-0600 file and removes it when the check ends. Only this job receives the policy, and its diagnostics omit paths and contents. Keep untrusted jobs off the release runner's OS account on installations that allow them.

When publishing, the preflight qualifies the tag passed to the workflow, including dispatches from a branch. Otherwise it qualifies the triggering commit. The build jobs receive that immutable commit, and draft creation also checks that the tag still points to it. Keep the policy and digest outside the repository, build inputs and logs.

## Adding a JavaScript suite

Put a new standalone CommonJS suite directly under `tests/<feature>/` with a unique filename. Both default runners
discover it by filename, and the filename without `.cjs` is its report ID. Keep helper modules in `tests/support/`
or `tests/<feature>/support/`. Specialized test trees and probes keep their dedicated runners. Node also discovers
suites directly under `native/tests/`. [Shared discovery](../tests/support/suite-paths.py)

A browser suite requires `tests/support/playwright.cjs` instead of `playwright-core`. Its contexts and pages
then use locale en-US, time zone UTC and mains power unless the suite sets its own, so the result does not
depend on the host's language, `TZ` or battery. A suite that compares output written in local time requires
`tests/support/utc.cjs`. `scripts/test-jsc.sh` runs JavaScriptCore with `TZ=UTC`.

## What runs where

**macOS** (`[self-hosted, macOS, ARM64, atrium]`, `scripts/ci-local.sh`):

- JS suites under JavaScriptCore (`scripts/test-jsc.sh`). Only failures not listed in `tests/known-failures.txt` fail the job.
- `tests/automation/mcp.py`, `mcp_runner.py`, `headless-parity.py`, `eco-e2e.py`.
- End-to-end fidelity (`e2e` step): `tests/e2e/run.py` checks an unedited import against an independent reader and the original tool's outputs. `tests/e2e/edit-flow.py` then edits each board through the MCP server (slide a via, drag, rotate, flip and place footprints, route a connection), saves it back as KiCad and as an Altium source copy, and reads every saved file with the same independent readers. `tests/e2e/edit-known-failures.json` lists the defects it shows today. `tests/e2e/census.cjs` starts from the source instead: an independent reader lists every object and field a KiCad, Altium or Eagle file holds, and each must be held by the imported model, named in the Import Report, or declared outside a design's meaning with a reason. `tests/e2e/census-known-failures.json` lists what fails today, as lost (the census looked and the model does not hold it) or unmapped (the census has no check for the field yet).
- Rust/WebAssembly kernels (`rust` step): `cargo test`, then `scripts/build-engine.py --check` (app/engine-core.js must equal a fresh, reproducible build), then `tests/core/engine.cjs`, `engine-pour.cjs`, `drc-equivalence.cjs` and `connectivity.cjs` under JavaScriptCore with `ATRIUM_ENGINE=wasm` and `=js`. The pinned toolchain is installed under `~/.cache/atrium-rust` on first use (`scripts/ci/install-rust.sh`, rustup-init checked by SHA-256). On Linux the `rust` step runs `cargo test` and the same `--check` in the pinned `rust` image with no network.
- Static checks: `css-tokens.py`, `reachability.py --check`, `gen-shortcuts.py --check`, `startup-budget.sh --static`, `prepare-assets.py --check` (freshness), `prepare-assets.py --check-untracked` (Git hygiene), `gen-schema.py --check` (the VS Code JSON schema), `compat-guard.py --check` and `compat-corpus.py --check` (format compatibility; see `docs/format-versioning.md`) and `scripts/typecheck.sh` (`tsc --noEmit` against `types/baseline.json`; see `docs/typing.md`). The type check installs the pinned Node and TypeScript under `~/.cache/atrium-ci` on first use.
- A Swift typecheck of `native/macos`, a full universal ad hoc signed build (`scripts/build-mac.sh` into a scratch folder), and `native/tests/*.py`.
- The Windows host cross-built on every push: its shared-core tests (`dotnet run --project native/windows/tests`), then `scripts/build-windows.sh`, which produces the portable zip. The .NET 8 SDK is pinned, checked with SHA-512 and installed in user space by `scripts/ci/install-dotnet.sh`.
- The macOS harness (`native/tests/macos-harness/run.sh`), which needs a logged-in GUI session.
- `scripts/click-through.sh pcb` and `schematic` (warm and cold), and `scripts/perf-canvas.sh`, both in headless Chrome.

**Linux** (`[self-hosted, Linux, ARM64, atrium]`, `scripts/ci-linux.sh`). Every step runs in a
throwaway container built from `scripts/ci/linux.Dockerfile`:

- `ubuntu` image: Ubuntu 24.04 (pinned by digest), Node 24 (pinned, SHA-256 checked), WebKitGTK 4.1, Xvfb, xdotool. Steps:
  - `node`: Standalone CommonJS suites and the native Node suites, with browser suites assigned to the `browser` step.
  - `mcp`, against JavaScriptCore-GTK and Node;
  - `static`, including the type check (TypeScript comes from the image's lockfile install);
  - `native`: Python syntax of everything, an import of the Linux host, `native/tests/*.py`;
  - `webkitgtk`: a web view smoke test, `native/linux/waffle.py` under Xvfb, and the UI probes with real X input (menus, right-click context menus, Ctrl/Alt+click net highlight, dialogs, CSS tokens, `color-mix()`);
  - `deb`: build, inspect, then `dpkg -i` in a fresh root container.
- `browser` image: Debian trixie (pinned by digest) with Chromium, Python 3 and Git. The `browser` step runs reachability, click-through, performance probes, `integration-browser` and `browser-format-2-git`. The browser suites use `playwright-core` from the lockfile. The folder Git suite opens a real Git fixture in Chromium and its exit status directly determines its result.

**Windows** (`[self-hosted, Windows, X64, atrium]`). When `WINDOWS_RUNNER` is `true`, CI sets up .NET 8,
runs the core tests, builds the portable package with `-t:WafflePackage`, and uploads the ZIP.

For an interactive GPU timing run, open **Actions › CI › Run workflow** and select **Measure PCB pan and
zoom on the unlocked Windows test desktop**. This runs the packaged WebView2 app on the public
GargantuRAM and PiDP-11 boards. Keep the monitor on and Waffle in the foreground for this run. Two
untraced trials supply the main-thread timings. A separate dense-board pass records WebView2
compositor feedback. The `waffle-windows-pcb-timing` artifact carries the package identity
and evidence, including measurements that exceeded the budget. The timing step fails when the workload cannot be measured.
Ordinary push and pull-request builds run unattended. [Windows timing runner](../scripts/ci/windows-view-feel.ps1)

On new Windows captures, `callbackFrameWork` reports the same observed main-thread work
grouped by the browser's animation-frame callback labels. Timers, input and other
callbacks stay with their actual start interval. An animation-frame callback whose label
is absent from the observed frames also stays with its start interval. The statistic is
separate from the existing start-interval budget and measures callback work, independent
of compositor feedback. Older receipts omit it.

`terminalWorkAttribution` records the terminal draw, its owning callback and both
intervals charged by these two measurements. Each interval shows other rAF callbacks,
callbacks without an rAF label and standalone draws separately. Work outside the
observed frame intervals is listed separately so totals can be reconciled back to the
recorded callback and standalone draw durations.

### Investigating a slow board view

Run `scripts/perf-view-feel.sh --json` for a repeatable wheel, pan and drag workload. The probe opens the PCB tab and hit-tests the input point before timing. In the GPU zoom results, each burst includes submitted board frames, grid-buffer allocations, memory-probe fences and completed driver-memory checks. The browser and native probes also report `retainedFrames` when available. Subtract it from `frames` to count frames drawn through the full renderer path. Both frame totals stay cumulative across resets of the legacy timing averages. Reading the counters issues no graphics commands. The issue report groups selected counters into ranges for the active PCB.

Compare builds with the same board, viewport, pixel ratio and input sequence. Check that each moves the camera and draws the same frames. Compare the settled images separately from timing because reading pixels can stall the driver. A main-thread draw duration measures work in the editor callback. WebContent CPU time can include other work, and a submitted frame alone cannot establish that the display showed it.

For a saved board on macOS, run `scripts/perf-view-feel.sh --native --bundle <signed-harness.app> --project <manifest.waffle> --display <display-id> --draw-work`. It sends native input, checks the board under the pointer, and reports the first and final stationary frame alongside the moving frames. The detailed output includes per-process CPU and, on builds with text raster counters, the rows and milliseconds spent sharpening the current view or preparing a wider view. Use `--hz 120` on an awake 120 Hz display to check presentation cadence. The default work budget is 8 ms at p95.

### Tracing editor interactions

With Chrome installed, run the three interaction suites against the local editor.

```sh
python3 scripts/prepare-assets.py
npm ci --prefix scripts/ci
NODE_PATH="$PWD/scripts/ci/node_modules" node scripts/perf-interactions.cjs --out /tmp/waffle-interactions
```

Use a fresh output directory or omit `--out` to create a temporary one. Set `CHROME` to select another Chromium executable. Each suite writes a JSON summary and the original compressed Chromium trace (`*.trace.json.gz`). Open the trace in Chrome DevTools Performance or Perfetto. The `waffle.start.` and `waffle.end.` marks bracket each action. The `waffle.input.` marks identify trusted events by surface, device and type. Raw traces can include local browser and project details.

- `--suite canvas` exercises a populated schematic and a drawing with 120 text labels and 120 lines. It checks camera changes at fit and detail zoom, mouse drag, trackpad pan and zoom, wheel notches, keyboard pan, touch pan and pinch, mouse and pen selection, object dragging and keyboard Undo. It also edits and commits a schematic property.
- `--suite notebook` opens a 1,000-row, 50-column notebook table with the table feature enabled in this browser profile. It exercises filter keystrokes and Tab to apply, sorting, formula entry and commit, cell selection and virtual scrolling. It also edits a rich-text note, draws a pressure-sensitive pen stroke and verifies Undo.
- `--suite shell` drives the menus, context menu, project tree, document tabs, command palette, Quick Open, preferences, themes, component catalogue and dock sash. It searches the library and drags a component onto a schematic. It also exercises the schematic bill of materials, 5,000 compiler messages and the Navigator. The checks verify filtered counts, sort order, row navigation and IME composition.
- `--suite manual` opens the schematic project in a visible editor. Use any tools, panels or dialogs in that window and press Enter in the terminal to save the trace. This also captures interactions in lazy-loaded features. Each run uses a fresh browser context.

The summaries include sample counts and p50, p95, p99 and maximum times in milliseconds. `captureDelayMs` measures from the trusted DOM event timestamp to the capture listener. `inputDelayMs` and `eventDurationMs` use Chromium's Event Timing processing start and duration where available. `dispatchMs` measures synchronous event dispatch. For the filter probes, `resultMs` measures from the triggering keydown timestamp until a DOM observer sees the updated count. This includes any debounce. The notebook column filter starts its result measurement at the Tab key that commits the change.

`latencyRecords` counts Chromium EventLatency events by input type. `compositorMs` includes paired records with display feedback in the same interaction window. Several inputs can share a frame or produce no display feedback. `laterFeedback` counts feedback arriving after the measurement window. `presentedIntervalMs` reports the time between distinct frames with presentation feedback during the action, excluding the settling period. It also reflects the rate at which the driver sends input. Measuring physical display latency requires a device measurement.

`workMs` covers layout, style, paint and animation-frame callbacks on the editor thread. `longTasks` counts tasks over 50 ms starting in the window. `callbacks` ranks inclusive callback time and `samples` ranks the nearest application function on sampled stacks. These measurements can overlap. `components` contains the editor's own timing records for each automated action.

### Recording component performance

Open **Help › Troubleshooting › Frame Monitor** and reproduce the operation. The monitor shows the five operations with the longest p95 times. **Crash Diagnostics…** previews the shareable report. The latest capture stays in memory after the monitor closes and is replaced when the next capture starts. A browser test can acquire its own recording lease. Closing the monitor or completing a test releases only that caller’s lease.

Crash Diagnostics keeps six editor failure counts per UTC day for today and the previous six UTC days. The report contains only the combined count ranges. **Clear error counts** resets those counters for windows sharing the same local storage and updates the preview and subsequent copies and saves. On upgrade, the editor counts eligible entries from the previous detailed log once and removes that log. Older totals without dates are discarded because their retention window cannot be determined.

The Demo integration test exercises the production recorder across schematic and PCB edits, routing, library search, design checks, drawing and two browser saves. To keep its exact local JSON for comparison, run the following command with the normal Chromium test dependencies installed.

```sh
node tests/integration-browser.cjs --demo-workflow-only --performance-snapshot waffle-performance.json
```

Other workloads use the same API. Acquire the lease immediately before the action and wait for the result that matters, such as a visible board submission or the native writer’s acknowledgement.

```js
await AtriumLazy.need("AtriumPerformanceDiagnostics");
const capture = AtriumDiagnostics.startPerformance();
try {
  await runWorkload();
} finally {
  capture.stop();
}
const exact = AtriumDiagnostics.performanceSnapshot();
const shareable = AtriumDiagnostics.performanceSnapshot({shareable: true});
```

For a local PCB gesture trace, pass `{rendererStages: true}` to `startPerformance()`. The exact snapshot then includes rows for retained pan, retained zoom and full redraws. Use their run times to distinguish strip repairs, overlay painting, texture-band preparation and drawing. `full-band-paint` measures drawing within `full-text`, which includes lettering and any board artwork sharing those layers. These stages report elapsed wall time on the editor thread. `full-coverage` includes preparation and texture allocation. Its nested `full-coverage-paint` and `full-coverage-upload` rows sum the canvas painting and texture submission work across all pour layers in each full frame. Upload includes synchronous readback and time spent waiting within texture submission. Its nested `full-coverage-readback` measures only the WebKit path's explicit `getImageData` calls and reports zero for direct canvas uploads. For one frame, subtract its readback duration from its upload duration to find the remaining submission time. On an exact frame, `full-airwires` times the synchronous connection-line lookup and `full-draw` times the editor thread issuing the board draw to WebGL. Memory checks and the subsequent overlay are separate from those two measurements. Percentiles describe separate distributions. GPU completion and display presentation require separate probes. The shareable issue report omits the stage rows.

Within `full-text`, `full-text-caption-occlusion` measures the search for copper that can cover pad lettering. `full-text-upload` sums the time spent transferring the text bands for that frame, including the explicit Canvas reads measured by `full-text-readback`. A direct canvas upload reports zero explicit readback. When the renderer reuses the band and its occlusion result, all three stages report zero for that full frame.

After a gesture, `stationary-text-rows` measures each step that sharpens the current camera. `wide-text-rows` measures each step that prepares text outside the current view. Both reuse the scheduler’s elapsed time for painting and transferring a strip of rows, including restoring the visible overlay when needed. Waiting between steps, finding visible items, and the final copper coverage pass fall outside these samples.

On browsers with MessageChannel, `stationary-text-dispatch` measures the time from posting foreground work until the browser enters its message handler. Each completed setup, paint or coverage step contributes one sample. Read this alongside `stationary-text-rows` to distinguish waiting for a task from drawing a strip.

Compare wheel notches and continuous zoom separately. The 2D editor can glide between notches, while pinch and precise Ctrl+wheel packets follow their input directly. Match the board, starting camera, zoom range and pointer anchor, and record the first pass and a warm repeat. A stationary secondary click opens the canvas menu in Select. A secondary drag pans, including with Control held.

With Frame Monitor open, the exact local snapshot can include `frame.wheelTail` for the trusted Ctrl+wheel sample at `wheelToDrawP95`. Its three durations belong to the same input and add up to that total. `stampToHandlerMs` runs from the event timestamp to the wheel handler, `handlerToDrawMs` ends when the first draw of the changed camera begins, and `drawMs` ends when the editor returns from that draw. When several physical notches contribute to one draw, the oldest contributing notch supplies the timestamp. `stampSource` distinguishes a DOM event from a signed notch reconstructed from a coalesced native packet. These measurements end at draw submission. Measuring display latency requires a separate presentation probe.

Both projections use snapshot version 1. Each row has a fixed component and operation, lifetime counts within this capture, and three elapsed times in milliseconds. **Queue** ends when work starts or is withdrawn. **Run** ends when the result is ready, or when execution finishes if it has a single completion point. **End-to-end** includes the wait for delivery. Each p95 uses the latest 128 eligible samples for that row and phase. Missing samples appear as `null` locally. Overlapping calls, worker waits and parent commands can span the same interval, so adding the rows gives a misleading estimate of CPU usage.

| Outcome | Evidence |
| --- | --- |
| Completed | The operation returned, a store accepted the result, or the browser accepted a download. |
| Visible | The renderer submitted a complete view to a foreground editor pane. Physical display timing requires a presentation measurement. |
| Durable | The native writer acknowledged the save. |
| Cancelled or failed | Work was superseded, withdrawn, or ended with an error. Work still in flight at Stop retains its started or queued count. |

The recorder covers editor commands and follow-up work, solver and worker requests, 2D and 3D rendering, design and fabrication checks, routing and pours, library and notebook operations, history and collaboration, project storage, manufacturing, extensions and headless tools. A worker or native request measures elapsed time through the reply. A capture taken with Frame Monitor open also contains its latest two-second frame summary. Use native probes to attribute process CPU, driver work or display timing. The CLI and MCP default to the shareable projection and can return exact measurements for tests. [Headless performance diagnostics](mcp-and-cli.md#performance-diagnostics)

When adding work, use its existing command, scheduler, worker or transaction boundary. A service with its own asynchronous result can call `AtriumDiagnostics.performance?.queue(component, operation)`, `start()`, optionally `ready()`, and `end(outcome)` where work actually changes state. For synchronous work, `span.run(fn, ...args)` preserves the return value and thrown errors. The recorder accepts only fixed component and operation names. Keep identifiers, arguments, paths, and error messages in their owning operation. The shared issue report contains count and duration ranges.

**Release** (`release.yml`):

- On the Mac, generates the worker, extension, locale and other runtime assets, checks freshness and shortcut documentation, then builds:
  - `Waffle-<version>.dmg` (drag to Applications, with a "Read Me First.txt" for the first, unnotarised launch) and its `.sha256`, from `scripts/build-dmg.sh`;
  - `Waffle-<version>-macOS.zip` (universal, ad hoc signed);
  - the cross-built `Waffle-<version>-windows.zip`;
  - `Waffle-<version>-with-sources.zip`, which holds the app, the .deb, the Windows zip and the sources.
- Builds `waffle-eda_<version>_all.deb` in a container on Linux; it is inspected and test-installed.
- Once a Windows runner is on, also builds the Windows package natively, as a verification artifact (`waffle-windows-native`). The release uses the cross-built zip.
- Uploads everything as workflow artifacts (30 days) with SHA-256 sums.
- A GitHub Release is created only from a manual dispatch with `publish: true` and a `tag`. It is created as a **draft**, by a job in the `release` environment, and that job alone gets `contents: write`.
- Developer ID signing and notarisation are not set up; the secret names reserved for them are listed in a comment in `release.yml`.

## Security

**Read this before making the repository public.** GitHub's own guidance is that self-hosted
runners should almost never be used with public repositories. Anyone can open a pull request
from a fork, and a workflow that runs that pull request's code on your runner gives a stranger
code execution on your machine and its network. That code could reach files, credentials and
other hosts, and it could persist between jobs.
See [Security hardening for GitHub Actions: hardening for self-hosted runners](https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners).
Keep self-hosted runners on a public repository only while fork pull-request workflows are
blocked as described below.

What the workflows do:

- **No fork code on self-hosted runners.** Every self-hosted job has
  `if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`,
  so a pull request from a fork is skipped and only branches in the repository itself run.
  Nothing uses `pull_request_target`.
- **Least privilege.** The workflow token is `contents: read` everywhere. Only the release `publish` job gets `contents: write`. Checkout does not persist the token (`persist-credentials: false`), and CI uses no secrets.
- **Pinned dependencies.**
  - Actions (only GitHub's own `checkout`, `upload-artifact` and `download-artifact`) are pinned by full commit SHA.
  - Base images are pinned by digest; Node by version and SHA-256; npm packages by lockfile integrity; the runner download by SHA-256.
  - Not pinned: apt packages come from the distribution's current archive.
- **Isolation on Linux.** Each step runs in a new container that:
  - has no network (`--network none`);
  - runs as the runner user with all capabilities dropped and `no-new-privileges`;
  - has the checkout mounted read-only and prepares the assets in a writable tmpfs copy;
  - has memory and process limits.
  Only the package test runs as root, in its own network-less container.
- **Clean workspaces.** Each job wipes the workspace before and after it runs. Concurrency groups cancel superseded runs, and every job and step has a timeout.

Repository settings to apply:

1. **Settings › Actions › General › Fork pull request workflows.**
   - Private repository: leave **Run workflows from fork pull requests** off.
   - Public repository: choose **Require approval for all outside collaborators**, and only approve after reading the diff. The `if:` gate above already skips forks; approval is a second line of defence.
2. **Settings › Actions › General › Actions permissions.** Choose **Allow OWNER, and select non-OWNER, actions and reusable workflows**, with **Allow actions created by GitHub** only.
3. **Settings › Actions › General › Workflow permissions.** Choose **Read repository contents and packages permissions**, and leave **Allow GitHub Actions to create and approve pull requests** off.
4. **Settings › Environments.** Create `release` and add yourself as a required reviewer, so publishing a draft needs a click. Required reviewers on private repositories need a paid plan; without one the environment still names the job.
5. **Rulesets.**
   - Protect `main`: require pull requests and the status checks `macOS (arm64)` and `Linux (arm64, containers)`.
   - Restrict who can create `v*` tags, because tags start release builds on the runners.
6. **Variables.** Set `WINDOWS_RUNNER=true` only once a Windows runner is registered.

Recommendations:

- Prefer **ephemeral** runners (`--ephemeral`, one job per registration) or **containerised** jobs. The Linux job already runs every step in a container. The macOS job runs directly on the Mac in the runner user's account, so give the runner a dedicated macOS user without access to personal files or keychains if you can.
- Keep the runners on a network segment that cannot reach other machines you care about.
- Never add secrets to CI jobs that run on pull requests.

## Running the CI locally

```sh
scripts/ci-local.sh              # all macOS steps; or name some: scripts/ci-local.sh jsc static
scripts/ci-linux.sh              # all Linux steps on any Docker host (arm64 or x64)
scripts/ci-linux.sh node mcp     # selected steps
```

The JavaScriptCore runner prints a named `SKIP` for suites that need Node, LinkeDOM, or a real browser.
To include the three external Altium fixture suites in a Node run, set `ATRIUM_TEST_FIXTURES` to the
directory containing `Level.Shifter.SchDoc` and `qfsae-0.PcbDoc`. The runner names any missing file.

To change the known failures, edit `tests/known-failures.txt`. A suite listed there that starts
passing is reported as "now passes" so the entry can be removed.

### Checking an installed Debian package

In a disposable Linux container with networking disabled, install the preview package with
`dpkg -i`. Use the same GTK, WebKitGTK 4.1, Xvfb and xdotool dependencies as the Ubuntu CI
image. Run the probe as an unprivileged user.

```sh
dbus-run-session -- xvfb-run -a -s '-screen 0 1380x860x24' \
  python3 native/tests/linux-harness/package.py
```

The probe creates its own project files and settings. It selects files in native GTK
dialogs, edits a schematic, checks what Save and the three close buttons write, and
approves a synthetic external program. Two WebKitGTK windows exchange the project through
the packaged relay in its loopback test configuration. The probe also checks the message
shown by the default relay when a container has no eligible physical interface.

The shared menu, canvas and CSS probes use `UI_APP_DIR` to load the installed editor assets.
Set it to the directory containing the installed `index.html` when running
`native/tests/linux-harness/ui.py` under Xvfb. Use `UI_ONLY` to select groups that use
the available input devices. The shared suite also contains native trackpad and titlebar
checks for the macOS harness.

The macOS WKWebView and Linux WebKitGTK probes share a painted field-text test. It
compares the Inspector, Preferences, Find and Replace, and Footprint Wizard in light and
dark at 1× and 2×. The Linux `webkitgtk` step runs each scale with its own Xvfb screen
and GTK profile. Run the 2× case directly with this command.

```sh
UI_ONLY=field-text GDK_SCALE=2 xvfb-run -a -s '-screen 0 2760x1720x24' \
  python3 native/tests/linux-harness/ui.py redacted-local-path
```

The browser jobs exercise Chromium. The optional Windows job covers host core logic
and packaging. Painted field text in native Windows WebView2 remains unverified.
