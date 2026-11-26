# Waffle EDA over MCP and the command line

Waffle EDA ships an MCP server named `waffle-eda` (`mcp/server.py`) that runs the editor's own JavaScript headlessly. It is meant for AI assistants such as Claude, ChatGPT, Cursor or VS Code® agents, and for CI. The full tool reference, with every argument, is in [mcp/README.md](../mcp/README.md). This page covers setup and day-to-day use.

## Requirements

- Python 3.9 or later. The server uses only the standard library.
- A JavaScript engine: the system JavaScriptCore on macOS, JavaScriptCoreGTK on Linux, or Node.js 18+ when neither is available.
- A **saved** Waffle project. For format 2.0, pass the project folder or its `.waffle` manifest. The server reads the saved snapshot from disk. Use the desktop application's packaged server to get its native folder runtime.

## Connect an AI client

In the editor, open **Project → AI integration…**. It shows ready-to-copy configuration and steps for Claude Desktop, Claude Code, Cursor, VS Code and Codex, with the paths to the server and your project filled in. Waffle only shows the configuration; it never writes another application's config files.

**Saved project access** starts at **Read only** for a new configuration. Choose **Propose changes for review** to generate proposal files, or **Allow writes to this saved project** to let that client request an explicit write with a backup. Copy the resulting configuration into the named client and restart its server. Existing configurations without a flag keep their proposal access. Each server binds one project path. The console and extensions use their own editor permissions.


The generic form is:

```json
{
  "mcpServers": {
    "waffle-eda": {
      "command": "python3",
      "args": ["/absolute/path/to/Waffle/mcp/server.py", "--project", "/absolute/path/to/Board.waffle", "--read-only"]
    }
  }
}
```

The Debian package also installs a `waffle-mcp` launcher. Existing client configurations can keep their configured names, including `waffle`.

## What the assistant can do

