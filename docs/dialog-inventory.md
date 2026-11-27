# Dialog inventory

Each row names the source that owns the surface. Several workflow outcomes can use the same construction site. The **Sites** column counts code or markup locations, including the shared constructors.

Modal forms can submit with Enter where the workflow supplies a default action. Modeless dialogs and anchored popovers keep the canvas available. Confirmations and action footers use the platform’s button order. Find and Replace and Panelize keep their commands grouped in workflow order. OS-owned alerts and file pickers keep their host layouts and keyboard conventions.

Design Rule Check results appear in the Messages dock. The Dock surface inventory covers that panel.

## Dialog and popover construction

| Source | Kind | Sites | Surface |
| --- | --- | ---: | --- |
| app/editor/about.js | modal | 1 | About Waffle EDA and Licenses and notices |
| app/automation/ai.js | modal | 1 | AI integration and proposed edit review |
| app/formats/altium-project-export.js | modal | 1 | Export Altium project |
| app/notebook/annotate.js | modal | 1 | Annotate schematics |
| app/pcb/autoplace.js | modal | 1 | Auto Place proposal and Plan Power Planes |
| app/pcb/autorouter.js | modal | 1 | Autorouter |
| app/schematic/blocks.js | modal | 1 | Layout blocks, Save layout block and Place layout block |
| app/pcb/board-shape-ui.js | modal | 2 | Board Shape and Board perimeter |
| app/formats/bom.js | modal | 1 | Bill of Materials |
| app/pcb/bus-route.js | modal | 1 | Interactive bus routing |
| app/notebook/calculation-sheet.js | modal | 1 | Apply calculation to a part, Place calculation and Edit calculation |
| app/history/clip-history.js | modal | 1 | Clipboard history |
| app/project/collab-presence.js | modal | 2 | People here, Collaboration, save before joining, local network access, Live Session and host restore progress |
| app/editor/command-bar.js | modeless | 1 | Coordinate entry |
| app/pcb/component-classes.js | modal | 1 | Component Classes |
| app/library/component-swap.js | modal | 1 | Swap component, library replacement and variant picker |
| app/checks/constraints.js | modeless | 1 | Constraint Manager |
| app/notebook/datasheet-reader.js | popover | 1 | Datasheet snip preview |
| app/history/design-review.js | modal | 1 | Board connectivity and Export Design |
| app/history/diff-view.js | modal | 2 | Compare picker and stale comparison review |
| app/history/diff-view.js | popover | 1 | Comparison display options |
| app/formats/drawing.js | modal | 1 | New drawing, drawing view or table, and place or edit drawing text |
| app/checks/drc-fixes.js | popover | 1 | Suggested fixes |
| app/schematic/dynamic-symbol.js | modal | 1 | Dynamic Connector Pins |
| app/schematic/eco.js | modal | 1 | Update PCB, Update Schematics, Sync Settings and ECO file review |
| app/project/editor-files.js | modal | 1 | Import report, text prompt and file compatibility confirmation |
| app/editor/editor-key-dialogs.js | modal | 1 | Grid picker |
| app/checks/erc.js | modal | 1 | Project options |
| app/extension-host/extension-dev.js | modal | 1 | Set up an extension development server |
| app/extension-host/extension-dev.js | modeless | 1 | Extension development console |
| app/extension-host/extension-registry.js | modal | 1 | Extension gallery |
| app/extension-host/extensions.js | modal | 2 | Extension UI prompts and extension manager |
| app/extension-host/extensions.js | modeless | 1 | Extension-contributed dialogs |
| app/formats/fab-outputs.js | modal | 1 | Fabrication outputs |
| app/formats/fab-presets.js | modal | 1 | Fab preset |
| app/formats/fab-profiles.js | modal | 1 | Fab profiles |
| app/pcb/fanout.js | modal | 1 | Fanout |
| app/editor/find-replace.js | modeless | 1 | Find and Replace Text |
| app/project/foreign-draft-ui.js | modal | 1 | Close or restore a foreign project draft |
| app/history/git-picker.js | modal | 2 | Choose a revision and set up the Waffle merge driver |
| app/pcb/hdi.js | modal | 1 | HDI Via Setup |
| app/history/history-panel.js | modal | 2 | Restore a version and Restore for everyone |
| app/workers/import-worker-client.js | modal | 1 | Choose design files |
| app/canvas/input-diagnostics.js | modeless | 1 | Input Diagnostics (Help › Troubleshooting) |
| app/index.html | modal | 2 | Command palette in palette.js and Component library in editor.js |
| app/checks/insights-ui.js | popover | 1 | Insight details |
| app/editor/find-similar-dialog.js | modal | 1 | Find Similar Objects on boards and schematics |
| app/editor/keymap-editor.js | modal | 1 | Keyboard shortcuts editor |
| app/pcb/layer-sets.js | modal | 1 | Layer sets |
| app/pcb/length-tuning.js | modal | 2 | Length properties and Length tuning |
| app/library/library-editor.js | modal | 1 | New component |
| app/library/library-panel.js | factory | 2 | Editors, wizards, library sources and component management listed below, and the Symbol and Footprint Editor tabs (a non-modal dialog in a document view) |
| app/library/library-ui.js | popover | 1 | Library parameter filters (the Library panel and the Library tab) |
| app/editor/logo-creator.js | modal | 1 | Logo Creator |
| app/notebook/math-editor.js | modal | 1 | Insert or edit an equation |
| app/formats/mcad-panel.js | modal | 1 | Mechanical collaboration prompts |
| app/history/merge-ui.js | modal | 2 | Resolve merge conflicts and conflict load error |
| app/schematic/multichannel.js | modal | 1 | Multichannel Manager and Copy Room Formats |
| app/notebook/notebook-image-ui.js | modal | 1 | Image or PDF region selection and Edit image |
| app/pcb/panel-ui.js | modeless | 1 | Panelize |
| app/editor/paste-special.js | modal | 1 | Paste Special and Paste Array |
| app/pcb/pcb-draw.js | modal | 1 | PCB placement properties |
| app/pcb/pcb-edit.js | modal | 1 | Locked objects |
| app/pcb/pcb-selection-inspector.js | modal | 1 | Design rule checks |
| app/pcb/pcb-selection-inspector.js | popover | 1 | Snap options |
| app/analysis/pdn-view.js | modeless | 1 | PDN Analyzer |
| app/pcb/pin-swap.js | modeless | 1 | Automatic Net/Pin Optimizer |
| app/pcb/polygon-pour.js | modal | 1 | Polygon Pour |
| app/editor/prefs.js | modeless | 1 | Preferences |
| app/formats/print.js | modal | 1 | Print and Export PDF |
| app/formats/print-report.js | modal | 1 | Print and Export PDF for reports (BOM, Messages, comparison) |
| app/project/project-archive-ui.js | modal | 2 | Archive and project file selection |
| app/native-bridge/project-windows.js | modal | 1 | Project window location |
| app/project/recover.js | modal | 1 | Recover unsaved work, Recover and Crash Diagnostics |
| app/library/related-parts.js | modal | 1 | Related components |
| app/formats/release-ui.js | modal | 1 | Release |
| app/history/review-annotate.js | popover | 1 | Add comment on canvas |
| app/history/review-comments.js | modal | 1 | Add Comment to a review |
| app/history/revision-panel.js | modal | 1 | Change table |
| app/project/revisions-ui.js | modal | 2 | Project Revisions and revision picker |
| app/checks/rule-sets.js | modal | 1 | Design rule sets |
| app/checks/rules.js | modal | 1 | Rules and Constraints Editor |
| app/schematic/sch-object-forms.js | modal | 1 | Place sheet symbol and Add sheet entry |
| app/schematic/sch-place.js | popover | 1 | Placement properties when a dock is unavailable |
| app/automation/scripting.js | modal | 1 | Save script |
| app/editor/selection-memory.js | popover | 1 | Selection Memory |
| app/notebook/sheet-widget-editor.js | modal | 1 | Edit sheet widget |
| app/analysis/si.js | modeless | 1 | Signal Integrity Analyzer |
| app/pcb/stackup.js | modal | 1 | Layer Stack Manager |
| app/editor/start-page.js | modal | 1 | New project and project templates |
| app/formats/step-export.js | modal | 1 | Export 3D model |
| app/analysis/stress.js | modal | 1 | Component Stress |
| app/editor/support-placement.js | popover | 1 | Support component placement |
| app/library/symbols.js | modal | 1 | Symbol styles and skipped mappings report |
| app/notebook/table-editor.js | modal | 1 | Edit full table |
| app/pcb/teardrops.js | modal | 1 | Teardrops |
| app/editor/theme-editor.js | modal | 1 | Theme editor and customization |
| app/editor/theme-picker.js | modal | 1 | Quick theme picker |
| app/analysis/thermal-view.js | modeless | 1 | Thermal Analyzer |
| app/ui/dialog.js | factory | 1 | Shared dialog builder for the shell workflows listed below |
| app/project/variants.js | modal | 1 | Variants |
| app/pcb/via-fence.js | modeless | 1 | Via fencing |
| app/pcb/via-stubs.js | modal | 1 | Via stub report |
| app/pcb/viastack.js | modal | 2 | Via stack and Via templates |
| app/project/view-config.js | popover | 1 | View Configuration |
| app/canvas/view3d.js | popover | 1 | 3D view options |
| app/history/visual-history.js | modal | 1 | Create Git branch from a selected commit |
| app/editor/vscode-keys.js | modal | 1 | Import VS Code keybindings |
| app/editor/vscode-theme.js | modal | 1 | Import VS Code theme and Theme capabilities |
| app/pcb/xsignals.js | modal | 1 | xSignals Wizard |

