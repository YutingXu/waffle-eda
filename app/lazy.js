"use strict";
// AtriumLazy: loads feature modules on first use, so startup parses only the core editor.
// No build step and no fetch/XHR/import(): each module is a relative <script src> injected
// once, which works from file:// in WKWebView, WebKitGTK and Chrome. Loading a module also
// loads its dependencies (in order) and its stylesheets, and resolves only after both.
//
//   AtriumLazy.need("AtriumBOM")            -> Promise<AtriumBOM>  (array in, array out)
//   AtriumLazy.has("AtriumBOM")             -> true when the global exists
//   AtriumLazy.pending("AtriumBOM")         -> true while a load is in flight
//   AtriumLazy.prefetch(["AtriumRouter"])   -> loads one module per idle period, never blocks
//   AtriumLazy.forAction("bom","pcb")       -> globals an editor action needs, or null
//   AtriumLazy.register("AtriumX",{scripts:["x.js"],css:["x.css"],deps:[]}, ["action-id"])
//
// A module that is already defined (for example by an eager <script> tag) is never loaded
// again: need() resolves at once. Headless runners (mcp/board_runner.py, tests) load files
// directly and can use files() for the dependency order.
if (!globalThis.AtriumRuleScopeDemand && typeof require === "function") require("./checks/rule-scope-demand.js");
globalThis.AtriumLazy = (() => {
  // Global -> the files that define it, its stylesheets and the modules it needs first.
  // Files are listed in their original index.html order.
  const MODULES = {
    AtriumTouchPrecision: {scripts: ["editor/touch-precision.js"], css: ["editor/touch-precision.css"]},
    // The option list every single-line <select> opens (ui/dialog.js routes presses and keys here).
    AtriumSelectPopup: {scripts: ["ui/select-popup.js"]},
    AtriumWholePixels: {scripts: ["ui/whole-pixels.js"]},
    // The UI library builders (docs/ui-library.md) and its living gallery (index.html#ui-gallery).
    AtriumUIKit: {scripts:["ui/kit.js"]},
    AtriumOverlayScroll: {scripts:["ui/overlay-scroll.js"]},
    AtriumUIGallery: {scripts:["ui/gallery.js"],css:["ui/gallery.css","ui/analysis-panels.css"],deps:["AtriumUIKit"]},
    AtriumPlacement: {scripts:["pcb/placement.js"]},
    AtriumPastePlan: {scripts:["editor/paste-plan.js"],deps:["AtriumPlacement"]},
    AtriumNotebookCompat: {scripts:["notebook/notebook-compat.js"],deps:["AtriumLinkRecord"]},
    AtriumNotebook: {scripts:["notebook/notebook.js"],deps:["AtriumNoteFields","AtriumLinkRecord"]},
    AtriumNotebookFonts: {scripts:["vendor/notebook-fonts/faces.js","notebook/notebook-fonts.js"]},
    AtriumRichTextView: {scripts:["notebook/rich-text-view.js"],deps:["AtriumNotebookFonts","AtriumNoteFields"]},
    AtriumRichText: {scripts:["notebook/rich-text.js"],deps:["AtriumNotebook","AtriumRichTextView"]},
    AtriumRichTextEditor: {scripts:["notebook/rich-text-editor.js"],css:["notebook/rich-text-editor.css"],deps:["AtriumRichText"]},
    AtriumWireEdit: {scripts: ["schematic/wire-edit.js"]},
    AtriumCanvasInput: {scripts: ["canvas/canvas-input.js"], deps:["AtriumWireEdit"]},
    AtriumActiveBarMenu: {scripts: ["editor/active-bar-menu.js"]},
    AtriumNavigator: {scripts: ["editor/navigator.js"]},
    AtriumProjectTree: {scripts: ["project/project-tree.js"], deps:["AtriumSpatialMotion"]},
    AtriumProjectConnections: {scripts: ["project/project-connections.js"], css: ["project/project-connections.css"]},
    AtriumDocumentInspector: {scripts: ["project/document-inspector.js"]},
    AtriumObsoleteProject: {scripts:["project/obsolete-project.js"]},
    AtriumTranslatorRegistry: {scripts: ["translator-table.js", "formats/translator-registry.js"], deps:["AtriumObsoleteProject"]},
    AtriumLinkRecord: {scripts:["project/link-record.js"]},
    AtriumLinksDesktop: {scripts:["project/links.js","native-bridge/links-desktop.js"], deps:["AtriumLinkRecord","AtriumUndoStore","AtriumFormat2Closure","AtriumDatasheetRecord","AtriumDesignQueryRecord","AtriumCalculationRecords"]},
    AtriumDesignQueryRecord: {scripts:["checks/design-query-record.js"]},
    AtriumSavedViews: {scripts:["project/saved-views.js"],deps:["AtriumFormat2Closure"]},
    AtriumSlides: {scripts:["notebook/slides.js"],deps:["AtriumSavedViews"]},
    AtriumDatasheetRecord: {scripts:["notebook/datasheet-record.js"]},
    AtriumPourMarker: {scripts:["pcb/pour-marker.js"]},
    AtriumFormat2Closure: {scripts:["formats/format-2-codec.js","formats/format-2-units.js","formats/format-2-values.js","formats/format-2-model.js","formats/format-2-closure.js"],deps:["AtriumDesignQueryRecord","AtriumLinkRecord","AtriumDatasheetRecord","AtriumSourceFile","AtriumPourMarker"]},
    AtriumImportSidecars: {scripts:["formats/import-sidecars.js"],deps:["AtriumSourceFile","AtriumBase64"]},
    AtriumProjectArchive: {scripts:["project/project-archive.js"],deps:["AtriumImportSidecars","AtriumZip","AtriumObsoleteProject"]},
    AtriumProjectArchiveUI: {scripts:["project/project-archive-ui.js"],deps:["AtriumProjectArchive","AtriumImportReports"]},
    AtriumFolderProjectWorkerSource: {scripts:["folder-project-worker-source.js"]},
    AtriumFolderCopperWorkerSource: {scripts:["folder-copper-worker-source.js"]},
    AtriumBrowserProject: {scripts:["project/browser-project.js"],deps:["AtriumProjectArchive","AtriumFormat2Closure",
      ...(globalThis.location?.protocol==="file:" ? ["AtriumFolderProjectWorkerSource"] : [])]},
    AtriumAltiumIO: {scripts: ["formats/io.js"]},
    AtriumTranslatorClient: {scripts: ["workers/import-worker-client.js"], deps: ["AtriumTranslatorRegistry", "AtriumAltiumIO"]},
    AtriumImportWorkerSource: {scripts: ["worker-source.js"]},
    AtriumTranslatorProvenance: {scripts: ["formats/translator-provenance.js"]},
    AtriumDesignReader: {scripts: ["formats/design-reader.js"], deps: ["AtriumTranslatorClient"]},
    AtriumEditorFiles: {scripts: ["project/editor-files.js"], deps:["AtriumObsoleteProject"]},
    AtriumNativeMemberUI: {scripts:["project/native-member-ui.js"],deps:["AtriumFormat2Closure"]},
    AtriumImportSaveView: {scripts:["formats/import-save-view.js"],css:["formats/import-save-view.css"]},
    AtriumImportExport: {scripts:["formats/import-export.js"],deps:["AtriumTranslatorRegistry"]},
    AtriumFolderDrafts: {scripts:["project/folder-drafts.js"],deps:["AtriumBase64"]},
    AtriumForeignDrafts: {scripts:["project/foreign-draft-ui.js","project/foreign-drafts.js"],deps:["AtriumFolderProjectUI","AtriumProjectArchiveUI","AtriumFormat2Closure"]},
    AtriumFolderProjectUI: {scripts: ["project/folder-project.js", "project/folder-project-ui.js"], deps: ["AtriumFolderDrafts", "AtriumUndoStore", "AtriumWorkerPool"]},
    AtriumEditorWorkflows: {scripts: ["editor/editor-workflows.js"]},
    AtriumEditorDemand: {scripts: ["editor/editor-demand.js"]},
    AtriumNetsPanel: {scripts: ["editor/nets-panel.js"]},
    AtriumCrossProbe: {scripts: ["editor/crossprobe.js"], deps:["AtriumNetsPanel"]},
    AtriumContextMenu: {scripts: ["editor/context-menu.js"]},
    AtriumWindowedTable: {scripts: ["editor/windowed-table.js"]},
    AtriumNetsTable: {scripts: ["editor/nets-table.js"], deps: ["AtriumCrossProbe", "AtriumWindowedTable", "AtriumDesignQueryRecord"]},
    AtriumPartInspector: {scripts: ["library/part-inspector.js"]},
    AtriumFrameConversion: {scripts: ["formats/frame-conversion.js"], deps: ["AtriumERC"]},
    AtriumMath: {scripts: ["vendor/stix-two-math.js", "notebook/math-font.js", "notebook/math-tex.js", "notebook/math.js", "notebook/math-pdf.js"]},
    AtriumMathEditor: {scripts: ["notebook/math-editor.js"], css: ["notebook/math-editor.css"], deps: ["AtriumMath"]},
    AtriumSchObjectForms: {scripts: ["schematic/sch-object-forms.js"]},
    AtriumTableData: {scripts:["notebook/table-data.js"],deps:["AtriumSourceFile"]},
    AtriumTableFormat: {scripts:["notebook/table-format.js"],deps:["AtriumTableData","AtriumFormat2Closure"]},
    AtriumTableExchange: {scripts:["notebook/table-exchange.js"],deps:["AtriumTableData"]},
    AtriumTableFormulas: {scripts:["notebook/table-formulas.js"],deps:["AtriumCalculationDesign","AtriumTableData"]},
    AtriumTableVisual: {scripts:["notebook/table-visual.js"],deps:["AtriumTableFormulas","AtriumTableExchange","AtriumSheetWidgets"]},
    AtriumTableQuery: {scripts:["notebook/table-query.js"],deps:["AtriumTableData","AtriumDesignQuery"]},
    AtriumTableEditor: {scripts:["notebook/table-editor.js"],css:["notebook/table-editor.css"],deps:["AtriumTableVisual","AtriumNotebook"]},
    AtriumWidgetCatalogue: {scripts:["notebook/widget-fallback.js","notebook/widget-catalogue.js"]},
    AtriumSheetWidgets: {scripts:["notebook/sheet-widgets.js"],deps:["AtriumWidgetCatalogue","AtriumNoteFields"]},
    AtriumExtensionWidgetDeclarations: {scripts:["notebook/widget-fallback.js","extension-host/extension-widget-declarations.js"]},
    AtriumExtensionWidgets: {scripts:["extension-host/extension-widgets.js"],deps:["AtriumExtensionWidgetDeclarations","AtriumSheetWidgets"]},
    AtriumSheetWidgetRuntime: {scripts:["notebook/sheet-widget-runtime.js"],deps:["AtriumSheetWidgets"]},
    AtriumSheetWidgetEditor: {scripts:["notebook/sheet-widget-editor.js"],css:["notebook/sheet-widgets.css"],deps:["AtriumSheetWidgetRuntime"]},
    // Placing schematic objects (Place › Power Port, Port, Bus, Sheet Symbol...): sch-objects.js forwards to it.
    AtriumSchObjectTools: {scripts: ["schematic/sch-object-tools.js"]},
    AtriumNotebookImages: {scripts:["notebook/notebook-images.js"]},
    AtriumNotebookForeign: {scripts:["notebook/notebook-foreign.js"],deps:["AtriumNotebookImages","AtriumSchNoteMarkup"]},
    AtriumNotebookMedia: {scripts:["notebook/notebook-image-format.js","notebook/notebook-media.js"], deps:["AtriumWorkerPool"]},
    AtriumDatasheetWorkerSource: {scripts:["datasheet-worker-source.js"]},
    AtriumDatasheets: {scripts:["notebook/datasheets.js"], deps:["AtriumDatasheetRecord"]},
    AtriumNotebookImageUI: {scripts:["notebook/notebook-image-ui.js"], css:["notebook/notebook-image.css"], deps:["AtriumNotebookImages","AtriumNotebookMedia","AtriumSchNoteMarkup"]},
    AtriumNotebookNativeInput: {scripts:["notebook/notebook-native-input.js"]},
    AtriumSchObjectInspector: {scripts: ["schematic/sch-object-inspector.js"]},
    AtriumSheetConnections: {scripts: ["schematic/sheet-connections.js"]},
    AtriumConnectionThumbnails: {scripts: ["schematic/connection-thumbnails.js"]},
    AtriumCanvasHover: {scripts: ["canvas/canvas-hover.js"]},
    AtriumConnectionPreview: {scripts: ["schematic/connection-preview.js"], css:["schematic/connection-preview.css"], deps:["AtriumSheetConnections","AtriumConnectionThumbnails","AtriumCamera","AtriumCanvasHover"]},
    AtriumSheetInspector: {scripts: ["schematic/sheet-inspector.js"]},
    AtriumStrokeFont: {scripts: ["canvas/stroke-font.js"]},
    AtriumPCBText: {scripts: ["pcb/pcb-text.js"], deps: ["AtriumStrokeFont"]},
    AtriumPCBTextInspector: {scripts: ["pcb/pcb-text-inspector.js"], deps: ["AtriumPCBTextRich"]},
    // TrueType, barcode and knockout PCB text (pcb-text-rich.js on vectorize.js): before a project that uses it opens
    // (validatorsFor), with the outputs that plot text, and on such a text's first draw.
    AtriumVectorize: {scripts: ["canvas/vectorize.js"]},
    AtriumPCBTextRich: {scripts: ["pcb/pcb-text-rich.js"], deps: ["AtriumVectorize", "AtriumPCBText"]},
    AtriumPCBEdit: {scripts: ["pcb/pcb-edit.js"]},
    AtriumFindSimilarDialog: {scripts: ["editor/find-similar-dialog.js"], deps: ["AtriumUIKit"]},
    AtriumPCBSelectionInspector: {scripts: ["pcb/pcb-selection-inspector.js"], deps: ["AtriumPCBEdit", "AtriumFindSimilarDialog"]},
    AtriumPCBPours: {scripts: ["pcb/pcb-pours.js"]},
    AtriumProjectWindows: {scripts: ["native-bridge/project-windows.js"]},
    AtriumImportLink: {scripts: ["formats/import-link.js"], deps: ["AtriumRules"]},
    AtriumAltiumRecords: {scripts: ["formats/altium-records.js"]},
    AtriumAltiumRules: {scripts: ["checks/altium-rules.js"], deps: ["AtriumAltiumRecords"]},
    AtriumGeometry: {scripts: ["core/geometry.js"]},
    AtriumLandContours: {scripts: ["pcb/land-contours.js"], deps: ["AtriumGeometryCurves"]},
    AtriumGeometryMaterial: {scripts: ["pcb/geometry-material.js"], deps: ["AtriumGeometryCurves", "AtriumPolygonPour", "AtriumBoardShapeAuthoring", "AtriumStackup", "AtriumViaStack"]},
    AtriumResolvedGeometry: {scripts: ["pcb/resolved-geometry.js"], deps: ["AtriumGeometryMaterial", "AtriumMaskOpenings", "AtriumPCBTextRich", "AtriumPCBDraw"]},
    AtriumBase64: {scripts:["core/base64.js"]},
    AtriumSHA256: {scripts:["core/sha256.js"]},
    AtriumSourceFile: {scripts:["project/source-file.js"],deps:["AtriumSHA256"]},
    AtriumImport: {scripts: ["vendor/cfb.min.js", "formats/altium-records.js", "formats/altium-ids.js", "formats/sch-import.js", "formats/sexpr.js", "formats/pdf-fonts.js", "formats/altium-typefaces.js", "formats/pcb-import.js", "formats/sch-patch.js", "formats/pcb-patch.js",
      "formats/source-copy.js", "library/library-import-altium.js"], deps: ["AtriumTranslatorClient", "AtriumImportLink", "AtriumAltiumRules", "AtriumBoardShapeSources", "AtriumSourceFile", "AtriumPCBPours", "AtriumPourMarker", "AtriumLibraryPairing"]},
    AtriumImportFormats: {scripts: ["formats/sexpr.js", "formats/import-kicad.js", "formats/import-eagle.js", "formats/import-easyeda.js", "library/library-import-kicad.js"], deps:["AtriumBoardShapeSources", "AtriumPCBPours", "AtriumLibraryPairing"]},
    // Folder libraries and library import (Library panel).
    AtriumKiCadModels: {scripts: ["formats/kicad-models.js"]},
    AtriumCatalogue: {scripts: ["library/catalogue.js"], css: ["library/catalogue.css"], deps: ["AtriumComponentFamilies", "AtriumPCBText"]},
    AtriumLibrarySourcesUI: {scripts: ["library/library-sources.js", "library/library-sources-ui.js"], deps: ["AtriumLibrary", "AtriumImportFormats", "AtriumCatalogue", "AtriumWorkerPool"]},
    AtriumSymbols: {scripts: ["library/symbols.js"]},
    AtriumBlocks: {scripts: ["schematic/blocks.js"], deps:["AtriumPlacement"]},
    AtriumImpedance: {scripts: ["analysis/impedance.js"]},
    AtriumRigidFlex: {scripts: ["pcb/rigid-flex.js"], deps: ["AtriumRules"]},
    // Flex routing/construction DRC (flex-drc.js) and the 3D fold of bend lines (flex-fold.js).
    AtriumFlexDRC: {scripts: ["checks/flex-drc.js"], deps: ["AtriumRigidFlex"]},
    AtriumFlexFold: {scripts: ["canvas/flex-fold.js"], deps: ["AtriumRigidFlex"]},
    AtriumDXF: {scripts: ["formats/dxf.js"], deps: ["AtriumPCBDraw", "AtriumBoardShapeAuthoring"]},
    // The first board frame uses board-shape-core.js. Import, edit and output
    // tools extend that same geometry API when they need to construct a shape.
    AtriumGeometryCurves: {scripts:["pcb/resolved-geometry-curves.js"]},
    AtriumBoardShapeAuthoring: {scripts:["pcb/board-shape.js"], deps:["AtriumGeometryCurves"]},
    AtriumBoardShapeSources: {scripts:["formats/board-shape-sources.js"], deps:["AtriumBoardShapeAuthoring"]},
    AtriumBoardShapeEditing: {scripts:["pcb/board-shape-editing.js"], deps:["AtriumBoardShapeAuthoring"]},
    AtriumBoardShapeUI: {scripts:["pcb/board-shape-ui.js"], css: ["pcb/board-shape.css"], deps:["AtriumBoardShapeEditing"]},
    // Timing Vision; the length engine uses its via delay model.
    AtriumTiming: {scripts: ["pcb/timing-vision.js"], css: ["pcb/timing-vision.css"], deps: ["AtriumRules"]},
    AtriumLength: {scripts: ["pcb/length-tuning.js"], css: ["pcb/length-tuning.css"], deps: ["AtriumRules", "AtriumTiming", "AtriumXSignals"]},
    AtriumDRCMarkers: {scripts: ["checks/drc-markers.js"], css: ["checks/drc-markers.css"], deps: ["AtriumChecks", "AtriumLandContours"]},
    // Board canvas frame shortcuts (board-layer copy, selection frames, pour index); prefetched first on load.
    AtriumCanvasBoardBatches: {scripts: ["canvas/canvas-board-batches.js"]},
    AtriumCanvasFast: {scripts: ["canvas/canvas-fast.js"]},
    AtriumPCBNetLabels: {scripts: ["canvas/pcb-net-labels.js"]},
    // Preferences registers the renderer choice. A visible PCB view asks for the WebGL2 renderer.
    AtriumCanvasGPU: {scripts: ["canvas/canvas-gpu.js"], deps: ["AtriumCanvasGPUPref", "AtriumPCBPours", "AtriumGeometryCurves"]},
    AtriumCanvasGPUPref: {scripts: ["canvas/canvas-gpu-pref.js"]},
    AtriumDRCFixes: {scripts: ["checks/drc-fixes.js"], css: ["checks/drc-fixes.css"], deps: ["AtriumRules"]},
    AtriumWaivers: {scripts: ["checks/waivers.js"]},
    AtriumDRCWaivers: {scripts: ["checks/drc-waivers.js"], css: ["checks/drc-markers.css"], deps: ["AtriumWaivers"]},
    AtriumDRCInspector: {scripts: ["checks/drc-inspector.js"], css: ["checks/drc-inspector.css"], deps: ["AtriumDRCMarkers", "AtriumDRCFixes"]},
    // Imported board rules (import-rules.js): after an import, "Use the board's rules?" in Messages.
    AtriumImportRules: {scripts: ["formats/import-rules.js"], deps: ["AtriumRules","AtriumQueryExchange"]},
    AtriumLasso: {scripts: ["editor/lasso.js"], deps: ["AtriumGeometry"]},
    AtriumGuides: {scripts: ["pcb/smart-guides.js"]},
    AtriumDesignators: {scripts: ["pcb/designator-place.js"]},
    // Pressing a part's Designator, Comment or visible parameter on a sheet takes that text (editor.js).
    AtriumSchFields: {scripts: ["schematic/sch-fields.js"]},
    AtriumTabDrop: {scripts: ["project/tab-drop.js"]},
    AtriumDesignatorPlan: {scripts: ["pcb/designator-plan.js"], deps: ["AtriumDesignators"]},
    AtriumPalette: {scripts: ["editor/palette.js"], deps: ["AtriumCrossProbe"]},
    AtriumPalettePersonal: {scripts: ["editor/palette-personal.js"], css: ["editor/palette-personal.css"]},
    // i18n: plurals, Intl formatting and other locales (the eager i18n.js shim is English only).
    AtriumI18nCore: {scripts: ["editor/i18n-core.js"]},
    // Keyboard shortcuts editor dialog (keymap-editor.js); AtriumKeymap.open() loads it.
    AtriumKeymapEditor: {scripts: ["editor/keymap-editor.js"], deps: ["AtriumUIKit"]},
    AtriumEditorKeyDialogs: {scripts: ["editor/editor-key-dialogs.js"]},
    // Key-map presets Waffle Classic and KiCad-like (keymap.js loads them when chosen or saved).
    AtriumKeymapPresets: {scripts: ["editor/keymap-presets.js"]},
    AtriumEngine: {scripts: ["engine-core.js"]}, // Rust/WebAssembly kernels; callers fall back to JS
    // Altium muscle memory (altium-keys.js): net highlight, pick tools, Un-Route, layer keys.
    AtriumAltiumKeys: {scripts: ["editor/altium-keys.js"], deps: ["AtriumCrossProbe"]},
    AtriumPinSwap: {scripts: ["pcb/pin-swap.js"], css: ["pcb/pin-swap.css"], deps: ["AtriumECO"]},
    // Board core (lazy pass 2): the stack-up, via stacks, polygon pours and the rule engine are
    // engines plus large dialogs. Eager code only reaches them through optional lookups, and they
    // are prefetched once a board layout is open (see BOARD below), so editing a board has them
    // a moment after first paint. Rules pulls the other three.
    AtriumStackup: {scripts: ["pcb/stackup.js"], css: ["pcb/stackup.css"], deps: ["AtriumImpedance"]},
    AtriumViaStack: {scripts: ["pcb/viastack.js"], css: ["pcb/viastack.css"], deps: ["AtriumStackup"]},
    AtriumPolygonPour: {scripts: ["pcb/polygon-pour.js"], css: ["pcb/polygon-pour.css"], deps: ["AtriumGeometryCurves", "AtriumGeometry", "AtriumNetIntent", "AtriumViaStack", "AtriumPCBPours", "AtriumPourMarker"]},
    // The shared worker pool (worker-pool.js) that Repour All solves on.
    AtriumWorkerPool: {scripts: ["workers/worker-pool.js"]},
    AtriumLivePourClient: {scripts: ["workers/live-pour-client.js"], deps: ["AtriumWorkerPool"]},
    // Repour All's progress animation, fetched with the worker pool.
    AtriumPourAnim: {scripts: ["pcb/pour-anim.js"], deps: ["AtriumMotion"]},
    // Fast pour preview (pour-preview.js) for Repour All's progress.
    AtriumPourPreview: {scripts: ["pcb/pour-preview.js"]},
    // Rooms (multichannel boards): drawn by the editor, checked by DRC, created by ECO. Its menu
    // items and keys are stubbed below until it loads.
    AtriumRooms: {scripts: ["pcb/rooms.js"], deps: ["AtriumMultichannel"]},
    // Multichannel designs (repeated sheets; multichannel.js): channel designators, scopes and
    // the board sync. Loaded before a hierarchical project is opened (validatorsFor) and when a
    // sheet symbol appears (watchProject); its menu items and keys are stubbed below.
    AtriumMultichannel: {scripts: ["schematic/multichannel.js"]},
    // Assembly variants (variants.js): loaded before a project with variants is opened, and when
    // the editor is idle (the status-bar switcher). Its menu item is stubbed below.
    AtriumVariants: {scripts: ["project/variants.js"], css: ["project/variants.css"]},
    // PDF writer and printing (pdf.js, print.js). The Path2D recorder stays eager (path-record.js).
    AtriumPDF: {scripts: ["formats/pdf.js"], deps: ["AtriumPCBText"]},
    AtriumPrint: {scripts: ["formats/print.js"], css: ["formats/print.css"], deps: ["AtriumPDF", "AtriumPDFFonts", "AtriumFabOutputs"]},
    // Reports (BOM, Messages, comparisons) as PDF pages for the same print path and dialog.
    AtriumPrintReport: {scripts: ["formats/print-report.js"], deps: ["AtriumPrint"]},
    AtriumNotebookOutput: {scripts:["formats/notebook-output.js"]},
    // Embedded Unicode font for PDF output (vendored DejaVu Sans subset) and drawing documents
    // (Project › Add New Drawing…: fabrication and assembly drawings, drawing-views.js + drawing.js).
    AtriumPDFFonts: {scripts: ["vendor/dejavu-sans.js", "formats/pdf-fonts.js"], deps: ["AtriumPDF"]},
    AtriumDrawing: {scripts: ["formats/drawing-views.js", "formats/drawing.js"], css: ["formats/drawing.css"], deps: ["AtriumPrint", "AtriumStackup"]},
    // Component classes (Design › Classes…, InComponentClass rule scopes) and dynamic connectors.
    AtriumComponentClasses: {scripts: ["pcb/component-classes.js"]},
    AtriumDynamicSymbol: {scripts: ["schematic/dynamic-symbol.js"], deps: ["AtriumLibrary"]},
    AtriumQueryFields: {scripts:["checks/query-fields.js"],deps:["AtriumCalculationCore","AtriumNoteFields"]},
    AtriumDesignQuery: {scripts:["checks/design-query-parser.js","checks/design-query-geometry.js","checks/design-query-context.js","checks/design-query-index.js","checks/design-query.js"],
      deps:["AtriumDesignQueryRecord","AtriumQueryFields"]},
    AtriumQueryService: {scripts:["checks/query-service.js"],deps:["AtriumDesignQuery","AtriumFormat2Closure","AtriumMultichannel"]},
    AtriumQueryFieldUI: {scripts:["checks/query-field-ui.js"],css:["checks/query-field-ui.css"],deps:["AtriumQueryFields"]},
    AtriumQueryExchange: {scripts:["checks/query-exchange.js"], deps:["AtriumDesignQueryRecord"]},
    AtriumQuery: {scripts: ["checks/query.js"], css: ["checks/query.css"], deps: ["AtriumDesignQuery","AtriumQueryExchange"]},
    AtriumNavigatorPanel: {scripts: ["editor/navigator-panel.js"], css: ["checks/query.css"], deps: ["AtriumQuery", "AtriumCrossProbe"]},
    AtriumPCBLayerBar: {scripts: ["pcb/pcb-layer-bar.js"]},
    AtriumLayerSets: {scripts: ["pcb/layer-sets.js"], css: ["checks/query.css"], deps: ["AtriumStackup"]},
    AtriumNetIntent: {scripts: ["checks/net-intent.js", "checks/net-intent-index.js"]},
    AtriumNaming: {scripts: ["schematic/naming.js"], css: ["schematic/naming.css"], deps: ["AtriumNetIntent"]},
    AtriumSignals: {scripts: ["core/signals.js"], deps: ["AtriumNetIntent"]},
    AtriumDocViews: {scripts: ["project/doc-views.js"], css: ["project/doc-views.css"], deps: ["AtriumSpatialMotion"]},
    AtriumRules: {scripts: ["checks/rules.js", "checks/project-rules.js", "checks/drc-pours.js", "checks/creepage.js"], css: ["checks/rules-editor.css"], deps: ["AtriumLandContours", "AtriumGeometry", "AtriumGeometryCurves", "AtriumDocViews", "AtriumNetIntent", "AtriumSignals", "AtriumAltiumRules", "AtriumDesignQueryRecord", "AtriumStackup", "AtriumViaStack", "AtriumPolygonPour", "AtriumRooms", "AtriumComponentClasses"]},
    AtriumComponentFamilies: {scripts: ["library/component-families.js"]},
    // Library panel, footprint wizard (+ package families) and editors (the panel opens them).
    AtriumLibraryPairing: {scripts: ["library/library-pairing.js"]},
    AtriumLibrary: {scripts: ["library/library-store.js", "library/library-ui.js", "library/library-panel.js", "library/library-diff.js", "library/library-families-ui.js", "library/footprint-wizard.js", "library/footprint-packages.js", "library/footprint-editor.js", "library/symbol-editor.js"], css: ["ui/spreadsheet.css", "library/library-panel.css"], deps: ["AtriumComponentFamilies", "AtriumLibraryPairing", "AtriumCamera", "AtriumSpatialMotion", "AtriumPCBText", "AtriumSHA256", "AtriumPCBEdit", "AtriumUIKit"]},
    AtriumGroupLibraryUI: {scripts: ["library/group-library.js", "library/group-library-local.js", "library/group-library-sync.js", "library/group-library-ui.js"], deps: ["AtriumLibrary", "AtriumNetIntent"]},
    // "New component…" in the component library dialog (editor.js showLibrary).
    AtriumLibraryEditor: {scripts: ["library/library-editor.js"], css: ["library/library-editor.css"], deps: ["AtriumPCBText"]},
    // Recovery prompt and File › Recover… (autosave.js keeps the storage side eager).
    AtriumRecover: {scripts: ["project/recover.js"], css: ["project/recover.css"]},
    AtriumRouter: {scripts: ["pcb/router.js", "pcb/diffpair.js", "pcb/route-feel.js", "pcb/drag-reroute.js"], css: ["pcb/route-feel.css"], deps: ["AtriumRules"]},
    AtriumViewConfig: {scripts: ["project/view-config.js"], css: ["project/view-config.css"]},
    AtriumComponentMatch: {scripts: ["library/component-match.js"], deps: ["AtriumWorkerPool"]},
    AtriumECO: {scripts: ["schematic/eco.js"], css: ["schematic/eco.css"], deps: ["AtriumNetIntent", "AtriumMultichannel", "AtriumComponentMatch"]},
    AtriumSyncStatus: {scripts: ["project/sync-status.js"], css: ["project/sync.css"]},
    AtriumSupportPlace: {scripts: ["editor/support-placement.js"], css: ["editor/support-placement.css"], deps: ["AtriumNetIntent"]},
    AtriumArrange: {scripts: ["pcb/arrange.js"]},
    AtriumAnnotate: {scripts: ["notebook/annotate.js"], css: ["notebook/annotate.css"], deps: ["AtriumECO"]},
    AtriumAutorouter: {scripts: ["pcb/autorouter.js", "pcb/fanout.js"], css: ["pcb/autorouter.css"], deps: ["AtriumRules"]},
    AtriumFabProfiles: {scripts: ["formats/fab-profiles.js"], deps: ["AtriumRules", "AtriumFabPresetsJLCPCB"]},
    AtriumViaStubs: {scripts: ["pcb/via-stubs.js"], css: ["pcb/via-stubs.css"], deps: ["AtriumRules"]},
    AtriumRuleSets: {scripts: ["checks/rule-sets.js"], css: ["checks/rule-sets.css"], deps: ["AtriumFabProfiles", "AtriumRuleGroups"]},
    AtriumRuleGroups: {scripts: ["checks/rule-groups.js"], css: ["ui/rule-set-lists.css", "checks/rule-groups.css"], deps: ["AtriumRules"]},
    AtriumZClearance: {scripts: ["checks/z-clearance.js"], deps: ["AtriumRules", "AtriumStackup"]},
    AtriumDRC: {scripts: ["checks/drc.js"], deps: ["AtriumImpedance", "AtriumRules", "AtriumPCBDraw", "AtriumZClearance", "AtriumFlexDRC", "AtriumPCBTextRich", "AtriumMaskOpenings"]},
    // DFA spacing matrix (dfa.js): the dfaSpacing DRC rule and the live placement overlay.
    AtriumDFA: {scripts: ["checks/dfa.js"], deps: ["AtriumRules"]},
    AtriumViaFence: {scripts: ["pcb/via-fence.js"], css: ["pcb/via-fence.css"], deps: ["AtriumRouter", "AtriumBoardShapeAuthoring"]},
    AtriumProposal: {scripts: ["automation/proposal.js"]},
    AtriumButter: {scripts: ["automation/command-broker.js"]},
    AtriumDrop: {scripts: ["project/drop-receiver.js"]},
    AtriumDropData: {scripts: ["project/drop-data.js"], deps:["AtriumDrop","AtriumWidgetCatalogue","AtriumTableExchange"]},
    AtriumDropEditor: {scripts: ["editor/drop-editor.js"], deps:["AtriumDrop","AtriumDropData"]},
    AtriumButterCatalog: {scripts: ["automation/command-catalog.js"]},
    AtriumButterEditor: {scripts: ["automation/editor-command-host.js"], deps: ["AtriumButter", "AtriumButterCatalog"]},
    AtriumAIProvidersDesktop: {scripts:["automation/ai-provider-desktop.js"], deps:["AtriumExtensions","AtriumLinkRecord","AtriumAbout"]},
    AtriumWindowWorkspace: {scripts: ["native-bridge/window-workspace.js"]},
    AtriumProjectWindowClient: {scripts: ["native-bridge/project-window-client.js"], deps:["AtriumWindowWorkspace"]},
    AtriumAI: {scripts: ["automation/ai.js"], deps: ["AtriumProposal"]},
    AtriumSchematicOutput: {scripts: ["formats/schematic-output.js"]},
    AtriumKiCad: {scripts: ["formats/kicad-export.js", "formats/kicad-schematic.js"], deps: ["AtriumSchematicOutput", "AtriumRules", "AtriumPCBDraw", "AtriumZip", "AtriumVariants", "AtriumPCBTextRich"]},
    AtriumRevisionReview: {scripts: ["history/revision-review.js", "history/revision-present.js", "history/revision-geometry.js", "history/revision-panel.js"], deps: ["AtriumDiff", "AtriumLandContours"]},
    AtriumDesignReview: {scripts: ["history/design-review.js"], css: ["formats/fab-outputs.css"], deps: ["AtriumTranslatorClient", "AtriumZip", "AtriumSchematicOutput"]},
    AtriumZip: {scripts: ["core/zip.js"]},
    AtriumFormat2Models: {scripts: ["formats/sexpr.js", "vendor/zipjs-deflate.js", "formats/format-2-models.js"], deps: ["AtriumZip", "AtriumSourceFile"]},
    AtriumBOM: {scripts: ["formats/bom.js", "formats/bom-optimiser.js"], css: ["ui/spreadsheet.css", "formats/bom.css", "formats/bom-optimiser.css"], deps: ["AtriumZip", "AtriumVariants", "AtriumMultichannel"]},
    AtriumSTEP: {scripts: ["formats/sexpr.js", "formats/step-export.js"], css: ["formats/fab-outputs.css"], deps: ["AtriumRigidFlex", "AtriumVariants", "AtriumBoardShapeAuthoring", "AtriumGeometryMaterial", "AtriumSTEPImport"]},
    // STEP component models for the 3D view (step-import.js: bounded reader and tessellator, run in a
    // worker) and 3D component clearance (collision-3d.js: the componentClearance rule, 3D view collisions).
    AtriumSTEPImport: {scripts: ["formats/step-import.js"], deps: ["AtriumWorkerPool"]},
    AtriumCollision3D: {scripts: ["canvas/collision-3d.js"], deps: ["AtriumSTEP", "AtriumFlexFold", "AtriumSTEPImport"]},
    AtriumMaskOpenings: {scripts: ["pcb/mask-openings.js"], deps: ["AtriumRules", "AtriumViaStack"]},
    AtriumFabOutputs: {scripts: ["formats/fab-outputs.js"], css: ["formats/fab-outputs.css"], deps: ["AtriumBoardShapeSources", "AtriumZip", "AtriumVariants", "AtriumBOM", "AtriumRigidFlex", "AtriumSTEP", "AtriumResolvedGeometry"]},
    AtriumLogo: {scripts: ["editor/logo-creator.js"], deps: ["AtriumVectorize"]},
    AtriumMessages: {scripts: ["editor/messages.js"], css: ["checks/erc.css"], deps: ["AtriumSpatialMotion"]},
    AtriumChecks: {scripts: ["checks/problem-marks.js", "checks/checks.js", "schematic/sch-markers.js", "checks/checks-cross.js", "checks/problem-hover.js"], deps: ["AtriumCanvasHover"]},
    AtriumERC: {scripts: ["checks/erc.js"], deps: ["AtriumMessages", "AtriumMultichannel"]},
    AtriumNoteFields: {scripts: ["notebook/note-fields.js"]},
    AtriumCalculationIntent: {scripts: ["notebook/calculation-intent.js"]},
    AtriumCalculationCore: {scripts: ["notebook/calculation-core.js"], deps: ["AtriumCalculationIntent"]},
    AtriumPreferredValues: {scripts: ["notebook/preferred-values.js"]},
    AtriumElectricalMaterial: {scripts: ["analysis/electrical-material.js"]},
    AtriumCalc: {scripts: ["analysis/calculators.js"], deps: ["AtriumPreferredValues", "AtriumElectricalMaterial"]},
    AtriumCalculationHelpers: {scripts: ["notebook/calculation-helpers.js"], deps: ["AtriumPreferredValues"]},
    AtriumCalculationRecords: {scripts: ["notebook/calculation-records.js"], deps: ["AtriumNoteFields"]},
    AtriumCalculationActions: {scripts: ["notebook/calculation-actions.js"], deps: ["AtriumCalculationCore", "AtriumNoteFields"]},
    AtriumCalculationChecks: {scripts: ["notebook/calculation-checks.js"], deps: ["AtriumCalculationRecords", "AtriumDesignQueryRecord"]},
    AtriumNumericFields: {scripts: ["editor/numeric-fields.js"], deps: ["AtriumCalculations"]},
    AtriumCalculationWorkerSource: {scripts: ["calculation-worker-source.js"]},
    AtriumCalculationDesign: {scripts: ["notebook/calculation-graph.js", "notebook/calculation-design.js"],
      deps: ["AtriumCalculationCore", "AtriumCalculationHelpers", "AtriumCalculationChecks", "AtriumNoteFields", "AtriumQueryFields"]},
    AtriumCalculations: {scripts: ["notebook/calculations.js"], deps: ["AtriumCalculationDesign", "AtriumCalculationActions", "AtriumWorkerPool"]},
    AtriumCalculationDisplay: {scripts: ["notebook/calculation-display.js"], deps: ["AtriumCalculationRecords"]},
    AtriumCalculationSheet: {scripts: ["notebook/calculation-sheet.js"], css: ["notebook/calculation-sheet.css"],
      deps: ["AtriumCalculations", "AtriumCalculationDisplay", "AtriumRules"]},
    AtriumSwap: {scripts: ["library/component-swap.js"]},
    AtriumExtensionPaletteDeclarations: {scripts:["extension-host/extension-palette-declarations.js"]},
    AtriumExtensionPalette: {scripts:["extension-host/extension-palette.js"],deps:["AtriumExtensionPaletteDeclarations"]},
    AtriumExtensions: {scripts: ["core/atrium-api.js", "extensions/manifests.js", "history/diff-props.js", "native-bridge/external-tools.js", "extension-host/extensions.js", "automation/scripting.js"], css: ["history/diff-props.css", "extension-host/extensions.css"], deps: ["AtriumProposal", "AtriumMultichannel"]},
    AtriumTeardrops: {scripts: ["pcb/teardrops.js"], deps: ["AtriumRouter"]},
    AtriumAbout: {scripts: ["editor/about.js"], deps: ["AtriumCanvasGPUPref"]},
    AtriumInputDiagnostics: {scripts:["canvas/input-diagnostics.js"]},
    AtriumPerformanceDiagnostics: {scripts:["checks/performance-diagnostics.js"]},
    AtriumFrameMonitor: {scripts:["canvas/frame-monitor.js"], deps:["AtriumPerformanceDiagnostics"]},
    AtriumUpdate: {scripts: ["editor/update-check.js"], css: ["editor/compat.css"]},
    AtriumPCBDraw: {scripts: ["pcb/pcb-draw.js"], css: ["pcb/pcb-draw.css"], deps: ["AtriumRules", "AtriumDesignators", "AtriumPCBText"]},
    // Panelization (Tools › Panelize…): panel documents, panel outputs and order notes.
    AtriumPanel: {scripts: ["pcb/panel.js"], css: ["pcb/panel.css"], deps: ["AtriumFabOutputs", "AtriumFabProfiles"]},
    // Panelize dialog, canvas handles and the panel Properties panel (panel.js loads it on first use).
    AtriumPanelUI: {scripts: ["pcb/panel-ui.js"], css: ["pcb/panel.css"], deps: ["AtriumPanel"]}
  };
  // Other globals defined by a module's files.
  const ALIAS = {AtriumDiffPair: "AtriumRouter", AtriumRouteFeel: "AtriumRouter", AtriumDragReroute: "AtriumRouter", AtriumFanout: "AtriumAutorouter", AtriumAPI: "AtriumExtensions", AtriumScripting: "AtriumExtensions",
    AtriumExternalTools: "AtriumExtensions",
    AtriumBuiltinExtensionManifests: "AtriumExtensions", AtriumKiCadSchematic: "AtriumKiCad", AtriumBOMOptimiser: "AtriumBOM",
    AtriumRevisionPresent: "AtriumRevisionReview", AtriumRevisionGeometry: "AtriumRevisionReview", AtriumRevisionPanel: "AtriumRevisionReview",
    AtriumBoardShape: "AtriumBoardShapeAuthoring",
    AtriumSCH: "AtriumImport", AtriumPCB: "AtriumImport",
    AtriumSchPatch: "AtriumImport", AtriumPCBPatch: "AtriumImport", AtriumSourceCopy: "AtriumImport",
    AtriumSexpr: "AtriumImportFormats", AtriumKiCadImport: "AtriumImportFormats", AtriumLibraryImportKiCad: "AtriumImportFormats", AtriumLibrarySources: "AtriumLibrarySourcesUI", AtriumEagleImport: "AtriumImportFormats", AtriumEasyEDAImport: "AtriumImportFormats",
    AtriumFootprintWizard: "AtriumLibrary", AtriumFootprintEditor: "AtriumLibrary", AtriumSymbolEditor: "AtriumLibrary"};
  // The global each file defines; a file whose global already exists is never injected.
  const DEFINES = {"vendor/cfb.min.js": "CFB", "formats/sch-import.js": "AtriumSCH", "formats/pcb-import.js": "AtriumPCB", "core/geometry.js": "AtriumGeometry", "core/sha256.js": "AtriumSHA256", "project/source-file.js": "AtriumSourceFile",
    "formats/sch-patch.js": "AtriumSchPatch", "formats/pcb-patch.js": "AtriumPCBPatch", "formats/source-copy.js": "AtriumSourceCopy", "worker-source.js": "AtriumImportWorkerSource",
    "formats/step-export.js": "AtriumSTEP", "formats/altium-export.js": "AtriumAltiumExport", "formats/sexpr.js": "AtriumImportFormats", "formats/import-kicad.js": "AtriumKiCadImport", "formats/import-eagle.js": "AtriumEagleImport", "formats/import-easyeda.js": "AtriumEasyEDAImport", "library/library-import-kicad.js": "AtriumLibraryImportKiCad", "library/library-sources.js": "AtriumLibrarySources",
    "workers/import-worker-client.js": "AtriumImport", "pcb/router.js": "AtriumRouter", "pcb/diffpair.js": "AtriumDiffPair", "pcb/route-feel.js": "AtriumRouteFeel", "pcb/autorouter.js": "AtriumAutorouter",
    "pcb/fanout.js": "AtriumFanout", "automation/ai.js": "AtriumAI", "formats/kicad-export.js": "AtriumKiCad",
    "formats/kicad-schematic.js": "AtriumKiCadSchematic", "history/revision-review.js": "AtriumRevisionReview", "history/revision-present.js": "AtriumRevisionPresent",
    "history/revision-geometry.js": "AtriumRevisionGeometry", "history/revision-panel.js": "AtriumRevisionPanel", "formats/bom.js": "AtriumBOM", "formats/bom-optimiser.js": "AtriumBOMOptimiser",
    "native-bridge/external-tools.js": "AtriumExternalTools",
    "core/atrium-api.js": "AtriumAPI", "extensions/manifests.js": "AtriumBuiltinExtensionManifests", "extension-host/extension-palette.js": "AtriumExtensionPalette", "extension-host/extensions.js": "AtriumExtensions", "automation/scripting.js": "AtriumScripting",
    "library/library-panel.js": "AtriumLibrary", "library/footprint-wizard.js": "AtriumFootprintWizard", "library/footprint-editor.js": "AtriumFootprintEditor", "library/symbol-editor.js": "AtriumSymbolEditor", "checks/net-intent.js": "AtriumNetIntent", "checks/net-intent-index.js": "AtriumNetIntentIndex"};
  for (const [name, m] of Object.entries(MODULES)) if (m.scripts.length === 1) DEFINES[m.scripts[0]] ??= name;
  Object.assign(DEFINES, {"vendor/dejavu-sans.js": "AtriumFontDejaVuSans", "formats/pdf-fonts.js": "AtriumPDFFonts", "formats/drawing-views.js": "AtriumDrawingViews", "formats/drawing.js": "AtriumDrawing"});
  Object.assign(ALIAS, {AtriumDrawingViews: "AtriumDrawing", AtriumFontDejaVuSans: "AtriumPDFFonts"});

  // Editor action -> modules it needs. {pcb:[...]} limits the need to one document kind.
  const ACTIONS = {}, builtinEntries = new WeakSet();
  let registeringBuiltins = true;
  const on = (names, ...actions) => { builtinEntries.add(names); for (const a of actions) ACTIONS[a] = names; };
  on(["AtriumAbout"], "about", "licenses");
  on(["AtriumCrossProbe"], "cross-probe", "cross-select", "context-menu");
  on(["AtriumNetsPanel"], "net-colours", "nets-panel");
  on({schematic:["AtriumWireEdit"]}, "junction", "split-wire");
  on(["AtriumCrossProbe", "AtriumContextMenu"], "select-net", "highlight-net", "net-properties", "delete-net-copper");
  on(["AtriumContextMenu"], "drc-fix", "drc-explain", "drc-ignore", "drc-waive", "close-project", "add-existing", "reveal-project");
  on(["AtriumInputDiagnostics"],"input-diagnostics");
  on(["AtriumFrameMonitor"],"frame-monitor");
  on(["AtriumUIGallery"],"ui-gallery");
  on(["AtriumUpdate"], "check-updates");
  on(["AtriumZClearance"], "z-clearance-overlay");
  on(["AtriumPCBDraw"], "pcb-pad", "pcb-fill", "pcb-region", "pcb-polygon", "pcb-keepout-track", "pcb-keepout-arc", "pcb-keepout-fill", "pcb-keepout-region",
    "pcb-line", "pcb-arc-center", "pcb-arc-edge", "pcb-arc-3pt", "pcb-dim-linear", "pcb-dim-aligned", "pcb-dim-radial", "pcb-dim-angular",
    "measure-primitives", "measure-selected", "polygon-pour");
  on(["AtriumPCBDraw","AtriumBoardShapeEditing"], "board-edit-vertices");
  on(["AtriumAnnotate"], "annotate");
  on(["AtriumPrint"], "print", "export-pdf");
  on(["AtriumCalculationSheet"], "sch-calculation");
  on(["AtriumDrawing"], "add-drawing", "drawing-view", "drawing-dim-linear", "drawing-dim-radial", "drawing-dim-ordinate", "drawing-callout", "drawing-sheet");
  // Drawing follow-ups: section and detail views, break lines, tables, sheet text and lines.
  on(["AtriumDrawing"], "drawing-section", "drawing-detail", "drawing-break", "drawing-table", "drawing-text", "drawing-line");
  on(["AtriumVariants"], "variants");
  // Board revisions (revisions.js) and their dialog, chip and banner (revisions-ui.js).
  register("AtriumRevisions", {scripts: ["project/revisions.js"],deps:["AtriumSHA256"]});
  register("AtriumRevisionsUI", {scripts: ["project/revisions-ui.js"], css: ["project/revisions.css"], deps: ["AtriumRevisions", "AtriumVariants"]}, ["revisions", "revision-new", "revision-release", "revision-compare"]);
  on(["AtriumAutorouter"], "autoroute", "autoroute-all", "autoroute-area", "autoroute-component", "autoroute-connection", "autoroute-net", "fanout");
  on(["AtriumBlocks"], "blocks");
  on(["AtriumDXF", "AtriumMessages", "AtriumBoardShapeUI"], "board-shape", "board-dimensions", "board-wizard", "import-dxf", "export-dxf");
  on(["AtriumBOM"], "bom");
  on(["AtriumRevisionReview"], "compare");
  on(["AtriumERC"], "compile", "erc");
  on(["AtriumDesignReview"], "connectivity", "export");
  on(["AtriumRouter"], "diffpair-gloss", "diffpair-retrace", "route-tabs", "route-tabs-trapezoid", "route-diffpair");
  on({pcb: ["AtriumRouter"]}, "route");
  register("AtriumDRCView", {scripts: ["checks/drc-view.js", "checks/drc-certs.js"], deps: ["AtriumChecks"]}, ["drc-online", "drc-clear", "drc-waivers"]);
  on(["AtriumDRCView", "AtriumDRC", "AtriumViaStubs", "AtriumRuleSets", "AtriumDFA", "AtriumLength", "AtriumDRCMarkers", "AtriumCollision3D", "AtriumXSignals", "AtriumTopology", "AtriumParallelSegment", "AtriumReturnPath", "AtriumImpedanceChecks", "AtriumIPC2152"], "drc");
  on(["AtriumRuleSets"], "rule-sets");
  on(["AtriumViaStubs"], "via-stubs");
  register("AtriumFabPresets", {scripts: ["formats/fab-presets.js"], css: ["formats/fab-presets.css"], deps: ["AtriumRules"]}, ["fab-preset"]); // fab-presets: + data, dfm.js
  register("AtriumFabPresetsJLCPCB", {scripts: ["fab-presets/jlcpcb.js"], deps: ["AtriumFabPresets"]});
  register("AtriumDFM", {scripts: ["checks/dfm.js"], deps: ["AtriumGeometry", "AtriumFabPresetsJLCPCB", "AtriumMessages", "AtriumMaskOpenings", "AtriumPCBTextRich", "AtriumDesignators"]}, ["dfm-check"]);
  // Design › HDI Via Setup… (hdi.js; the HDI model and checks are in viastack.js). hdi-ui
  register("AtriumHDI", {scripts: ["pcb/hdi.js"], css: ["pcb/hdi.css"], deps: ["AtriumViaStack", "AtriumRules"]}, ["hdi-setup"]);
  // SI-lite and component stress (si.js, stress.js): Tools menu, loaded on first use.
  register("AtriumSI", {scripts: ["analysis/si.js"], css: ["ui/analysis-panels.css", "analysis/si.css"], deps: ["AtriumRules", "AtriumImpedance", "AtriumRigidFlex", "AtriumUIKit"]}, ["si-analysis"]);
  // High-speed suite (docs/high-speed.md); DRC loads the checks.
  register("AtriumXSignals", {scripts: ["pcb/xsignals.js"], css: ["pcb/xsignals.css"], deps: ["AtriumRules"]}, ["xsignal-wizard"]);
  register("AtriumSignalsPanel", {scripts: ["editor/signals-panel.js"], css: ["editor/signals-panel.css"], deps: ["AtriumRules", "AtriumCrossProbe"]}, ["signals-panel"]);
  register("AtriumTopology", {scripts: ["pcb/topology.js"], deps: ["AtriumRules"]});
  register("AtriumParallelSegment", {scripts: ["pcb/parallel-segment.js"], deps: ["AtriumRules"]});
  register("AtriumReturnPath", {scripts: ["analysis/return-path.js"], deps: ["AtriumSI"]});
  register("AtriumImpedanceChecks", {scripts: ["analysis/impedance-checks.js"], deps: ["AtriumSI"]}); // impedance window, neck-down, reference
  // Design Insights; prefetched when idle (below).
  register("AtriumInsights", {scripts: ["checks/insights.js", "checks/insights-pcb.js", "checks/insights-sch.js", "checks/insights-intent.js"], deps: ["AtriumGeometry", "AtriumLandContours", "AtriumNetIntent"]});
  register("AtriumInsightsUI", {scripts: ["checks/insights-ui.js"], css: ["checks/insights.css"], deps: ["AtriumInsights", "AtriumChecks"]}, ["insights-next", "insights-prev", "insights-panel", "insights-markers"]);
  register("AtriumRelated", {scripts: ["library/related-parts.js"], css: ["library/related-parts.css"], deps: []}, ["related-components"]);
  register("AtriumFieldSolver", {scripts: ["analysis/field-solver.js"], deps: ["AtriumWorkerPool", "AtriumImpedance"]});
  register("AtriumStress", {scripts: ["analysis/stress.js"], css: ["ui/analysis-panels.css", "analysis/stress.css"], deps: ["AtriumNetIntent", "AtriumVariants", "AtriumUIKit", "AtriumElectricalMaterial"]}, ["component-stress"]);
  // PDN Analyzer (pdn.js solver + worker, pdn-view.js panel and heat map): Tools menu, loaded on first use.
  register("AtriumPDN", {scripts: ["analysis/pdn.js"], deps: ["AtriumWorkerPool", "AtriumNetIntent", "AtriumLandContours", "AtriumElectricalMaterial"]});
  register("AtriumPDNView", {scripts: ["analysis/pdn-view.js"], css: ["ui/analysis-panels.css", "analysis/pdn.css"], deps: ["AtriumPDN", "AtriumStackup", "AtriumMessages", "AtriumUIKit"]}, ["pdn-analysis"]);
  // Thermal (docs/thermal.md).
  register("AtriumIPC2152", {scripts: ["analysis/ipc2152.js"], deps: ["AtriumRules", "AtriumPDN"]});
  register("AtriumThermal", {scripts: ["analysis/thermal.js"], deps: ["AtriumPDN", "AtriumStackup", "AtriumVariants"]});
  register("AtriumThermalView", {scripts: ["analysis/thermal-view.js"], css: ["ui/analysis-panels.css", "analysis/thermal.css"], deps: ["AtriumIPC2152", "AtriumThermal", "AtriumMessages", "AtriumMotion", "AtriumUIKit"]}, ["thermal-current-check", "thermal-map", "rules-current-capacity"]);
  // File › Import › Altium Project / Document… (altium-bridge.js) and schematic Find Similar
  // (sch-similar.js plus editor/find-similar-dialog.js; boards still match in pcb-edit.js,
  // so the schematic module loads only for the action on a sheet).
  register("AtriumImportReports", {scripts: ["formats/import-reports.js"], css: ["formats/import-reports.css"], deps: ["AtriumDocViews","AtriumTranslatorRegistry"]}, ["import-report"]);
  register("AtriumAltiumBridge", {scripts: ["formats/altium-bridge.js"], deps:["AtriumTranslatorRegistry"]}, ["import-altium"]);
  register("AtriumAltiumExport", {scripts: ["formats/sexpr.js", "formats/altium-export.js"], deps: ["AtriumSchematicOutput", "AtriumZip", "AtriumRules", "AtriumPCBDraw"]});
  register("AtriumAltiumProjectExport", {scripts: ["formats/altium-project-export.js"], deps: ["AtriumTranslatorClient", "AtriumZip", "AtriumSchematicOutput"]}, ["export-altium"]);
  // Design review comments (review-comments.js).
  register("AtriumSchNoteInk", {scripts:["notebook/sch-note-ink.js"]});
  register("AtriumSchNoteLeader", {scripts:["notebook/sch-note-leader.js"]});
  register("AtriumSchNoteLayer", {scripts:["notebook/sch-note-layer.js"]});
  register("AtriumSchNoteMarkup", {scripts:["notebook/sch-note-markup.js"], deps:["AtriumSchNoteInk","AtriumSchNoteLayer"]});
  register("AtriumMarkup", {scripts:["history/review-notes-model.js"], deps:["AtriumRichText","AtriumReviewComments","AtriumSheetWidgets","AtriumSchNoteInk","AtriumSchNoteLeader","AtriumSchNoteLayer"]});
  register("AtriumSketchShapes", {scripts:["notebook/sketch-shapes.js"]});
  register("AtriumReviewNotes", {scripts:["history/review-notes.js"], css:["history/review-notes.css"], deps:["AtriumMarkup","AtriumCanvasInput","AtriumSheetWidgetRuntime"]}, ["review-notes"]);
  register("AtriumReviewComments", {scripts: ["history/review-comments.js"], css: ["ui/history-panels.css", "history/review.css"]}, ["comments-panel", "comment-add", "comment-add-area", "comments-show"]);
  // Annotate mode (review-annotate.js): click or drag to comment; C M, right-click › Add Comment.
  register("AtriumReviewAnnotate", {scripts: ["history/review-annotate.js"], css: ["history/review.css"], deps: ["AtriumReviewComments", "AtriumCrossProbe"]}, ["comment-mode"]);
  // The design-diff engine (diff.js; diff-worker.js runs it off the UI thread).
  register("AtriumDiff", {scripts: ["history/diff.js"], deps: ["AtriumWorkerPool", "AtriumWaivers", "AtriumSignals", "AtriumComponentMatch", "AtriumPourMarker"]}); // worker-pool.js starts diff-worker.js
  /* diff-ui */// Visual diff: diff-model.js reads AtriumDiff (diff.js); diff-view.js is the UI,
  // diff-props.js its property tables; diff-export.js the PDF/HTML report.
  register("AtriumDiffModel", {scripts: ["history/diff-model.js"], deps: ["AtriumDiff"]});
  register("AtriumDiffView", {scripts: ["history/diff-props.js", "history/diff-view.js"], css: ["history/diff-props.css", "history/diff-view.css"], deps: ["AtriumDiffModel", "AtriumCamera", "AtriumPCBText"]}, ["diff-compare", "diff-compare-with"]);
  register("AtriumDiffExport", {scripts: ["formats/diff-export.js"], deps: ["AtriumDiffView", "AtriumPrint"]});
  register("AtriumSchSimilar", {scripts: ["schematic/sch-similar.js"], deps: ["AtriumFindSimilarDialog"]});
  register("AtriumCollabLock", {scripts: ["project/collab-lock.js"]});
  register("AtriumCollabPresence", {scripts: ["project/collab-presence.js"], css: ["project/collab.css"], deps: ["AtriumCollabLock", "AtriumPCBTextRich"]},
    ["collab-status", "collab-live", "collab-ask", "collab-release"]);
  register("AtriumCollabCRDT", {scripts: ["project/collab-crdt.js"]});
  register("AtriumCollabTransport", {scripts: ["project/collab-transport.js"], deps:["AtriumBase64"]});
  // Clipboard history (clip-history.js): Window › Panels › Clipboard and the Mod+Alt+V picker. selection-clipboard.js
  // records successful copies on demand. The visual panels mount only when opened.
  register("AtriumClipboardMedia",{scripts:["notebook/clipboard-media.js"]});
  register("AtriumHistoryArtwork", {scripts:["history/history-artwork.js"],css:["history/history-artwork.css"],deps:["AtriumPCBText"]});
  register("AtriumClipHistory", {scripts: ["history/clip-history.js"], css: ["ui/history-panels.css", "history/clip-history.css"], deps:["AtriumHistoryArtwork"]}, ["clipboard-panel", "clipboard-picker"]);
  // History panel (history-panel.js): undo steps, branches and the local history timeline.
  register("AtriumUndoStore", {scripts: ["history/undo-store.js"]});
  register("AtriumConnectivityLive", {scripts: ["checks/connectivity-live.js"]});
  register("AtriumHistoryPanel", {scripts:["history/history-panel.js"], css:["ui/history-panels.css", "history/history-panel.css"], deps:["AtriumUndoStore"]}, ["history-panel"]);
  register("AtriumVisualHistory", {scripts:["history/history-edits.js","history/visual-history.js"], deps:["AtriumHistoryArtwork"]});
  register("AtriumHistorySession", {scripts:["history/history-session.js"], deps:["AtriumHistoryPanel","AtriumVisualHistory","AtriumClipHistory","AtriumPastePlan","AtriumProposal"]});
  // Git for designs: the revision picker and AtriumGit (git-picker.js), file history,
  // semantic blame, and the visual three-way merge of project revisions.
  register("AtriumGitPicker", {scripts: ["history/git-picker.js"], css: ["history/git.css"]}, ["compare-branches", "changes-since-opened", "git-merge-driver", "git-commit", "review-changes"]);
  register("AtriumProjectHistoryData", {scripts: ["history/project-history-summary.js", "history/project-history-data.js"], deps: ["AtriumWorkerPool"]});
  register("AtriumCommitGraph", {scripts: ["ui/commit-graph.js"]});
  register("AtriumHistoryEntry", {scripts: ["history/history-entry.js"], css: ["history/history.css"]},
    ["history", "history-working", "history-object", "project-history", "file-history", "object-history"]);
  register("AtriumSourceHistory", {scripts: ["history/source-history.js"], deps: ["AtriumGitPicker", "AtriumProjectHistoryData"]});
  register("AtriumHistoryView", {scripts: ["history/history-view.js"], deps: ["AtriumHistoryEntry", "AtriumCommitGraph", "AtriumDocViews", "AtriumSourceHistory", "AtriumUndoStore", "AtriumUIKit"]});
  register("AtriumFileHistory", {scripts: ["history/file-history.js"], deps: ["AtriumSourceHistory", "AtriumUIKit"]});
  register("AtriumBlame", {scripts: ["history/blame.js"], css: ["history/git.css"], deps: ["AtriumGitPicker"]});
  register("AtriumMerge3", {scripts: ["history/merge3.js"]});
  register("AtriumMergeUI", {scripts: ["history/merge-ui.js"], css: ["history/git.css"], deps: ["AtriumMerge3", "AtriumGitPicker"]}, ["merge-conflicts", "merge-files"]);
  on({schematic: ["AtriumSchSimilar"]}, "find-similar");
  on(["AtriumExtensions"], "extensions", "scripting-console");
  // Browse Extensions (extension-registry.js), opened from the Extensions manager. Off until the user
  // sets a registry URL or opens an index file: loading it makes no request.
  register("AtriumExtensionRegistry", {scripts: ["extension-host/extension-registry.js"], css: ["extension-host/extension-registry.css"], deps: ["AtriumExtensions"]});
  // Extension developer tools (extension-dev.js): the Preferences page for developer mode, New Extension…
  // (scaffold zip) and Load unpacked…; AtriumExtensions loads only when used.
  register("AtriumExtensionDev", {scripts: ["extension-template.js", "extension-host/extension-dev.js"], css: ["extension-host/extension-dev.css"]});
  on(["AtriumFabOutputs"], "fab", "fab-outputs");
  on(["AtriumSTEP"], "step");
  register("Atrium3D", {scripts:["canvas/view3d.js"], deps:["AtriumGeometry","AtriumCamera"]});
  on({pcb: ["Atrium3D", "AtriumSTEP", "AtriumFlexFold"]}, "view-3d");
  on(["AtriumFabProfiles"], "fabProfiles");
  on(["AtriumViaFence"], "via-fence", "fence-selected", "fence-edge", "fence-area", "fence-return", "fence-regenerate", "fence-remove");
  on(["AtriumLength"], "length", "length-tune", "length-tune-pair", "length-tune-skew", "length-tune-phase", "phase-tune-static");
  on(["AtriumLogo"], "logo");
  on(["AtriumLength"], "timing-vision", "timing-vision-live");
  on(["AtriumDRCMarkers"], "drc-markers");
  on(["AtriumDRCInspector"], "drc-next", "drc-prev");
  on(["AtriumLasso"], "lasso-select");
  on(["AtriumGuides"], "align-left", "align-right", "align-top", "align-bottom", "align-hcenter", "align-vcenter", "distribute-h", "distribute-v",
    "align-grid", "make-row", "make-column");
  on({pcb: ["AtriumDesignatorPlan"]}, "designators-place");
  on(["AtriumPalette"], "command-palette", "goto-object", "goto-location");
  on(["AtriumKeymapEditor"], "keyboard-shortcuts");
  on(["AtriumAltiumKeys"], "net-click", "highlight-filter-clear", "select-net-pick", "move-selection", "drag-object", "board-properties", "layer-next", "layer-prev",
    "layer-signal-next", "delete-pick", "select-inside", "select-outside", "unroute-all", "unroute-connection", "unroute-component", "unroute-room", "route-width-pick", "route-via-pick");
  // Altium chords part 2, split-pane tab strips (loaded on split), Design › Simulate.
  register("AtriumAltiumTools", {scripts: ["schematic/altium-tools.js"], css: ["schematic/altium-tools.css"], deps: ["AtriumGeometry", "AtriumAltiumKeys", "AtriumGuides"]},
    ["select-touching", "select-connection", "select-physical", "align-dialog", "spacing-h-more", "spacing-h-less", "spacing-v-more", "spacing-v-less",
      "autoroute-room", "layer-next", "layer-prev", "move-corner-mode", "move-properties"]);
  register("AtriumSplitTabs", {scripts: ["project/split-tabs.js"], deps: ["AtriumSpatialMotion"]}, ["focus-pane-next", "focus-pane-prev", "focus-pane-other"]);
  // Schematic | Board split with Follow (split-follow.js), loaded with a split.
  register("AtriumSplitFollow", {scripts: ["project/split-follow.js"], css: ["project/split-follow.css"], deps: ["AtriumCamera", "AtriumCrossProbe"]}, ["split-counterpart", "split-follow"]);
  register("AtriumSimMenu", {scripts: ["analysis/sim-menu.js"], css: ["schematic/altium-tools.css"], deps: ["AtriumExtensions"]}, ["simulate", "simulate-op", "simulate-dc", "simulate-ac", "simulate-tran"]);
  // Netlists (netlist.js), multi-routing and bus routing (multi-route.js, bus-route.js; Route menu).
  register("AtriumRuleLint", {scripts: ["checks/rule-lint.js"], deps: ["AtriumRules"]});
  register("AtriumNetlistText", {scripts: ["schematic/netlist-text.js"], deps: ["AtriumNetlist", "AtriumSignals", "AtriumERC"]});
  register("AtriumNetlistView", {scripts: ["schematic/netlist-view.js"], css: ["schematic/netlist-view.css"], deps: ["AtriumNetlistText", "AtriumDocViews", "AtriumCrossProbe"]}, ["netlist-view"]);
  register("AtriumSheetOverviewModel", {scripts: ["notebook/sheet-overview-model.js"]});
  register("AtriumSheetOverview", {scripts: ["notebook/sheet-overview.js"], css: ["notebook/sheet-overview.css"],
    deps: ["AtriumDocViews", "AtriumSheetOverviewModel", "AtriumSheetConnections", "AtriumConnectionPreview", "AtriumCamera"]}, ["sheet-overview"]);
  register("AtriumNetlist", {scripts: ["schematic/netlist.js"], deps: ["AtriumECO"]}, ["import-netlist", "export-netlist-kicad", "export-netlist-protel", "export-netlist-csv"]);
  // ECAD-MCAD (docs/mcad.md)
  register("AtriumXML", {scripts: ["formats/mcad-xml.js"]});
  register("AtriumMCAD", {scripts: ["formats/mcad.js", "formats/mcad-idx.js", "formats/mcad-idf.js"], deps: ["AtriumXML", "AtriumSTEP"]});
  register("AtriumMCADStep", {scripts: ["formats/mcad-step.js"], deps: ["AtriumMCAD", "AtriumSTEPImport", "AtriumCollision3D"]});
  register("AtriumMCADPanel", {scripts: ["formats/mcad-panel.js"], css: ["formats/mcad.css"], deps: ["AtriumMCADStep", "AtriumMotion"]}, ["export-idx-baseline", "export-idx-changes",
    "export-idx-response", "export-idf", "import-idx", "import-enclosure", "import-step-outline", "mcad-panel"]);
  register("AtriumMultiRoute", {scripts: ["pcb/multi-route.js", "pcb/bus-route.js"], css: ["pcb/bus-route.css"], deps: ["AtriumRouter"]}, ["route-multi", "route-bus", "bus-tune-group"]);
  // Help › Your First Board Tutorial (tutorial.js): the docked coach card.
  /* perf-ui: design authoring (sch-author.js) is lazy; only the tutorial uses it in the app */ register("AtriumSchAuthor", {scripts: ["schematic/sch-author.js"]});
  register("AtriumTutorial", {scripts: ["editor/tutorial.js"], css: ["editor/tutorial.css"], deps: ["AtriumSchAuthor"]}, ["tutorial"]);
  // Get set up (welcome.js): the first-launch walkthrough.
  register("AtriumWelcome", {scripts: ["editor/welcome.js"], css: ["editor/welcome.css"]}, ["customise-waffle"]);
  // Camera and mouse (camera.js; Preferences › Mouse): wheel presets, view history, saved views, fly-to, arrow/WASD pan,
  // edge scroll and jump to the last alert. Selection memory (Mod/Alt+1…9) and the minimap build on it.
  // The camera loads when the editor is first idle, so the wheel preset applies from then on.
  register("AtriumCamera", {scripts: ["canvas/camera.js"], css: ["canvas/camera.css"], deps:["AtriumMotion"]}, ["view-back", "view-forward", "jump-alert",
    "camera-zoom-selection", "camera-turn-left", "camera-turn-right", "camera-turn-reset",
    ...["left", "right", "up", "down"].flatMap(d => ["camera-pan-" + d, "camera-pan-" + d + "-fast"]),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(n => ["camera-store-" + n, "camera-recall-" + n])]);
  register("AtriumSelectionMemory", {scripts: ["editor/selection-memory.js"], css: ["canvas/camera.css"], deps: ["AtriumCamera"]},
    ["selection-memory", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(n => ["selmem-store-" + n, "selmem-add-" + n, "selmem-recall-" + n])]);
  register("AtriumMinimap", {scripts: ["canvas/minimap.js"], css: ["canvas/camera.css"], deps: ["AtriumCamera"]}, ["minimap"]);
  register("AtriumMotionUI", {scripts: ["ui/motion.js"]});
  register("AtriumSpatialMotion", {scripts: ["ui/spatial-motion.js"], css: ["ui/spatial-motion.css"], deps: ["AtriumMotionUI"]});
  register("AtriumTooltip", {scripts:["ui/tooltip.js"],deps:["AtriumMotionUI","AtriumCanvasHover"]});
  register("AtriumSurfaceMotion", {scripts:["ui/surface-motion.js"], deps:["AtriumMotionUI"]});
  register("AtriumMotion", {scripts: ["editor/editor-motion.js"], deps:["AtriumSurfaceMotion"]});
  register("AtriumMotionDiagnostics", {scripts:["editor/motion-service.js"], deps:["AtriumMotion","AtriumButter","AtriumButterCatalog"]});
  // Colour themes (docs/themes.md): the theme library (schema, built-in themes, registry), the picker
  // (Ctrl/⌘+K Ctrl/⌘+T) with the Appearance gallery, and the theme editor. theme.js stays eager and tiny.
  register("AtriumThemes", {scripts: ["editor/theme-library.js"]});
  register("AtriumThemePicker", {scripts: ["editor/theme-picker.js"], css: ["editor/theme-ui.css"], deps: ["AtriumThemes"]}, ["theme-picker"]);
  register("AtriumThemeEditor", {scripts: ["editor/theme-editor.js"], css: ["editor/theme-ui.css"], deps: ["AtriumThemes", "AtriumThemePicker"]}, ["theme-editor"]);
  // VS Code keys (vscode-keys.js): quick open, the Ctrl+Tab switcher, close/reopen document, focus, F2 rename and
  // the cheat sheet overlay. Prefetched when idle so the document history starts with the session.
  register("AtriumVSKeys", {scripts: ["editor/vscode-keys.js"], css: ["editor/vscode-keys.css"], deps: ["AtriumUIKit"]}, ["quick-open", "doc-next", "doc-prev", "close-document",
    "reopen-document", "focus-projects", "rename-object", "shortcuts", "cheatsheet"]);
  // Closing document tabs (doc-tabs.js): the tab menu's Close commands and the unsaved-changes prompt; idle-prefetched
  // (editor-demand.js) so each document's saved state is known.
  register("AtriumDocTabs", {scripts: ["project/doc-tabs.js"], css: ["project/doc-tabs.css"], deps: ["AtriumVSKeys", "AtriumSpatialMotion"]});
  on(["AtriumPinSwap"], "pin-swap", "gate-swap", "swap-optimise");
  on(["AtriumPanel"], "panelize");
  on(["AtriumAI"], "mcp");
  on(["AtriumMessages"], "messages");
  on(["AtriumChecks", "AtriumMessages"], "show-problems");
  on(["AtriumRules", "AtriumImpedance", "AtriumQuery"], "rules");
  on(["AtriumStackup", "AtriumImpedance", "AtriumRigidFlex"], "stackup");
  on(["AtriumViaStack"], "viaStack", "viaTemplates");
  on(["AtriumComponentClasses"], "component-classes");
  on(["AtriumQuery"], "query-panel", "query-clear");
  on(["AtriumNavigatorPanel"], "navigator-panel");
  on(["AtriumLayerSets"], "layer-sets");
  on(["AtriumDynamicSymbol"], "dynamic-connector", "dynamic-connector-pins");
  register("AtriumGenericPartsUI", {scripts: ["library/generic-parts.js", "library/connector-gen.js", "library/placeholder-parts.js", "library/generic-parts-ui.js", "library/placeholder-ui.js"], css: ["library/generic-parts.css"], deps: ["AtriumLibrary", "AtriumDynamicSymbol", "AtriumSymbolWizard"]}, [..."resistor capacitor polarised electrolytic inductor ferrite diode led crystal fuse testpoint jumper part connector bind placeholder".split(" ").map(a => "generic-" + a), "placeholder-resolve", "dynamic-connector-finalise", "dynamic-connector-add-part"]); // generic parts
  on(["AtriumRooms"], "room-move", "rooms-fit", "rooms-lock", "rooms-show", "room-replicate", "mc-sync", "multichannel");
  on(["AtriumECO", "AtriumRooms"], "eco");
  // Lazy-dispatch audit (round 3, bug 4): every action whose handler reaches a lazy module is
  // listed here, so the editor's gate loads it before the handler runs. scripts/click-through.sh
  // runs each action in a fresh page and fails on any "unavailable in this build".
  on(["AtriumECO", "AtriumRooms"], "eco-reverse");
  on(["AtriumArrange"], "arrange-board", "arrange-rect");
  on(["AtriumSupportPlace"], "place-decoupling", "place-terminations", "place-support");
  on(["AtriumLibrary"], "component-new");
  on(["AtriumECO"], "save", "sync-settings");
  on(["AtriumRules"], "repour", "repour-selected");
  on({pcb: ["AtriumViaStack","AtriumRules"]}, "via");
  on(["AtriumLibrary"], "library-panel", "library-workspace", "library-sources", "footprint-wizard", "footprint-editor", "symbol-editor", "edit-footprint", "edit-symbol");
  // Symbol Wizard (symbol-wizard.js): a symbol from a datasheet pin table.
  register("AtriumSymbolWizard", {scripts: ["library/symbol-wizard.js"], css: ["library/symbol-wizard.css"], deps: ["AtriumLibrary"]}, ["symbol-wizard"]);
  on(["AtriumSwap"], "swap-components", "swap-components-origin", "swap-library", "swap-variant", "swap-variant-back", "swap-variant-pick");
  on(["AtriumSymbols"], "symbols");
  on(["AtriumPCBEdit", "AtriumTeardrops"], "teardrops");
  on(["AtriumPCBEdit"], "flip-side", "flip-board", "lock", "unlock", "union-create", "union-break", "union-add", "snap-object", "snap-options", "hud");
  on({pcb: ["AtriumPCBLayerBar"]}, "layer-controls");
  on({pcb: ["AtriumPCBLayerBar", "AtriumViewConfig"]}, "view-config");
  register("AtriumRouteSuggest", {scripts: ["pcb/route-suggest-engine.js", "pcb/route-habits.js", "pcb/route-suggest.js"], css: ["pcb/route-suggest.css"], deps: ["AtriumRouter", "AtriumWorkerPool"]}, ["accept", "next", "prev", "word", "dismiss", "toggle"].map(a => "route-suggest-" + a).concat("route-habits")); // route suggestions
  on(["AtriumRigidFlex"], "view-planning", "split-region", "add-bend-line");

  registeringBuiltins = false;
  // Use existing command metadata and a few shared-menu exceptions. Never report the action ID.
  const diagnosticModules = new Set(["AtriumPerformanceDiagnostics","AtriumInputDiagnostics","AtriumFrameMonitor","AtriumMotionDiagnostics"]);
  const diagnosticActions = new Set(["frame-monitor","crash-diagnostics","input-diagnostics"]);
  const isDiagnosticAction = action => diagnosticActions.has(action);
  const commandCategories = {Project:"project",Routing:"routing",Reports:"manufacturing",Window:"ui",Help:"ui",Extensions:"extensions"};
  const commandFamilies = {
    "save":"save","save-all":"save","save-as":"save","save-project-zip":"save",
    "open":"project","new":"project","drc":"drc","erc":"erc","connectivity":"connectivity","review-changes":"history",
    "import-altium":"import","import-dxf":"import","export-dxf":"export","export":"export",
    "repour":"pours","repour-selected":"pours","polygon-pour":"pours","undo":"history","redo":"history",
    "view-3d":"3d","view-2d":"3d","panelize":"panel","mcp":"automation","preferences":"settings","preferences-page":"settings"
  };
  function diagnosticAction(action,kind) {
    if (typeof action !== "string" || isDiagnosticAction(action)) return null;
    if (Object.hasOwn(commandFamilies,action)) return commandFamilies[action];
    const command = globalThis.AtriumKeymap?.command?.(action);
    if (!command?.builtin && !builtinEntries.has(ACTIONS[action])) return null;
    if (action === "route" && kind === "pcb") return "routing";
    if (command?.builtin && Object.hasOwn(commandCategories,command.category)) return commandCategories[command.category];
    return kind === "pcb" || kind === "schematic" || kind === "drawing" || kind === "panel" || kind === "3d" ? kind : "editor";
  }

  const scripts = new Map(), sheets = new Map(), loads = new Map();
  const doc = () => globalThis.document;
  const canonical = name => ALIAS[name] || name;
  const list = names => (Array.isArray(names) ? names : [names]).filter(Boolean);
  // Loaded with its dependencies: the gate in editor.js runs an action at once only then.
  const has = names => list(names).every(n => globalThis[n] != null && (n !== "AtriumEngine" || globalThis[n].settled !== false)) && closure(names).every(n => !MODULES[n] || !loads.has(n) && !missing(MODULES[n]).length);

  // Modules in dependency order, each once.
  function closure(names, out = [], seen = new Set()) {
    for (const raw of list(names)) {
      const n = canonical(raw);
      if (seen.has(n)) continue;
      seen.add(n);
      if (MODULES[n]?.deps) closure(MODULES[n].deps, out, seen);
      out.push(n);
    }
    return out;
  }
  function script(src) {
    if (scripts.has(src)) return scripts.get(src);
    const p = new Promise((resolve, reject) => {
      const d = doc(), s = d.createElement("script");
      s.src = src; s.async = false; // async=false: injected scripts run in insertion order.
      s.onload = () => { done.add(src); resolve(); };
      s.onerror = () => { scripts.delete(src); s.remove?.(); reject(Error("Couldn't load " + src + ".")); };
      (d.head || d.body).append(s);
    });
    scripts.set(src, p);
    return p;
  }
  function sheet(href) {
    if (sheets.has(href)) return sheets.get(href);
    const d = doc();
    const there = [...(d.querySelectorAll?.('link[rel="stylesheet"]') || [])].some(l => l.getAttribute("href") === href);
    // A missing stylesheet must not stop the feature: resolve on error too.
    const p = there ? Promise.resolve() : new Promise(resolve => {
      const l = d.createElement("link");
      l.rel = "stylesheet"; l.href = href; l.onload = l.onerror = () => resolve();
      // A deferred editor stylesheet keeps its original place in the cascade.
      const slot = d.getElementById?.("lazy-style:" + href);
      if (slot) slot.before(l);
      else (d.head || d.body).append(l);
    });
    sheets.set(href, p);
    return p;
  }
  // A module is loaded when every one of its files has defined its global.
  // A file with no known global (a registered module's second and later files) counts once its
  // script has loaded.
  const done = new Set();
  const missing = m => m.scripts.filter(src => DEFINES[src] ? globalThis[DEFINES[src]] == null : !done.has(src));
  function beginLoad(n) {
    const perf = globalThis.AtriumDiagnostics?.performance;
    return perf && !diagnosticModules.has(n) ? perf.begin("ui","load") : null;
  }
  function load(n, measure = true) {
    const m = MODULES[n];
    if (!m) return globalThis[n] != null ? Promise.resolve(globalThis[n]) : Promise.reject(Error(n + " is not available in this build."));
    const pending = loads.get(n);
    if (pending) {
      // If ordinary demand joins a diagnostics request, measure only the ordinary demand's wait.
      if (measure && pending.passive) {
        pending.passive = false;
        pending.span = beginLoad(n);
      }
      return pending.promise;
    }
    const files = missing(m);
    if (!files.length) return Promise.resolve(globalThis[n]);
    if (!doc()?.createElement) return Promise.reject(Error(n + " is not loaded."));
    const flight = {passive:!measure, span:measure ? beginLoad(n) : null, promise:null};
    flight.promise = Promise.all([...files.map(script), ...(m.css || []).map(sheet)]).then(() => {
      loads.delete(n);
      if (missing(m).length) {
        flight.span?.end("failed");
        throw Error(n + " did not load.");
      }
      loaded(n);
      flight.span?.ready();
      flight.span?.end("completed");
      return globalThis[n];
    }, e => { loads.delete(n); flight.span?.end("failed"); throw e; });
    loads.set(n, flight);
    return flight.promise;
  }
  let engineMissing = false;
  function need(names, options) {
    const wanted = list(names), measure = options?.measure !== false;
    // Dependencies are requested first; async=false keeps their execution order.
    return Promise.all(closure(wanted).map(n => {
      if (n !== "AtriumEngine") return load(n,measure);
      return load(n,measure).then(e => e.loadBrowser?.()).catch(error => {
        if (wanted.length === 1 || globalThis.ATRIUM_ENGINE === "wasm") throw error;
        engineMissing = true; // Board commands can still run their JS kernels if the bridge itself is missing.
      });
    })).then(() => {
      const out = wanted.map(n => { if (globalThis[n] == null && !(n === "AtriumEngine" && engineMissing)) throw Error(n + " did not load."); return globalThis[n]; });
      return Array.isArray(names) ? out : out[0];
    });
  }
  // Keep first-use controls in their original position and preserve any field being edited.
  // Reselecting or replacing the panel while the script loads discards its old insertion point.
  function appendOnLoad(name, parent, build, info) {
    const d = parent.ownerDocument, wasConnected = parent.isConnected;
    const marker = d.createComment(name);
    parent.append(marker);
    // A control can request another control while the outer fragment is being assembled.
    // Its marker moves into the live section when the outer fragment is inserted.
    const current = () => parent.nodeType === 11 && marker.isConnected ||
      marker.parentNode === parent && (!wasConnected || parent.isConnected);
    need(name).then(ui => {
      if (!current()) return;
      const fields = d.createDocumentFragment();
      build(ui, fields);
      marker.replaceWith(fields);
    }, e => {if (current()) info?.(e.message);});
  }
  const pending = names => closure(names).some(n => loads.has(n));

  const idle = cb => (globalThis.AtriumIdle ? AtriumIdle.idle(cb, {timeout: 2000}) : globalThis.requestIdleCallback ? requestIdleCallback(cb, {timeout: 2000}) : setTimeout(cb, 50));
  const cancelIdle = id => globalThis.AtriumIdle ? AtriumIdle.cancel(id) : globalThis.cancelIdleCallback ? globalThis.cancelIdleCallback(id) : clearTimeout(id);
  const visible = () => doc()?.visibilityState !== "hidden" && globalThis.AtriumPower?.visible?.() !== false;
  const mayPrepare = () => visible() && !globalThis.AtriumPower?.efficient?.();
  const preparations = new Set();
  function cancelPreparations() { for (const stop of preparations) stop(); }
  function prefetch(names) {
    let ticket = null, stopped = false;
    function stop() {
      stopped = true;
      if (ticket != null) cancelIdle(ticket);
      preparations.delete(stop);
    }
    if (!mayPrepare()) return stop;
    const queue = closure(names).filter(n => MODULES[n] && missing(MODULES[n]).length);
    function next() {
      if (stopped || !queue.length || !mayPrepare()) { stop(); return; }
      ticket = idle(() => {
        ticket = null;
        if (stopped || !mayPrepare()) { stop(); return; }
        load(queue.shift()).then(next, stop);
      });
    }
    preparations.add(stop);
    next();
    return stop;
  }
  function forAction(action, kind) {
    if (globalThis.AtriumLabs?.allowsAction(action) === false) return null;
    const v = ACTIONS[action];
    if (!v) return null;
    const names = Array.isArray(v) ? v : v[kind];
    // Board commands that use these kernels opt in. Interactive routing uses its own JS search.
    if (!engineMissing && kind === "pcb" && ["repour", "repour-selected", "drc", "connectivity"].includes(action) &&
        doc()?.visibilityState !== "hidden" && globalThis.AtriumPower?.visible?.() !== false) return [...(names || []), "AtriumEngine"];
    return names?.length ? names : null;
  }
  // Modules model.validate() consults for project fields, so opened files validate fully.
  // Sheet symbols make a project hierarchical; repeated sheets need AtriumMultichannel.
  const hierarchical = project => !!project?.documents?.some?.(d => d?.kind === "schematic" && d.items?.some?.(i => i?.kind === "sheetsymbol"));
  // TrueType, barcode or knockout text on a board, in its imported annotations or in a footprint.
  const richText = t => t?.font === "truetype" || t?.font === "barcode" || t?.inverted === true;
  const richShapes = f => f?.shapes?.some?.(richText);
  const richBoard = project => !!project?.documents?.some?.(d => d?.kind === "pcb" && (d.items?.some?.(i => richText(i) || richShapes(i?.footprint)) ||
    Object.values(d.pcbDrawing?.annotations || {}).some(rows => Array.isArray(rows) && rows.some(richText)))) || !!project?.library?.some?.(def => richShapes(def?.footprint));
  function boardRenderers(project) {
    const out = [];
    // Reference-only board rows need no geometry. Materialized owners can inspect
    // copper synchronously on their first frame, including after a folder reload.
    if (!globalThis.AtriumGeometryCurves && project?.documents?.some?.(d => d?.kind === "pcb" &&
      (Array.isArray(d.items) || d.boardShape?.cutouts?.length)))
      out.push("AtriumGeometryCurves");
    if (!globalThis.AtriumNetsPanel && project?.documents?.some?.(d => d.kind === "pcb" && Object.keys(d.netColors || {}).length))
      out.push("AtriumNetsPanel");
    if (!globalThis.AtriumPCBPours && project?.documents?.some?.(d => d.kind === "pcb" && d.pcbDrawing?.pours?.length))
      out.push("AtriumPCBPours");
    if (!globalThis.AtriumPCBText && project?.documents?.some?.(d => d.kind === "pcb" && d.items?.length))
      out.push("AtriumPCBText");
    if (!globalThis.AtriumPCBNetLabels && project?.documents?.some?.(d => d.kind === "pcb" && d.items?.length))
      out.push("AtriumPCBNetLabels");
    if (!globalThis.AtriumPCBTextRich && richBoard(project)) out.push("AtriumPCBTextRich");
    if (!globalThis.AtriumDesignators && project?.documents?.some?.(d => d.kind === "pcb" && d.items?.some(i => i.designator)))
      out.push("AtriumDesignators");
    if (!globalThis.AtriumCanvasBoardBatches && project?.documents?.some?.(d => globalThis.AtriumCanvas?.needsBoardBatches?.(d)))
      out.push("AtriumCanvasBoardBatches");
    return out;
  }
  function validatorsFor(project) {
    const documents = Array.isArray(project?.documents) ? project.documents : [], notebook = globalThis.AtriumLabs?.notebookEnabled() !== false;
    const out = [];
    if (!notebook && documents.some(d => d?.kind === "schematic" && d.items?.some(i => globalThis.Atrium?.notebookItemKind?.(i))))
      out.push("AtriumNotebookCompat");
    if (notebook && documents.some(d=>d?.items?.some?.(i=>i?.widget))) out.push("AtriumWidgetCatalogue");
    if (notebook && documents.some(d=>d?.kind==="schematic" && d.items?.some?.(i=>i?.sticky || i?.callout || i?.ink))) out.push("AtriumReviewNotes");
    if (notebook && documents.some(d=>d?.items?.some?.(i=>i?.widget?.state?.tableVersion===1))) out.push("AtriumTableData","AtriumNotebook");
    if (project?.bomViews != null) out.push("AtriumBOM");
    if (project?.layoutBlocks != null) out.push("AtriumBlocks");
    if (project?.library?.some?.(d => d?.dynamic)) out.push("AtriumDynamicSymbol");
    if (project?.ruleSets != null) out.push("AtriumRuleSets");
    if (documents.some(d => d?.kind === "panel")) out.push("AtriumPanel");
    if (documents.some(d => d?.kind === "drawing")) out.push("AtriumDrawing");
    if (project?.variants != null) out.push("AtriumVariants");
    if (notebook && documents.some(d => d.kind === "schematic" &&
        d.items?.some?.(i => i?.kind === "calculation" || i?.kind === "textframe" && i.calculation != null))) out.push("AtriumCalculationRecords");
    if (project?.revision != null || project?.revisions != null || project?.revisionStore != null) out.push("AtriumRevisions");
    if (project?.multichannel != null || hierarchical(project)) out.push("AtriumMultichannel");
    // Rule sets are validated by AtriumRules; boards also want the rest of the board core.
    if (project?.rules != null || documents.some(d => d?.kind === "pcb" || d?.rules != null)) out.push("AtriumRules");
    if (AtriumRuleScopeDemand(project?.rules) || documents.some(d=>AtriumRuleScopeDemand(d?.rules))) out.push("AtriumDesignQuery");
    if (project?.signals != null) out.push("AtriumSignals");
    if (notebook) {
      if (documents.some(d => d?.kind === "schematic" && d.items?.some?.(i => i?.kind === "textframe" && i.math === true))) out.push("AtriumMath");
      if (documents.some(d => d.items?.some(i => i.richText))) out.push("AtriumNotebook");
      if (documents.some(d => d.items?.some(i => i.kind === "imageMarkup"))) out.push("AtriumSchNoteMarkup", "AtriumNotebookImages");
      else if (documents.some(d => d.items?.some(i => i.kind === "image" && i.asset))) out.push("AtriumNotebookImages");
    }
    return out.concat(boardRenderers(project));
  }
  function register(name, spec, actions = []) {
    MODULES[name] = {scripts: [...spec.scripts], css: spec.css ? [...spec.css] : undefined, deps: spec.deps ? [...spec.deps] : undefined};
    if (spec.scripts.length === 1) DEFINES[spec.scripts[0]] ??= name;
    if (registeringBuiltins) on([name], ...actions);
    else for (const a of actions) ACTIONS[a] = [name];
  }
  // Files in dependency order, for runners that load them without a DOM.
  function files(names = Object.keys(MODULES)) {
    const out = [];
    for (const n of closure(names)) for (const s of MODULES[n].scripts) if (!out.includes(s)) out.push(s);
    return out;
  }
  const stylesheets = () => [...new Set(Object.values(MODULES).flatMap(m => m.css || []))];

  // ---- stubs for lazy modules that register things at load time --------------------------
  // Keymap commands a lazy module registers once it loads (library-panel.js registerCommands).
  // The stubs dispatch the same editor action, which loads the module through the editor's
  // gate (editor.js lazyGate); the module re-registers the same ids when it arrives.
  const COMMANDS = {
    AtriumLibrary: [["library-panel", "Library panel", "Window", "T L"], ["footprint-wizard", "IPC footprint wizard…", "Tools", "T F"],
      ["footprint-editor", "New footprint / edit selected footprint…", "Tools", null], ["symbol-editor", "New symbol / edit selected symbol…", "Tools", "T Y"],
      ["library-sources", "Library sources (.atrlib files)…", "Tools", null]].map(([id, t, c, k]) => ["library:" + id, id, t, c, k]),
    AtriumMultichannel: [["multichannel:multichannel", "multichannel", "Multichannel…", "Project", null], ["multichannel:mc-sync", "mc-sync", "Update board from channels", "Design", "D M U"],
      ["multichannel:room-replicate", "room-replicate", "Copy room formats (replicate layout)…", "Design", "D M C", "pcb"]],
    AtriumMultiRoute: [["bus:route-bus", "route-bus", "Interactive bus routing", "Place", "P M", "pcb"]],
    AtriumRooms: [["room-move", "Move room", "D M M"], ["rooms-fit", "Fit rooms to components", "D M F"], ["rooms-lock", "Lock or unlock rooms", null],
      ["rooms-show", "Show rooms", null]].map(([id, t, k]) => ["rooms:" + id, id, t, "Design", k, "pcb"])
  };
  // Menu items a lazy module adds when it loads (rooms.js install): [menu, action, label, options].
  const MENUS = {
    AtriumCollabPresence: [["project", "collab-status", "Collaboration…", {after: "review-changes", separator: true}],
      ["project", "collab-live", "Live Session…", {after: "collab-status"}], ["project", "collab-ask", "Ask to Edit Document", {after: "collab-live"}],
      ["project", "collab-release", "Release Document Lock", {after: "collab-ask"}]],
    AtriumComponentClasses: [["design", "component-classes", "Classes…", {after: "constraints", scope: "pcb"}]],
    AtriumDynamicSymbol: [["place", "dynamic-connector", "Dynamic Connector", {after: "sch-power", scope: "schematic"}],
      ["design", "dynamic-connector-pins", "Dynamic Connector Pins…", {after: "symbol-editor", scope: "schematic"}]],
    AtriumVariants: [["project", "variants", "Variants…", {after: "compare"}]],
    AtriumInsightsUI: [["tools", "insights-panel", "List Design Insights", {after: "drc-prev"}], ["tools", "insights-next", "Next Insight", {after: "insights-panel"}],
      ["tools", "insights-prev", "Previous Insight", {after: "insights-next"}], ["view", "insights-markers", "Design Insights", {after: "minimap", checkable: true}]],
    AtriumDRCView: [["tools", "drc-online", "Online DRC", {after: "drc", checkable: true, scope: "pcb"}], ["tools", "drc-clear", "Clear DRC Markers", {after: "drc-online"}],
      ["tools", "drc-waivers", "DRC Waivers…", {after: "drc-clear", scope: "pcb"}], ["tools", "drc-next", "Next Violation", {after: "drc-waivers", scope: "pcb"}],
      ["tools", "drc-prev", "Previous Violation", {after: "drc-next", scope: "pcb"}]],
    AtriumPalette: [["view", "command-palette", "Command Palette…", {after: null}], ["edit", "goto-object", "Jump to Object…", {after: "select-all"}],
      ["edit", "goto-location", "Jump to Location…", {after: "goto-object"}]],
    AtriumMultichannel: [["project", "multichannel", "Multichannel…", {after: "blocks"}], ["design", "mc-sync", "Update Board from Channels", {separator: true}],
      ["design", "room-replicate", "Rooms: Copy Room Formats…", {after: "mc-sync", scope: "pcb"}]],
    AtriumRooms: [["design", "room-move", "Rooms: Move Room", {scope: "pcb"}], ["design", "rooms-fit", "Rooms: Fit Rooms to Components", {after: "room-move", scope: "pcb"}],
      ["design", "rooms-lock", "Rooms: Lock / Unlock Rooms", {after: "rooms-fit", scope: "pcb"}], ["design", "rooms-show", "Rooms: Show Rooms", {after: "rooms-lock", scope: "pcb", checkable: true}]]
  };
  function stubCommands() {
    const K = globalThis.AtriumKeymap;
    if (!K?.registerCommand) return;
    for (const [name, list] of Object.entries(COMMANDS)) {
      if (globalThis[name] != null) continue;
      for (const [id, action, title, category, key, when] of list) {
        try { if (!K.command?.(id)) K.registerCommand({id, title, category, action, ...(when ? {when} : {}), defaultKeys: key ? [key] : []}); } catch { /* built in */ }
      }
    }
    const N = globalThis.AtriumNavCommon;
    for (const [name, list] of Object.entries(MENUS)) if (globalThis[name] == null) for (const [menu, action, label, o] of list) N?.menuItem?.(menu, action, label, o);
  }
  // Coalesce updates for newly available readers. A channel load also updates the Projects
  // tree, so it supersedes a board-only redraw in the same batch.
  let notify = 0;
  function loaded(name) {
    if (name !== "AtriumMultichannel" && (notify || !BOARD.includes(name) && !["AtriumVariants", "AtriumPCBText", "AtriumPCBTextRich", "AtriumPCBNetLabels"].includes(name))) return;
    clearTimeout(notify);
    notify = setTimeout(() => { notify = 0; try { globalThis.AtriumNavHost?.moduleLoaded?.(name); } catch (e) { globalThis.console?.error?.(e); } }, 0);
  }
  // The visible board uses these readers for layers, objects, fills and design rules.
  const BOARD = ["AtriumStackup", "AtriumViaStack", "AtriumPolygonPour", "AtriumRooms", "AtriumRules", "AtriumPCBDraw"];
  function launchUpdateDue(version) {
    if (!version) return false;
    try {
      const store = globalThis.localStorage;
      let saved;
      try { saved = JSON.parse(store?.getItem("atrium.update") || "null"); } catch {saved = null;}
      if (saved?.format === "atrium-update" && saved.version > 1) return false;
      const state = saved?.format === "atrium-update" ? saved : {format: "atrium-update", version: 1};
      if (!state.lastVersion) {
        state.lastVersion = version;
        store?.setItem("atrium.update", JSON.stringify(state));
      }
      if (state.lastVersion !== version) return true;
      const optedIn = (globalThis.AtriumPrefs || globalThis.AtriumPref)?.get("general.updateCheck") === true;
      return optedIn && Date.now() - (state.lastCheck || 0) >= 86400000;
    } catch {return (globalThis.AtriumPref?.get?.("general.updateCheck") === true);}
  }
  // Keep the evaluator and control implementation cold until a numeric entry is used.
  function numericField(input, options) {
    input.waffleNumeric=options;
    const entries=options.target && globalThis.AtriumNavHost?.project?.()?.numericExpressions;
    if(Array.isArray(entries) && entries.length)need("AtriumNumericFields").then(ui=>ui.attach(input,options),err=>globalThis.AtriumNavHost?.info?.(err.message));
    return input;
  }
  function numericText(input) {
    input.dataset.numericNative="";
    input.setAttribute("role","spinbutton");
    input.type="text";
    input.inputMode="text";
    // Preserve the Preferences stepper's caret unless the numeric fields experiment is enabled.
    if (!input.closest?.(".prf-stepper") || globalThis.AtriumLabs?.butterEnabled?.("numericFields")) input.select();
  }
  function numericFocus(event) {
    const input=event.target;
    if (input?.tagName!=="INPUT" || input.disabled || input.readOnly ||
        !(input.type==="number" || input.waffleNumeric || input.dataset?.numericUnit!=null || input.inputMode==="decimal")) return;
    // An ordinary unbound spinner keeps the browser's original synchronous commit.
    if(input.type==="number" && !input.waffleNumeric && input.dataset.unit==null && !input.waffleNativeNumber){
      const native=doc().createElement("input");native.type="number";
      input.waffleNativeNumber=()=>{
        native.min=input.min;native.max=input.max;native.step=input.step || "any";native.value=input.value;
        if(!Number.isFinite(native.valueAsNumber) || !native.validity.valid)return null;
        return input.dataset.numericUnit==="mm" ? String(Math.round(native.valueAsNumber*1e6)/1e6) : native.value;
      };
    }
    const ui=globalThis.AtriumNumericFields;
    if (ui) {ui.attach(input).enter();return;}
    if (input.waffleNumericWaiting) return;
    input.waffleNumericWaiting=true;input.waffleNumericType=input.type;input.waffleNumericBefore=input.value;
    if (input.type==="number") numericText(input);
    let edited=false,commit=false,submit=false;
    const hold=e=>{
      const change=e.type==="change";
      if (change && input.closest(".prf-stepper") && Number.isFinite(Number(input.value)) && input.value.trim()) {
        edited=commit=false;queueMicrotask(()=>{input.waffleNumericBefore=input.value;});return;
      }
      const text=change && !input.waffleNumeric ? input.waffleNativeNumber?.() : null;
      if(typeof text==="string"){
        input.type="number";input.value=text;input.waffleNumericBefore=text;
        edited=commit=false;input.removeEventListener("input",hold,true);
        input.dispatchEvent(new Event("input",{bubbles:true}));input.addEventListener("input",hold,true);return;
      }
      edited=true;commit ||= e.type==="change";
      if(e.type!=="input" || !input.waffleNumeric?.nativeInput?.(input.value))e.stopImmediatePropagation();
    };
    const key=e=>{if(e.key==="Enter" && edited && !e.isComposing &&
      !(input.closest(".prf-stepper") && input.value.trim() && Number.isFinite(Number(input.value)))){e.preventDefault();e.stopImmediatePropagation();commit=true;submit=true;}};
    input.addEventListener("input",hold,true);input.addEventListener("change",hold,true);input.addEventListener("keydown",key,true);
    const cleanup=()=>{input.removeEventListener("input",hold,true);input.removeEventListener("change",hold,true);input.removeEventListener("keydown",key,true);delete input.waffleNumericWaiting;};
    need("AtriumNumericFields").then(module=>{
      cleanup();const control=module.attach(input);
      if(edited){control.changed();if(commit)control.commit().then(ok=>{if(ok && submit && input.isConnected)input.form?.requestSubmit?.();});}
    },()=>{cleanup();input.type=input.waffleNumericType;});
  }
  function watchNumericInputs() {
    doc().addEventListener("focusin",numericFocus,true);
    const resubmitting=new WeakSet();
    doc().addEventListener("submit",e=>{
      const form=/** @type {HTMLFormElement} */(e.target),ui=globalThis.AtriumNumericFields;
      if (resubmitting.has(form) || !ui?.pending(form)) return;
      e.preventDefault();e.stopImmediatePropagation();
      const button=e.submitter;
      ui.flush(form).then(ok=>{
        if(!ok || !form.isConnected)return;
        resubmitting.add(form);
        try {form.requestSubmit(button?.isConnected ? button : undefined);}
        finally {resubmitting.delete(form);}
      });
    },true);
  }
  function watchEditor(host) {
    const live=()=>{
      const entries=host.project?.()?.numericExpressions;
      if(!Array.isArray(entries) || !entries.length)return;
      const ui=globalThis.AtriumNumericFields;
      if(ui)ui.attachHost(host);else need("AtriumNumericFields").then(module=>module.attachHost(host),err=>host.info?.(err.message));
    };
    const added=()=>{
      const entries=host.project?.()?.numericExpressions;
      if(Array.isArray(entries) && entries.length){offBinding?.();live();}
    };
    let offBinding=host.on?.("change",added);
    host.on?.("replace",()=>{
      offBinding?.();offBinding=host.on?.("change",added);added();
    });
    added();
    const d = doc(), types = ["focusin", "pointerdown", "wheel"];
    let starting = false;
    const start = event => {
      if (starting || (host.isStarter?.() && !event?.target?.closest?.(".split-pane"))) return;
      starting = true;
      need("AtriumEditorDemand").then(service => {
        service.attach(host, globalThis.AtriumLazy);
        for (const t of types) d.removeEventListener(t, start, true);
        offChange?.(); offDoc?.(); offReplace?.();
      }).catch(() => {starting = false;});
    };
    for (const t of types) d.addEventListener(t, start, {capture: true, passive: true});
    const offChange = host.on?.("change", start), offDoc = host.on?.("document", start);
    const offReplace = host.on?.("replace", () => queueMicrotask(start));
    let updateNeeded = launchUpdateDue(d.querySelector?.('meta[name="application-version"]')?.getAttribute("content")), updateTicket = null;
    const power = () => {
      if (!mayPrepare()) cancelPreparations();
      if (updateNeeded && updateTicket == null && visible()) updateTicket = idle(() => {
        updateTicket = null;
        if (!visible()) return;
        updateNeeded = false;
        need("AtriumUpdate").then(updates => updates.startup()).catch(() => {});
      });
      if (updateTicket != null && !visible()) {cancelIdle(updateTicket); updateTicket = null;}
    };
    globalThis.AtriumPower?.onChange?.(power);
    d.addEventListener("visibilitychange", power);
    const lockFile = () => {
      const H = globalThis.AtriumHost, folder = host.folderProject?.();
      const current = () => !!(H === globalThis.AtriumHost && H?.collabLocks && folder?.grant && !folder.temporary && !folder.readOnly &&
        host.folderProject() === folder && H.folderGitGrant === folder.grant &&
        globalThis.AtriumPref?.get?.("collab.locking",true) !== false);
      if (current()) requestAnimationFrame(() => idle(() => {
        if (current()) need("AtriumCollabLock").catch(() => {});
      }));
    };
    globalThis.addEventListener?.("atrium-git-binding", lockFile);
    host.on?.("replace", lockFile);
    d.addEventListener("visibilitychange", () => { if (visible()) lockFile(); });
    lockFile();
    requestAnimationFrame(() => idle(() => need("AtriumHistoryEntry").catch(() => {})));
    if (/^#atrium(-host)?=1&/.test(globalThis.location?.hash || "")) need("AtriumCollabPresence").catch(() => {}); // invitation link
    start();
    power();
  }
  if (doc()?.addEventListener) {
    const start = () => {
      stubCommands();
      watchNumericInputs();
      globalThis.AtriumNavCommon?.ready?.(watchEditor);
      const surface = doc();
      const searchFocus = event => {
        if (!event.target?.matches?.(".ui-search > input")) return;
        need("AtriumUIKit").then(() => surface.removeEventListener("focusin", searchFocus, true), () => {});
      };
      surface.addEventListener("focusin", searchFocus, true);
      const hintEvents = ["pointerover","pointerout","pointerdown","pointerup","pointercancel","focusin","focusout"];
      let firstHint, loadingHint = false;
      const loadHint = () => {
        if (loadingHint) return;
        loadingHint = true;
        need("AtriumTooltip").then(service=>{
          for (const name of hintEvents) surface.removeEventListener(name,hint,true);
          if (firstHint) service.begin(firstHint);
        }).catch(()=>{loadingHint=false;});
      };
      const hint = event => {
        if (has("AtriumTooltip") || event.type === "pointerover" && event.pointerType === "touch") return;
        if (event.type === "pointerup" || event.type === "pointercancel") {
          if (firstHint?.pointerId === event.pointerId) firstHint = null;
          return;
        }
        if (event.type === "pointerout" || event.type === "focusout") {
          if (firstHint?.target === event.target) firstHint = null;
          return;
        }
        if (!event.target?.closest?.("[title],[data-tooltip],[data-tooltip-label]")) return;
        firstHint = event;
        loadHint();
      };
      for (const name of hintEvents) surface.addEventListener(name,hint,{capture:true,passive:true});
      const prepareScroll = event => {
        if (!event.target?.closest?.("dialog, [role=tree], [role=listbox], #inspector, .dock-body")) return;
        surface.removeEventListener("pointerover", prepareScroll, true);
        prefetch(["AtriumOverlayScroll"]);
      };
      surface.addEventListener("pointerover", prepareScroll, {capture:true, passive:true});
      surface.addEventListener("scroll",event=>{
        const scroller = event.target === surface ? surface.scrollingElement : /** @type {Element | null} */ (event.target);
        need("AtriumOverlayScroll").then(service => { if (scroller?.isConnected) service.show(scroller); }).catch(() => {});
      },{capture:true,passive:true,once:true});
      if (globalThis.location?.hash === "#ui-gallery") need("AtriumUIGallery").then(g => g.mount());
    };
    if (doc().readyState === "loading") doc().addEventListener("DOMContentLoaded", start, {once: true}); else setTimeout(start, 0);
  }
  return Object.freeze({need, numericField, numericText, numericPresentation: () => sheet("editor/numeric-fields.css"), appendOnLoad, has, pending, prefetch, cancelPrefetch: cancelPreparations, forAction, isDiagnosticAction, diagnosticAction, needsRuleQuery:globalThis.AtriumRuleScopeDemand, validatorsFor, boardRenderers, register, files, stylesheets,
    modules: () => Object.keys(MODULES), actions: () => Object.keys(ACTIONS), board: () => [...BOARD]});
})();
