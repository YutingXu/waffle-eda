# Waffle EDA user guide

| Guide | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Install, the start page, and a first board from schematic to Gerbers |
| [Release codenames](releases.md) | Release names, highlights and compatibility |
| [Butter release notes](release-notes.md) | What’s new in Waffle EDA 0.8.0 and installing it on macOS, Windows and Linux |
| [Preview notes](preview-notes.md) | Installing Waffle EDA 0.7.0 Apricot Preview, keeping a complete 2.0 folder, Experimental features and measured limits |
| [Windows](windows.md) | Installing and building on Windows, its keys, and what the Windows host does and does not do |
| [Footprint wizard](footprint-wizard.md) | The IPC-7351B footprint wizard: 50 package families, density levels, presets, batch generation, sources and limits |
| [Sourcing](sourcing.md) | How part numbers and supplier data get into the BOM offline; Waffle never invents MPNs |
| [Keyboard shortcuts](shortcuts.md) | Every bound command for the Altium-style, KiCad-like and VS Code-like presets (generated) |
| [MCP and command line](mcp-and-cli.md) | Connecting an AI client, proposals, `--allow-write`, CI recipes |
| [Extensions](extensions.md) | Writing, permissions, testing and publishing a sandboxed extension |
| [Theming](theming.md) | Presets, accent, density, theme JSON, VS Code® theme and keybinding import |
| [Importing from other tools](importing.md) | Altium®, KiCad, Eagle and EasyEDA designs, DXF, rules; exporting back |
| [Extension registry](extension-registry.md) | Browse Extensions, the index format, publishing an extension, and the security model |
| [VS Code extension](../integrations/vscode/README.md) | Preview `.waffle` files, DRC/ERC in the Problems panel, outputs, schema validation, change summaries |
| [Upgrading Waffle](upgrading.md) | Native 2.0 projects, preserving designs and settings, opt-in update checks and rollback |
| [Format versioning](format-versioning.md) | Native project versions, the compatibility policy and format checks |
| [Headless parity](headless-parity.md) | Every menu action and its MCP/CLI equivalent (generated) |

## Design notes

These notes describe the architecture and the original design proposals. See the guides above for current commands and supported workflows.

| Note | What it covers |
| --- | --- |
| [Differential pairs and xSignals in Altium](design/altium-pairs-xsignals-format.md) | Observed binary records and interchange semantics |
| [Collaboration transports](design/collaboration-transports.md) | Relay, direct connections and fallback |
| [GPU board renderer](design/gpu-renderer.md) | Rendering architecture, memory and fallback |
| [Schematic impedance directives](design/impedance-directives.md) | Impedance intent, routing constraints and interchange |
| [Library management](design/library-management.md) | Component identity, folder storage and revision review |
| [Net name intent](design/net-intent.md) | Signal recognition and naming conventions |
| [Signal model](design/signal-model.md) | Nets, signals, pairs and classes |
| [Generic SPICE models](design/spice-models.md) | Model provenance and simulation fallbacks |
| [Unified rules and checks](design/unified-rules-and-checks.md) | Shared schematic and PCB rule architecture |

Reference material lives beside the code: [mcp/README.md](../mcp/README.md) (every MCP tool and argument) and [extensions/README.md](../extensions/README.md) (AtriumAPI v1 and the threat model).

To regenerate the generated pages:

```sh
python3 scripts/gen-shortcuts.py        # docs/shortcuts.md from app/editor/keymap.js
python3 scripts/headless-inventory.py   # docs/headless-parity.md
```