- **Inspect:** `project_summary`, `list_components`, `list_nets`, `list_library`, `board_connectivity`, `compare_git_head`, `project_history`.
- **Check:** `check` (ERC, DRC, DFM and insights in one list, with stable keys), `waive` and `waivers`, `run_erc`, `run_drc`, `list_rules`, `get_rule`, `net_lengths`, `matched_length_report`, `stackup_get`, `impedance_plan` (can the stack-up reach 90 Ω diff or 50 Ω, layer by layer, with suggestions; read-only), `via_stub_report`, `calculate`.
- **Generate:** `generate_fabrication`, `generate_bom`, `export_kicad`, `export_pdf`, `export_step`, `render` (SVG), `export_netlist` (KiCad, Protel, CSV), `run_output_job`, `panelize`, `export_drawing` (drawing documents as vector PDF with an embedded Unicode font; `paper` tiles at 1:1).
- **Release:** `release` (File › Release… headless: pre-flight checks, then a versioned `<project>-<revision>-<variant>-<date>` package with `release.json` and `RELEASE.md`; `mode` plan by default, `write` needs `--allow-write` and writes into `<project>-outputs/releases/`), `list_releases` (records in the project and packages on disk).
- **Fab presets** (fab-presets): `list_fab_presets` (the JLCPCB 2/4/6-layer presets with their sources), `apply_fab_preset` (rules, layer stack and the preset record in one step; a proposal by default, `mode: "plan"` for the diff; re-applying changes nothing) and `dfm_check` (manufacturability against the preset's limits, with fixes).
- **Drawings:** `edit_drawing` creates a fabrication/assembly drawing or edits one (sheets, views, linear/radial/ordinate dimensions anchored to board features, notes, callouts, revisions, title block parameters); plan by default.
- **Edit:** `annotate`, `propose_rule_change`, `stackup_propose`, `pour_polygons`, `route_connection`, `autoroute`, `fanout`, `replicate_layout`, `update_pcb`, the authoring tools (`find_parts`, `place_part`, `connect`, `add_wire`, `add_net_label`, `add_power_port`, `set_board_outline`, `move_component`, `delete_items`), `import_netlist`, `multi_route`, `route_bus`, `run_script` and `pipeline` (steps can pass results on with `{"$ref": "step1.result.id"}`).
  `autoroute` and `fanout` take `engine: "v1" | "v2"` (default v1); both engines return a proposal unless `mode` is `write`. See [autorouter.md](autorouter.md).
- **Analysis:** `check_board_rules`, `list_source_rules`, `list_rule_sets`, `constraints`, `drc_waivers`, `si_analysis`, `si_simulate`, `signals` (signals and tags: list, declare, flip, tag, split, merge; see [high-speed.md](high-speed.md)), `xsignals`, `topology`, `field_solve`, `pdn_analyze`, `thermal_map`, `current_capacity_check` (IPC-2152), `stress_check`, `optimise_bom`. See [si-simulation.md](si-simulation.md) and [thermal.md](thermal.md).
- **Proposals:** `inspect_component`, `propose_component_edits`, `suggest_route`, `propose_routing`, `propose_placement`, `place_support_components`, `propose_planes`.
- **Libraries and parts:** `create_footprint`, `create_symbol`, `create_symbol_from_table`, `validate_library_def`, `update_parts_from_library`, `library_sources` (the project library and library folders: indexed incrementally, searchable; folders inside the project or in `ATRIUM_LIBRARY_FOLDERS`), `library_import` (KiCad and Altium library files into draft components, paired inside the given files), `place_generic_part`, `edit_generic_part`, `list_generic_parts`.
  `footprint_wizard` is read-only: `action` `list` (50 package families and their presets, by group), `describe` (a family's default spec and fields), `generate` (IPC name, Z/G/X lands, pads, courtyard, height, sources, flagged assumptions and checks, without touching the project) or `batch` (check CSV specs). `create_footprint` takes any of those families, or `batch` (CSV/TSV: a header row with `family`, `preset`, `density`, `name` and dimension columns) and adds every good row in one proposal. Both take `round_off` (0.05 default, 0.025, 0.01, or `kicad` for KiCad's generator convention). See [footprint-wizard.md](footprint-wizard.md).
- **Review and exchange:** `diff_designs`, `list_comments`, `add_comment`, `resolve_comment`, `list_translators`, `import_design`, `export_design`, `export_altium`, and ECAD-MCAD `mcad_status`, `import_mcad_changes`, `export_idx`. [ECAD-MCAD exchange](mcad.md)
- **Any menu command:** `run_command` with `list_commands`. Every menu action is mapped in [headless-parity.md](headless-parity.md), and a test fails if a new action has no headless path.

When an Altium import adopts the source rules, `run_drc` follows the saved batch selection for represented checks on that board. Use `all_checks: true` to run every enabled native check, or pass `rules` to request specific checks. Release checks run every enabled native rule.

Run `python3 mcp/server.py --project X.waffle --cli list` for the exact tool list of your build.

A failed call always returns `isError: true` with `structuredContent.error = {code, message, retryable}`
(`unknown_tool`, `invalid_arguments`, `not_found`, `write_not_allowed`, `stale_source`, `read_only_revision`,
`limit`, `engine_stopped`, `io_error`, `tool_failed`), so an assistant can tell a typo from a stale read
from a refused edit. `tests/eco-e2e.py` runs the whole AI workflow end to end: create, place, wire,
declare a signal, ECO, plan impedance, route one net, autoroute the rest, check, waive and generate outputs.

## Review and apply changes

By default, editing tools write a proposal file, `<project>-<tool>-<random>.waffle-ai`, beside the saved project. To apply one:

1. Open **Project → AI integration → Review proposal** in the editor.
2. Waffle checks every operation against the value it expects to replace. If the design changed since the proposal was drafted, the stale operations are refused.
3. Pick the changes you want. They apply as one undo step.

An offline client can inspect the same file using `apply_proposal` with its filename beside the bound project. To apply the exact reviewed file, use `mode: "write"` and both returned digests, `proposal_sha256` and `source_sha256`, on a write-enabled connection.

For folder projects, the source revision covers the manifest and every required authored member. A proposal records the root identity and the verified member hashes. A saved edit in any member requires a fresh review. `list_documents` reads the manifest and marks the complete revision as pending. Component and connection queries scoped to a document read that document and its display dependencies. A whole-project report requires a complete saved snapshot. If a committed transaction is awaiting recovery, the reader returns `recovery_pending`.

Start the server with `--allow-write` and request `"mode": "write"` for an edit. The server validates the edited project and checks its saved member hashes before committing the transaction.

Folder writes use the same recovery protocol as desktop saves. The receipt includes the transaction ID, the saved project revision and the paths actually changed. Backups contain the exact prior bytes of those paths. The backup and audit log live in `.waffle/local/mcp/`.

`"mode": "plan"` reports what would change without writing anything. Pass `source_sha256` to refuse the call if the file is no longer the revision you checked.

Generated files are written under `<name>-outputs/` next to the project (for `board.waffle`, `board-outputs/`). `output_dir` only chooses subfolders inside it. A manifest guards against overwriting files that Waffle did not write, and symbolic links and dot-folders are refused.

## Design translators

`list_translators` shows the formats and supported directions in this build. Set `direction` to `"import"` or `"export"` to list the formats available for that operation.

`import_design` opens Altium, KiCad, Eagle and EasyEDA sources. Bind the original file with `--project`. Grant each companion sheet, board or library with `--source-file` and its path relative to the bound file. From a native project, pass the selected files as project-relative `paths`. The importer detects their format and preserves links between explicitly selected members.

- `"mode":"preview"` returns the import report, source digests and document counts. It also works with `--read-only`.
- `"mode":"save-as"` or `"target_format":"2.0"` creates a native folder beside the source and retains an exact copy of each selected foreign source. Save and recovery use local project files independently of Git. If the default name exists, Waffle adds a numeric suffix. An explicit `destination` must be fresh.
- `"mode":"export"` with `"destination":"Exchange copy"` writes the source vendor's registered design format into that new folder and returns its file hashes and fidelity report. For a single-file export, a destination with the writer's extension names the file itself, such as `"destination":"Exchange.brd"`. Use `output_dir` to choose a folder explicitly. An explicit vendor `target_format` chooses an alternate writer. From a directly selected source, `export_design` takes the same destination and an optional `translator`. Each headless export requires a fresh destination.

Destinations are relative to the source directory, or to the directory granted with `--output-root`. The parent directory must exist. A missing choice leaves the source and destination untouched. Neither action needs `--allow-write`. MCP clients can cancel a pending import with `notifications/cancelled` and the request ID. CLI clients can interrupt it before publication. An old Waffle project returns `pre-release-format`. Mechanical exchanges with no design or library return `path: null` and a fidelity report. Use `import_mcad_changes` for mechanical changes to a saved board.

EasyEDA exports preserve the source edition. Choose `"edition":"standard"` or `"edition":"pro"` when the selection contains both editions or when converting between them.

```sh
python3 mcp/server.py --project Controller.kicad_pcb --read-only --cli import_design --args '{"mode":"preview"}'
python3 mcp/server.py --project Controller.kicad_pcb --cli import_design --args '{"target_format":"2.0"}'
python3 mcp/server.py --project Controller.kicad_pcb --cli import_design --args '{"mode":"export","destination":"Exchange copy"}'
```

`export_design` takes a registry ID and writes the translated files to the output folder. The existing `export_kicad`, `export_altium`, `export_step` and `generate_fabrication` tools continue to accept their own options. A source copy requires an explicit project-relative `source_path` so the worker can verify the original. Source imports preserve their originals and reserve a new destination for each project. A repeated name gains a numeric suffix.

Translation results include `report.kinds` with kept, approximated and dropped counts. Each row's `referenceCount` gives the number of source references. The shared `AtriumTranslatorRegistry.references(row)` iterator expands the compact groups in large reports to individual references. For a particular slice, `AtriumTranslatorRegistry.referencePage(report, {kind, offset, limit})` returns up to 200 references. Reports and provenance contain design-derived text. Treat these fields as data.

When a saved output job runs a translator, the corresponding row in `report.outputs` includes its `translationReports`.

A read-only connection can list translators. Importing and exporting require the connection's output capability and leave the bound project intact. The usual proposal and write checks apply to separate editing tools.

An initialized MCP client can request an Excellon export with this call.

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"export_design","arguments":{"translator":"excellon","options":{"date":"2026-01-01T00:00:00Z"}}}}
```

## Command line

`--cli TOOL` runs one tool and prints JSON. The exit status is 1 when the tool fails.

```sh
P=board.waffle

