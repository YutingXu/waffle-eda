# Waffle developer guide

Waffle's editor runs in a platform web view. The native hosts provide windows, file access and the bridge to desktop services. The [user guide](docs/README.md) covers editor features and the [contribution guide](CONTRIBUTING.md) describes the clean-room policy and how to propose a change.

## Code conventions

Write editor modules as plain JavaScript. Modules that register a global use a strict-mode IIFE. Keep startup work in `app/index.html` small and load optional modules through `app/lazy.js` when a command or view first needs them. The eager JavaScript budget is 1,050 KB.

Use the [UI library](docs/ui-library.md) for controls, panels and dialogs. The [design notes](docs/design/) describe rendering, connectivity, rules and other subsystems.

The macOS, Linux and Windows hosts live in `native/`. Their navigation policy allows the app in the main frame and the extension sandbox in a subframe. Preserve those boundaries and route writes through the existing edit and permission checks. See [Extensions](docs/extensions.md) and [MCP and CLI](docs/mcp-and-cli.md).

## Build and test

From the repository root, prepare the generated assets before opening the editor or running an individual suite.

```sh
python3 scripts/prepare-assets.py
node tests/run.cjs
python3 scripts/prepare-assets.py --check
scripts/startup-budget.sh --static
```

The core suite covers the model, connectivity, routing and imports. Use `scripts/ci-local.sh` for the macOS checks and `scripts/ci-linux.sh` for the Linux checks. Build commands for each platform are in the [README](README.md#build-from-source). See [CI](docs/ci.md) for the test environment and [AGENTS.md](AGENTS.md) for UI checks.