## Shared shell workflows

| Source | Kind | Sites | Surface |
| --- | --- | ---: | --- |
| app/schematic/altium-tools.js | shell | 1 | Align Objects |
| app/automation/ai-ui.js | shell | 2 | Ask AI: clear activity and forget a provider key |
| app/editor/workspace-tools.js | shell | 1 | Review changes, shared by AI suggestions and macro replays |
| app/project/links-ui.js | shell | 4 | Links: target picker, remove link, broken link and open link |
| app/automation/macros-ui.js | shell | 4 | Macros: delete, import, run parameters and export |
| app/checks/query-ui.js | shell | 2 | Query: save or rename a saved group and delete it |
| app/native-bridge/window-commands-ui.js | shell | 2 | Windows (butter.windows) and Pending edit review |
| app/editor/context-menu.js | shell | 2 | Save before closing a project and DRC rule explanation |
| app/notebook/datasheet-reader.js | shell | 2 | Download a datasheet and Embed a datasheet |
| app/project/doc-tabs.js | shell | 1 | Save before closing one or more document tabs |
| app/editor/dock.js | shell | 3 | Save current layout, Workspace layouts and Move panel |
| app/checks/drc-inspector.js | shell | 1 | Waive Problem |
| app/checks/drc-waivers.js | shell | 2 | Waive Violation and DRC Waivers |
| app/editor/drop-ui.js | shell | 1 | Approve drop (butter.drop): large files and STEP models that change a shared footprint |
| app/project/folder-project-ui.js | shell | 2 | Private draft recovery, missing or externally changed files, dependent saves and saved conflict review |
| app/history/git-picker.js | shell | 2 | Commit staged project files and retry a comparison |
| app/history/history-entry.js | shell | 1 | Retry opening History |
| app/history/history-view.js | shell | 1 | Create Git branch at a commit |
| app/formats/import-save-view.js | shell | 1 | First Save for imported Altium, KiCad, EAGLE and EasyEDA designs |
| app/project/native-member-ui.js | shell | 1 | Standalone library component details and editing |
| app/editor/prefs-controls.js | shell | 2 | Confirm Restore Defaults and enable selected settings from imports |
| app/project/project-connections.js | shell | 1 | Project connections |
| app/formats/release-odb.js | shell | 1 | ODB++ fidelity report (butter.odb) |
| app/analysis/sim-menu.js | shell | 1 | Simulate |
| app/editor/start-page.js | shell | 1 | Offline Getting started guide |
| app/editor/update-check.js | shell | 1 | Check for Updates |
| app/editor/whats-new.js | shell | 1 | What’s New |