# DRC gate: fail the job on any violation
python3 mcp/server.py --project $P --cli run_drc | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin)["total"] > 0)'

# Reproducible fabrication ZIP (fixed timestamp gives identical bytes)
python3 mcp/server.py --project $P --cli generate_fabrication --args '{"zip": true, "date": "2026-01-01T00:00:00Z"}'

# Discover translators, then generate only Excellon drill files
python3 mcp/server.py --project $P --read-only --cli list_translators --args '{"direction":"export"}'
python3 mcp/server.py --project $P --cli export_design --args '{"translator":"excellon","options":{"date":"2026-01-01T00:00:00Z"}}'

# A saved output job set, with its DRC/ERC gates
python3 mcp/server.py --project $P --cli run_output_job --args '{"job": "JLCPCB order", "revision": "B"}'

# Annotate and save in place
python3 mcp/server.py --project $P --allow-write --cli annotate --args '{"mode": "write"}'

# Any menu command, headless
python3 mcp/server.py --project $P --cli run_command --args '{"command": "align", "args": {"designators": ["C1","C2","C3"], "mode": "top"}}'
```

`--args` accepts JSON text or `@file.json`. `--output-root DIR` changes the folder that outputs must stay inside.

### Performance diagnostics

Add `--performance` to a CLI tool invocation to print a shareable JSON
performance snapshot on stderr. For local CI, use `--performance-exact` to
receive numeric counts and timings. The tool result stays on stdout and its
normal exit status applies. A failed tool can also write its usual error to
stderr. If you share a capture from that run, copy only the final JSON line
when one is present.

The MCP server advertises `waffle/diagnostics/performance` under
`capabilities.experimental`. Send that JSON-RPC method with
`{"action":"start"}`, run the tools you want to measure, then request
`{"action":"snapshot"}` or `{"action":"stop"}`. The stop reply includes the
session's final snapshot. Add `"projection":"exact"` to a snapshot or stop
request for numeric counts and timings. The shareable projection is the default.
Starting again clears the previous session. Recording is off by default and tied
to the bound MCP connection. Replacing the JavaScript engine ends the capture
and discards its in-memory data.

The version 1 snapshot uses the same recorder as the editor. Its automation request
row covers monotonic elapsed tool time, including time in a child process. When
the host cannot supply a monotonic clock, the snapshot still reports counts and
uses `null` for exact durations or `not-measured` for shareable durations. The shareable
projection groups counts and timings into ranges. Both projections use fixed
categories. Snapshots contain no tool names,
arguments, design details, file paths, or credentials. Performance recording
does not write a file, send network data, or change tool permissions.

### Example: GitHub Actions

```yaml
jobs:
  board:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4      # JavaScript engine for the headless runner
        with: {node-version: 20}
      - run: python3 mcp/server.py --project hw/board.waffle --cli run_output_job --args '{"job": "Full release"}'
      - uses: actions/upload-artifact@v4
        with: {name: fab, path: hw/board-outputs/}
