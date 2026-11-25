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

The command checks the packages before moving the complete set to `dist/preview-<version>`. Pass a path to use a different new or empty folder. `SHA256SUMS` covers the downloadable packages and the accompanying release notes. The macOS package uses ad hoc signing. This command runs locally.

The package version comes from `app/VERSION`. When updating it, update the browser and native metadata mirrors and run `python3 scripts/release-version.py --check`. About and the disk image’s Read Me First show the full release name. For Butter Official, `--name` returns `Butter`, `--flavour` selects Butter artwork and `--notes` selects the formal release notes.

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

## What runs where

**macOS** (`[self-hosted, macOS, ARM64, atrium]`, `scripts/ci-local.sh`):

- JS suites under JavaScriptCore (`scripts/test-jsc.sh`). Only failures not listed in `tests/known-failures.txt` fail the job.
- `tests/mcp.py`, `mcp_runner.py`, `headless-parity.py`, `eco-e2e.py`.
- Rust/WebAssembly kernels (`rust` step): `cargo test`, then `scripts/build-engine.py --check` (app/engine-core.js must equal a fresh, reproducible build), then `tests/engine.cjs`, `engine-pour.cjs`, `drc-equivalence.cjs` and `connectivity.cjs` under JavaScriptCore with `ATRIUM_ENGINE=wasm` and `=js`. The pinned toolchain is installed under `~/.cache/atrium-rust` on first use (`scripts/ci/install-rust.sh`, rustup-init checked by SHA-256). On Linux the `rust` step runs `cargo test` and the same `--check` in the pinned `rust` image with no network.
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