## Library dialog workflows

| Source | Kind | Sites | Surface |
| --- | --- | ---: | --- |
| app/library/footprint-wizard.js | library | 2 | IPC-7351B Footprint Wizard and Batch Footprints |
| app/library/generic-parts-ui.js | library | 5 | Place Generic Component, Connector Generator or Edit Connector, Bind Manufacturer Part, Finalise Part and Add Part |
| app/library/group-library-ui.js | library | 4 | Propose component revision, Propose naming changes, review or restore group changes, and Group library |
| app/library/library-diff.js | library | 1 | Review library updates |
| app/library/library-panel.js | library | 7 | Symbol Editor and Footprint Editor (as dialogs, through editorSurface), update placed parts, check a library file or project, manage family memberships, Save to a library and Library sources |
| app/library/library-sources-ui.js | library | 4 | Save to folder, KiCad 3D model folders, Import library components and Get KiCad libraries |
| app/library/placeholder-ui.js | library | 3 | Place Placeholder and Resolve Placeholder or review the replacement |
| app/library/symbol-wizard.js | library | 1 | Symbol Wizard |

## System-owned prompts and pickers

Native alerts, save/open/directory pickers, WebView confirmation and file input choosers are presented by the operating system or browser. They include the desktop Save/Don't Save/Cancel sheet, project and attachment pickers, stale-source decisions, recovery and hang prompts, and external-tool location dialogs. Browser confirmation calls cover the existing discard, delete, and reset questions in the release, symbol, footprint, library, shortcut, recovery, and layer-stack editors.

The native owners are [macOS main](../native/macos/main.swift), [Linux host](../native/linux/waffle.py), [Windows host](../native/windows/src/Win/MainWindow.cs), and [Windows confirmation dialogs](../native/windows/src/Win/Dialogs.cs).