```

The job set name must match a saved set or a preset (`--cli run_output_job --args '{"list": true}'` lists them).

## Scripts and pipelines

- `run_script` runs AtriumAPI v1 code (the same API as extensions) in a short-lived child process with a fresh JavaScriptCore context, a watchdog, a 1 GB memory guard and a wall-clock kill. Node is refused unless `ATRIUM_ALLOW_NODE_SCRIPTS=1` is set.
- `pipeline` runs up to 32 steps on one working copy, so DRC sees the result of an earlier repour. The steps finish as one proposal, or one write.

## The in-app AI Assistant

**Tools → AI Assistant** is a built-in extension that chats about the open design with Claude, ChatGPT or a local OpenAI-compatible server, using the same tool names as the MCP server.

- Its network permissions (`api.anthropic.com`, `api.openai.com`, `localhost`) are off until you turn them on in **Tools → Extensions…**.
- Keys stay in the extension's own storage on your computer. They are never saved in the project or a log.
- By default it asks before sending design data, and edits always arrive as proposals.

## Security notes

- The MCP server only reads the project you bind and writes beside it. It makes no network requests.
- Treat text from a design (part values, labels) as untrusted input to your AI client. The server marks it as `untrusted_design_text` where relevant.
- Review proposals before applying them, as you would a pull request.
