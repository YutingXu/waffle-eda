#!/usr/bin/env python3
"""Guard shared code ownership and retired call sites."""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CURVES = "app/pcb/resolved-geometry-curves.js"
MODEL = "app/core/model.js"
FAB = "app/formats/fab-outputs.js"
KICAD = "app/formats/import-kicad.js"
APPEARANCE = "app/pcb/pcb-appearance.js"
CONNECTIVITY = "app/checks/connectivity.js"
G02 = {
    "app/pcb/resolved-geometry.js": [(("graphic",), "region(toLines(shape.points,true))")],
    "app/checks/rules.js": [(("legendInk",), "elsefill(points);"), (("extract","silk"), "Math.PI/12")],
    "app/formats/fab-outputs.js": [(("analyse", "graphic"), "if(s.fill&&pts.length>=3)")],
    "app/pcb/pcb-draw.js": [(("graphicFeatures",), "filled=!!i.fill&&pts.length>2")],
    CONNECTIVITY: [(("builder", "graphic"), "s.fill&&s.points?.length>2")],
    "app/checks/dfm.js": [(("silkShape",), "Math.PI/12")],
    "app/history/revision-geometry.js": [(("project", "artwork"), "A.world(p,parent)")],
}
G03 = {
    "app/checks/rules.js": "legendArcPoints",
    "app/core/model.js": "",
    "app/formats/dxf.js": "arcSamples",
    "app/formats/fab-outputs.js": "",
    "app/formats/import-easyeda.js": "",
    "app/formats/import-kicad.js": "",
    "app/formats/mcad-idf.js": "",
    "app/formats/mcad-idx.js": "",
    "app/formats/pcb-import.js": "",
    "app/formats/sexpr.js": "arcPoints",
    "app/formats/step-export.js": "arcSteps",
    "app/pcb/board-shape-core.js": "",
    "app/pcb/board-shape-editing.js": "",
    "app/pcb/pcb-draw.js": "arcPoints",
    "app/pcb/polygon-pour.js": "circleTemplate",
    "app/pcb/router.js": "",
}
T01 = {f"tests/pcb/{path}.cjs": "pointSeg segSeg" for path in (
    "bus-route", "diffpair", "dp-entry", "drag-reroute", "multi-route", "route-drag", "router"
)}
T01.update({
    "tests/pcb/autorouter.cjs": "pointSeg crosses", "tests/pcb/length-tuning.cjs": "segDist",
    "tests/pcb/polygon-pour.cjs": "segDist segSeg",
})
T02 = {f"tests/pcb/{path}.cjs": "prims inside audit" for path in ("drag-reroute", "route-drag")}
HISTORY_PANEL = "app/history/history-panel.js"
GIT_PICKER = "app/history/git-picker.js"
MCAD_PANEL = "app/formats/mcad-panel.js"
FILE_HISTORY = "app/history/file-history.js"
MOTION_INSPECTOR = "extensions/developer/motion-inspector"
REMOVED = {
    "SUI07": ("app/editor/motion-inspector.js", "app/editor/motion-inspector.css"),
    "SUI04": ("app/history/review-diff.js",),
    "SUI05": ("app/history/project-history.js", "app/history/project-history.css"),
    "M3": (
        "tests/canvas/browser-frame-pour-composition.js",
        *(f"tests/canvas/browser-view3d-{case}.js" for case in ("demand", "folder", "navigation")),
        *(f"tests/canvas/browser-zoom-{case}.js" for case in ("settle", "surfaces")),
        *(f"tests/pcb/{suite}.cjs" for suite in (
            "pour-fade-hold", "pour-idle-solve", "pour-tiles-live", "repour-pooled", "repour-speculate")),
    ),
}
HISTORY_SHELLS = {
    FILE_HISTORY: "open",
    HISTORY_PANEL: "",
    "app/history/blame.js": "showHistory",
    "app/history/git.css": "",
    "app/lazy.js": "",
}
REVIEW_CALLERS = {
    GIT_PICKER: ("compare", "reviewChanges"),
    MCAD_PANEL: ("review",),
    HISTORY_PANEL: ("compare", "reviewRestore"),
}
FILM = "app/pcb/mask-openings.js"
DELEGATES = {
    "G05": {CONNECTIVITY: (("builder",), "padPlanes"), "app/pcb/pcb-draw.js": (("padFeatures",), "padPlanes"),
            "app/checks/dfm.js": (("itemFeatures",), "padPlanes"),
            "app/pcb/land-contours.js": (("placedCopper",), "padPlanes"),
            "app/pcb/length-tuning.js": (("padRecord",), "padPlanes"),
            "app/pcb/router.js": (("addItem",), "padPlanes"),
            "app/pcb/autorouter.js": (("eachCopper", "pad"), "padPlanes"),
            "app/canvas/canvas-board-batches.js": (("batchPad",), "hasPadRows"),
            "app/canvas/canvas-gpu.js": (("stacked",), "hasPadRows")},
    "G09": {"app/checks/dfm.js": (("maskCandidates",), "maskSeeds"), FAB: (("analyse",), "maskSeeds")},
}
ROWS = {
    "G01": {MODEL: "", "app/pcb/router.js": "triangulate", "app/canvas/canvas-gpu.js": "triangulate", CONNECTIVITY: "", "app/checks/rules.js": ""},
    "G02": dict.fromkeys((CURVES, *G02), ""),
    "G03": G03,
    "G05": dict.fromkeys((APPEARANCE, *DELEGATES["G05"]), ""),
    "G09": dict.fromkeys((FILM, *DELEGATES["G09"]), ""),
    "G17": {**{f"app/pcb/{name}.js": "segSeg2 segSeg" for name in ("router", "autorouter", "length-tuning", "polygon-pour")},
            "app/canvas/canvas.js": "inside", "app/checks/rules.js": "insidePolygon"},
    "G08": {APPEARANCE: "", CONNECTIVITY: "layerIndex", "app/pcb/length-tuning.js": "layerIndex"},
    "T01": T01, "T02": T02,
    "T03": {"tests/formats/fab-outputs.cjs": "gerber excellon"},
    "T04": {f"tests/formats/{path}.cjs": "check" for path in ("step-export", "step-fold")},
    "SUI01": {"app/editor/theme-picker.js": "openDialog", "app/editor/theme.css": ""},
    "SUI02": {
        "app/editor/editor-key-dialogs.js": "help", "app/editor/editor-keys.js": "help",
        "app/editor/editor-keys.css": "", "app/editor/editor.js": "", "app/index.html": "",
    },
    "SUI03": dict.fromkeys(("app/editor/prefs.js", "app/editor/editor.js", "app/checks/drc-inspector.js", "app/checks/drc-view.js"), ""),
    "SUI04": dict.fromkeys((*REMOVED["SUI04"], *REVIEW_CALLERS, "app/history/review.css", "app/lazy.js"), ""),
    "SUI05": {**HISTORY_SHELLS, **dict.fromkeys(REMOVED["SUI05"], "")},
    "SUI07": dict.fromkeys((*REMOVED["SUI07"], "app/automation/editor-command-host.js", "app/editor/theme-picker.js",
                            "app/lazy.js", MOTION_INSPECTOR + "/main.js", MOTION_INSPECTOR + "/waffle-extension.json"), ""),
    "M3": dict.fromkeys(REMOVED["M3"], ""),
    "F03": {HISTORY_PANEL: "paintLegacy"},
    "D04": {"app/checks/drc.js": "openDialog", "app/checks/drc-view.js": "", "app/checks/rules-editor.css": ""},
}


# The shared call must remain, and the retired body must stay out of each caller.
def adapter_sites(owner, retired, paths):
    return dict.fromkeys(paths.split(), (owner, re.compile(retired, re.MULTILINE)))


SOLVER_LISTENER = r"\bAtriumThermalServe\b|\.\s*on(?:message|error)\s*="
PDN = "app/analysis/pdn.js"
ADAPTER_OWNERS = {("BR01", PDN): ("AtriumPDNServe", "AtriumSolverClient")}
ADAPTER_OWNERS["LA04", "app/notebook/table-visual.js"] = ("projectedCell",)

LIBRARY_PANEL = "app/library/library-panel.js"
RELEASE = "app/formats/release.js"
PORTABLE_PROJECTION = r"\b(?:inflate|portableModels|portableSource)\s*\(|\bmirrorSig\b"
ADAPTER_SCOPES = {
    ("PF02", RELEASE): ("generate", "release"),
    ("LA02", LIBRARY_PANEL): ("openLibraryFile", "reloadLibraryFile"),
    ("LA03", LIBRARY_PANEL): ("libraryFile", "saveToLibrary"),
    ("LA03", "app/library/library-sources.js"): ("saveReviewed",),
    ("LA03", "app/library/group-library.js"): ("propose",),
    ("LA03", "app/formats/translator-exports.js"): ("exportLibrary",),
}


ADAPTERS = {
    "M2STEP": {**adapter_sites("AtriumGeometry.inFlatRing(", r"\bfunction\s+(?:inPoly|segDist|boxXform)\b|\bconst x(?:form|dir)\s*=|const P = a => \[c\[0\] \+ r \* Math\.cos", "app/formats/step-export.js"), **adapter_sites("AtriumGeometry.affine3D", r"\bfunction boxXform\b|\bconst x(?:form|dir)\s*=|\bget boxXform\b|for \(let c = 0; c < 8;", "app/canvas/view3d.js app/canvas/collision-3d.js"), **adapter_sites("C.hull(b)", r"\bconst hull = \[\]|hull\.push\(M\[0\]", "app/formats/mcad-step.js")},
    "M2Panel": adapter_sites("AtriumGeometry.segmentDistance(", r"\bfunction\s+(?:polyArea|inPoly|cross|b64)\b|const\s+(?:segDist|segSeg|POUR_UNIT)\s*=", "app/pcb/panel.js"),
    "M2IPC": adapter_sites('shapeLoop(outer, "Polygon")', r'xy\(outer\[0\]\.a\)|outer\.map\(edge\s*=>', "app/formats/ipc2581.js"),
    "M2Bounds": {**adapter_sites("C.edgeBounds(", r"\bfunction edgeBounds\b|\bconst mapArea\b", "app/pcb/resolved-geometry.js"), **adapter_sites("placeArea(ink.aperture", r"\bfunction (?:edgeBounds|placedArea|inside)\b|let winding = 0;", "app/pcb/geometry-material.js")},
    "M2ODB": adapter_sites("orient(e.a,e.b,b.a)", r"\bconst turn=\(a,b,c\)=>", "app/formats/odb.js"),
    "M2STEPFaces": {**adapter_sites("triangulateFace(rings)", r"\bfunction earcut\b|if \(left >= 3\)", "app/formats/step-import.js"), **adapter_sites("{triangulate, TriangulationError} = reader", r"\bfunction triangulate\b", "app/formats/step-export.js")},
    "M2Path": adapter_sites(".pathPoints(", r"\bcurves\.flatten\(\[curves\.arcEdge\(|\binsidePolygon\s*\(", "app/canvas/canvas-gpu.js app/checks/connectivity.js app/checks/dfm.js app/checks/rules.js app/pcb/autorouter.js app/pcb/router.js"),
    "M2Print": adapter_sites("AtriumStackup.copperLayers(doc,", r"\bfunction innerLayers\b", "app/formats/print.js"),
    "M2PrintCopper": adapter_sites("M.clip(stock,cutters,z)", r"\bfunction\s+(?:hiddenFor|layersOf)\b", "app/formats/print.js"),
    "M2Captions": {**adapter_sites("opts.netNames", r"\bopts\.padNets\b", "app/canvas/canvas.js app/canvas/canvas-gpu.js app/pcb/pcb-appearance.js"), **adapter_sites("netNames:false", r"\bpadNets\s*:", "app/formats/print.js app/history/history-artwork.js")},
    "M2Assembly": adapter_sites("S.placeContour(contour, place", r"\bA\.transformArc\((?:g, place|arc, p => A\.world)|bodyPts\.push\(A\.world", "app/formats/fab-outputs.js"),
    "M2PadCaptionPose": {**adapter_sites("AtriumResolvedLand.place(g,parent)", r"\blocalAngle\b", "app/canvas/canvas.js"), **adapter_sites("I.padText(ctx, p, g,", r"parent\?\.mirror\s*\?\s*g\s*:\s*p\b|\bPCB\.padTurn\(p,parent\)", "app/canvas/canvas-gpu.js")},
    "M2PourPath": {**adapter_sites(".arcRuns(", r"\bfunction (?:base64|unbase64|rings|encode|edgeIndex)\b", "app/pcb/polygon-pour.js"), **adapter_sites("P().edgeBands(", r"\bfunction bandsOf\b", "app/checks/drc-pours.js")},
    "M2Drill": adapter_sites("material.visitPad(pad, parent, stack", r"\bdrillOperations\([vp], parent, \(member, bore,", "app/formats/fab-outputs.js"),
    "PF01": adapter_sites("createPreparation(",
        r"\b(?:ctx|scope)\.(?:writers|panelPreparation)\b|\bscope\.(?:boards|panel)\b|\bmodelWithoutIsolatedLands\b|\.\s*(?:analyse|prepare)\(\s*(?:ctx\.)?project\b",
        "app/formats/output-jobs.js app/formats/translator-manufacturing.js"),
    "PF02": adapter_sites("captureRun(",
        r"\b(?:currentDesign|interceptor|workerFor)\s*\(|\bJ\(\)\.(?:runAsync|settle)\s*(?:\?\.)?\(",
        RELEASE),
    "LA03": {
        **adapter_sites("portableDefinition(", PORTABLE_PROJECTION, LIBRARY_PANEL),
        **adapter_sites(".portableDefinition(", r"\bmirrorSig\b|\b(?:inflate|portableSource)\s*\(",
            "app/library/library-sources.js app/library/group-library.js"),
        **adapter_sites("AtriumLibrary.libraryFile(", r"\bAtriumLibraryStore\.(?:inflate|hoisted)\s*\(",
            "app/formats/translator-exports.js"),
    },
    "XF01": adapter_sites("readWriter(",
        r"\bfunction\s+(?:splitData|parseBody)\s*\(|\.search\s*\(\s*/\\bDATA\\s\*;|\b(?:Bad enumeration at|Unterminated string)\b",
        "app/formats/step-export.js"),
    "XF05": adapter_sites("projectCam(", r"\b(?:ox|oy)\b|\b(?:origin|datum)\[\s*1\s*\]\s*-|\bpickPlaceJLC\b",
        FAB + " app/formats/odb.js app/formats/ipc2581.js"),
    "XF03": adapter_sites("xml.parse(",
        r"""\.indexOf\s*\(\s*["']<["']|\b(?:duplicate attribute|unterminated start tag)\b""",
        "app/formats/ipc2581.js"),
    "BR01": {
        **adapter_sites("AtriumSolverClient(j, options", SOLVER_LISTENER, PDN),
        **adapter_sites("runSolver(", SOLVER_LISTENER, "app/analysis/thermal.js"),
        **adapter_sites("AtriumPDNServe(self, AtriumThermalCore", SOLVER_LISTENER, "app/workers/thermal-worker.js"),
        **adapter_sites("AtriumPDNServe(self, AtriumThermalCore", r"\bAtriumThermalServe\b", "tests/workers/worker-start-probe.js"),
    },
    "MH04": adapter_sites("hoverStatus(", r"(?<![\w-])(?:status-drc-hover|drc-hovering)(?![\w-])",
        "app/checks/drc-markers.js app/schematic/sch-markers.js"),
    "BR03": adapter_sites("pipe-frames.js", r'\b(?:readSync|writeSync)\s*\(',
        """mcp/board-runner.js mcp/headless.js"""),
    "CQ01": adapter_sites("sharedGroups", r"""\[\s*["']P W["']\s*,\s*["']route["']""", "app/editor/keymap-presets.js"),
    "HS06": adapter_sites("labelTranslator", r'\bfunction\s+t\s*\(', "app/editor/theme-editor.js"),
    "QA01": adapter_sites("chrome_cdp", r'Sec-WebSocket-Key|\b0x81\b',
        """scripts/collab-demo.py scripts/gpu-pixels.sh scripts/perf-canvas.sh scripts/perf-gpu.sh
           scripts/perf-pour.sh scripts/perf-route.py scripts/perf-sch.sh scripts/perf-ui.sh
           tests/workers/worker-start.py"""),
    "QA02": adapter_sites("standalone-chromium.cjs", r'\bchromium\s*\.\s*launch\s*\(',
        """tests/canvas/browser-zoom-geometry.js tests/canvas/browser-gpu-pour-lod.cjs tests/pcb/browser-pour-open-connectivity.js
           tests/editor/browser-accessibility.js tests/editor/browser-appbar-contrast.js
           tests/editor/browser-canvas-hover.js tests/editor/browser-editor-chrome.js
           tests/editor/browser-focus-rings.js tests/editor/browser-inline-stack.js
           tests/editor/browser-menu-toggle.js tests/editor/browser-messages-fonts.js
           tests/editor/browser-motion-contract.js tests/editor/browser-no-quirks.js
           tests/editor/browser-palette-view.js tests/editor/browser-panel-chrome.js
           tests/editor/browser-panels-menu.js tests/editor/browser-preferences-layout.js
           tests/editor/browser-rare-motion.js tests/editor/browser-search-keys.js
           tests/editor/browser-status-bar.js tests/editor/browser-workbench-tree.js
           tests/history/browser-history-refs.js tests/project/browser-split-controls.js
           tests/ui/browser-ui-gallery.cjs tests/ui/browser-ui-kit.js tests/ui/browser-ui-snapshots.cjs"""),
    "QA03": adapter_sites("browser-app-server.cjs", r'\bhttp\s*\.\s*createServer\s*\(',
        """scripts/perf-view3d.cjs tests/editor/browser-palette-notebook.js tests/editor/browser-preview-labs.js
           tests/formats/browser-format-2-git.cjs tests/formats/browser-import-source-picker.js
           tests/history/browser-project-history.js tests/notebook/browser-calculation-sheet.js
           tests/notebook/browser-widget-bindings.js tests/notebook/browser-widget-demand.js
           tests/project/browser-project-archive.js tests/real-history/browser.cjs"""),
    "QA04": adapter_sites("native-folder-fixture.cjs", r'FolderTransactions\.swift|\bfolder\s*=\s*FolderFiles\s*\(',
        """tests/checks/browser-annular-problems.js tests/checks/browser-apricot-native-query.cjs
           tests/checks/browser-fab-rule-ids.js tests/schematic/browser-rules-netlist.js"""),
    "QA05": adapter_sites("from mcp_stdio import", r'\bselect\.select\s*\(|\bstdout\.readline\s*\(|^class Client\s*[:(]|\bM\.HeadlessToolTests\.',
        """tests/automation/mcp-authoring.py tests/automation/mcp.py tests/integration/eco-e2e.py
           tests/library/mcp-generic-parts.py tests/library/mcp-symbol-wizard.py"""),
    "QA06": adapter_sites("H.runWalk(", r'\bH\.PROFILES\.slice\s*\(',
        """tests/automation/browser-butter-ai-ui.cjs tests/automation/browser-butter-macros-ui.cjs
           tests/checks/browser-butter-query-ui.cjs tests/project/browser-butter-links-ui.cjs"""),
    "QT03": adapter_sites("sampleHistoryScroll", r'\bsamples\.push\s*\(\s*stamp\s*-\s*last\s*\)',
        """tests/history/browser-butter-history.cjs tests/history/browser-project-history.js"""),
    "UI01": adapter_sites("AtriumUI.searchField(", r'\bfunction\s+(?:searchBox|searchField)\s*\(|\badoptSearch\s*\(',
        """app/checks/constraints.js app/checks/rules.js app/editor/keymap-editor.js app/editor/prefs.js
           app/editor/signals-panel.js app/editor/start-page.js app/editor/theme-editor.js
           app/editor/vscode-keys.js app/formats/bom.js app/history/diff-view.js app/history/git-picker.js
           app/history/review-comments.js app/library/component-swap.js app/library/library-panel.js
           app/notebook/calculation-sheet.js app/project/variants.js app/schematic/eco.js"""),
    "UI03": adapter_sites("AtriumUI.nativeButton(", r'\bfunction\s+button\s*\(',
        """app/analysis/pdn-view.js app/analysis/si.js app/analysis/stress.js app/analysis/thermal-view.js
           app/formats/fab-profiles.js app/formats/release-ui.js app/pcb/stackup.js"""),
}

ADAPTERS["BR03"].update(adapter_sites("_frame_header(", r"""struct\.(?:unpack|pack)\(\s*["']<3I["']""", "mcp/board_runner.py"))
ADAPTERS["UI03"].update(adapter_sites("AtriumUI.nativeButton(", r"""\bel\(\s*["']button["']\s*,\s*["']ui-button["']""", "app/ui/kit.js"))


ADAPTERS.update({
    "RT01": adapter_sites("inventoryFrom(", r'\bconst\s+moved\s*=', "tests/support/app-source-paths.cjs"),
    "ED01": adapter_sites("AtriumFindSimilarDialog.open(", r'\bpcb-edit-similar-grid\b',
        "app/pcb/pcb-selection-inspector.js app/schematic/sch-similar.js"),
    "ED02": adapter_sites(".strictCrossing(", r'\bfunction\s+crosses\s*\(', "app/editor/lasso.js"),
    "HS02": adapter_sites(".openPrivateCopy(", r'\.replaceProject\(\s*(?:p|project)\s*,\s*\{\s*copy:\s*true,\s*dirty:\s*true',
        "app/history/history-panel.js app/history/source-history.js"),
    "PF05": adapter_sites("joinIslandLinks(", r'\bif\s*\(\s*copper(?:\?|)\.length\s*\)',
        "app/checks/connectivity.js app/checks/connectivity-live.js"),
    "PK01": adapter_sites("with staged_output(", r'\bNamedTemporaryFile\s*\(',
        "scripts/build-deb.py scripts/package-release.py"),
    "QT01": {
        **adapter_sites("docking(", r'\b(?:panelTabs|showPanel)\b', "tests/editor/browser-editing-input.js"),
        **adapter_sites("editorChrome(", r'\b(?:panelChecked|AtriumPCBList)\b', "tests/editor/browser-workbench-tree.js"),
    },
    "QT02": adapter_sites("editorChrome(", r'\b(?:tabFills|splitRight)\b', "tests/editor/browser-workbench-tree.js"),
    "QT04": adapter_sites("propertiesChrome(", r"""["']Close pane 2["']""", "tests/editor/browser-editing-input.js"),
    "UI05": adapter_sites("AtriumUIKit.nullableNumber(", r'\bfunction\s+numInput\s*\(',
        "app/analysis/pdn-view.js app/analysis/thermal-view.js"),
})

ADAPTERS.update({
    "BR02": adapter_sites("AtriumWorkerPool.blobWorker(", r'\bURL\.revokeObjectURL\s*\(',
        "app/analysis/field-solver.js app/analysis/pdn.js app/analysis/thermal.js"),
    "LA04": {
        **adapter_sites("V.projectedCell(", r'\bT\.merged\(\s*state\s*,\s*row\.id\s*,\s*col\.id',
            "app/notebook/table-editor.js"),
        **adapter_sites("projectedCell(", r'\bT\.merged\(', "app/notebook/table-visual.js"),
    },
    "CQ02": {
        **adapter_sites("AtriumKeymap.documentFitEntry(", r'\[\s*"Fit Document"\s*,\s*"(?:fit|fit-document)"',
            "app/editor/context-menu.js"),
        **adapter_sites("AtriumKeymap.documentFitRegistration(", r'\bcommand\(view,\s*"Fit Document"|appendingPathComponent\("editor/keymap\.js"\)',
            "native/macos/main.swift"),
    },
    "ED04": adapter_sites("A.moveItem(", r'\b\w+\.item\.(?:points|arc|x|y)\s*=(?!=)',
        "app/editor/edit-selection.js"),
    "CQ04": adapter_sites("projectSimilar(", r'\bpropValue\s*\(|\badd\(\s*"drill"\s*,\s*"Drill"\s*,\s*item\.drill\s*\|\|\s*0',
        "app/pcb/pcb-edit.js"),
    "CQ06": adapter_sites("ui.probe(", r'\b(?:resolveLocal|activateInstance)\s*\(', "app/editor/palette.js"),
    "HS01": {
        **adapter_sites(".envelope(storage)", r'JSON\.parse\(storage\?\.getItem\(STORE\)', "app/editor/prefs.js"),
        **adapter_sites("?.legacyValue?.(", r"""localStorage\?\.getItem\(["']atrium\.prefs["']""", "app/pcb/route-feel.js"),
        **adapter_sites(".legacyValue(key, storage)", r"""storage\?\.getItem\(["']atrium\.prefs["']""", "app/history/clip-history.js"),
    },
    "MH01": {
        **adapter_sites("I.exposedPanStrips(", r'vx\s*\+\s*W|\bconst top\s*=\s*ay\s*>\s*0\s*\?\s*ay',
            "app/canvas/canvas-gpu.js"),
        **adapter_sites("I.exposedPanStrips(", r'if\s*\(ay\s*[<>]\s*0\)\s*paint\(', "app/canvas/canvas.js"),
    },
    "MH02": {
        **adapter_sites(".firstFit(", r'\bconst horizontal\s*=\s*\[bounds\.left', "app/ui/tooltip.js"),
        **adapter_sites(".firstFit(", r'\bconst sides\s*=\s*\(base, ends\)', "app/checks/problem-hover.js"),
        **adapter_sites(".firstFit(", r'\bconst choices\s*=\s*\[\[r\s*\+\s*gap', "app/schematic/connection-preview.js"),
    },
    "MH03": adapter_sites("appendMarkerInterior(", r'\bctx\.arc\(at\[0\], at\[1\], r, 0|const inner = st\.sev',
        "app/checks/drc-markers.js"),
    "UI02": adapter_sites("AtriumShell.openDialog(", r'\bd\.showModal\s*\(',
        """app/editor/about.js app/formats/altium-project-export.js app/formats/fab-presets.js app/formats/fab-profiles.js
           app/formats/mcad-panel.js app/history/diff-view.js app/history/git-picker.js app/history/merge-ui.js"""),
    "UI04": {
        **adapter_sites("AtriumUIKit.analysisTable(", r'colspan:\s*String\(cols\.length\)',
            "app/analysis/pdn-view.js app/analysis/si.js app/analysis/thermal-view.js"),
        **adapter_sites("AtriumUIKit.analysisTable(", r"""\bconst thead = el\(["']thead["']\)""",
            "app/analysis/stress.js"),
    },
    "UI06": {
        **adapter_sites("ui/history-panels.css", r'ui/history-close\.css', "app/lazy.js"),
        **adapter_sites(".clip-item", r'\.panel-clip\s*\{\s*display\s*:\s*flex', "app/history/clip-history.css"),
        **adapter_sites(".hist-row", r'\.panel-history\s*\{\s*display\s*:\s*flex', "app/history/history-panel.css"),
        **adapter_sites(".rc-thread", r'\.panel-rc\s*\{\s*display\s*:\s*flex', "app/history/review.css"),
    },
    "XF02": {
        **adapter_sites("AtriumAltiumRecords.frame(", r'\bconst (?:kind = data\.getUint16|n=view\(bytes\)|header=view\.getUint32|frame=view\.getUint32|size=data\.getUint32\(pos,true\)&0xffffff)',
            "app/checks/altium-rules.js app/formats/pcb-import.js app/formats/pcb-patch.js app/formats/sch-import.js app/formats/sch-patch.js"),
    },
})

ADAPTERS.update({
    "BR04": {
        **adapter_sites("publish_proposal(", r"\bNamedTemporaryFile\(", "mcp/server.py"),
        **adapter_sites("publish_proposal(self.server.path.parent", r"""folder\.temporary\(prefix, ["']\.waffle-ai["']\)""",
            "mcp/automation.py"),
    },
    "CQ03": {
        **adapter_sites(".command_rows(", r"const BUILTIN=", "scripts/headless-inventory.py"),
        **adapter_sites("INV.keymap_commands(", r"const CLASSIC=", "scripts/reachability.py"),
    },
    "CQ05": adapter_sites(".projectOwner(", r"\b(?:projection|D)\.(?:netNames|terminalSubjects)\(",
        "app/checks/design-query-index.js app/checks/query.js"),
    "HS03": adapter_sites(".reviewedRestore(", r"\.preserveLine\(", "app/history/history-session.js app/history/visual-history.js"),
    "HS04": adapter_sites(".recoverySnapshots?", r"titles\s*=\s*\{saved:", "app/history/history-panel.js app/history/history-view.js"),
    "HS05": adapter_sites("netTransition(", r"""\b(?:objects\.push|e\.objects\.push)\([^\n]*["'] joined["']""",
        "app/history/blame.js"),
    "MH05": adapter_sites(".badgeAt", r"\.badgeUnder\s*\(", "app/checks/problem-hover.js app/schematic/sch-markers.js"),
    "MH06": adapter_sites(".paintBadges(", r"\b(?:M|P\(\))\.badge\(ctx, a, b\.at", "app/checks/checks-cross.js app/schematic/sch-markers.js"),
    "PF03": adapter_sites(".reportInput(", r"\bconst run = globalThis\.AtriumDRC\?", "app/formats/output-jobs.js app/formats/release.js"),
    "PK03": {
        **adapter_sites("first_matching_row(", r"csv\.DictReader\(", "scripts/format-2-qa/archive.py"),
        **adapter_sites("input_table(", r"csv\.DictReader\(", "scripts/format-2-qa/prepare.py scripts/format-2-qa/reimport.py scripts/format-2-qa/sidecars.py"),
    },
    "LA11": adapter_sites(".calculatorPresets", r"""\[\[["']voltage_divider["']""", "app/notebook/sheet-widget-editor.js"),
    "XF06": adapter_sites("completedDocument(", r"""countWritten\([^\n]*["'](?:KiCad|Altium)["']\)""",
        "app/formats/translator-exports.js"),
    "LA02": adapter_sites("projectOpenedRegistry(", r'\bif\s*\(read\.(?:componentFamilies|tombstones)\)|\.showImportReport\?\.\(',
        "app/library/library-panel.js"),
    "LA10": adapter_sites("AtriumElectricalMaterial.deratedPower(", r'\b(?:ambient|v\.ambient)\s*<=\s*(?:v\.)?knee',
        "app/analysis/calculators.js app/analysis/stress.js"),
    "BR05": adapter_sites("S.headlessStart(", r'\bjobs\s*=\s*new Map\(',"mcp/headless.js"),
    "PF04": {
        **adapter_sites("AtriumRuleScopeDemand", r'\bconst disabled\s*=\s*new Set', "app/lazy.js"),
        **adapter_sites("AtriumRuleScopeDemand", r'\bconst simple\s*=\s*s=>!s\|\|s\.kind', "app/pcb/polygon-pour.js"),
    },
    "PK04": {
        **adapter_sites("package_payload.py", r'\bcp\b[^\n]*\bimport_export\.py|WaffleMcp\s+Include',
            "native/tests/macos-harness/build.sh scripts/build-mac.sh native/windows/Waffle.Windows.csproj"),
        **adapter_sites("relative_companions(", r'\bmcp\s*=\s*sorted\(', "scripts/build-deb.py"),
        **adapter_sites("check_packaged(", r'\bROOT\s*/\s*"native"\)\.glob\(', "scripts/package-release.py"),
        **adapter_sites("companion_paths(", r'\bsource\s*/\s*"native"\)\.glob\(', "scripts/release-preview.py"),
    },
    "PK05": adapter_sites('stage, cwd=source', r'\b(?:tarfile\.open|archive\.extractfile)\s*\(',
        "scripts/release-preview.py"),
    "LA01": adapter_sites("AtriumLibraryPairing.difference(", r'\b(?:noPad|noPin)\s*=\s*[^\n]*\.filter\(',
        """app/library/library-import-altium.js app/library/library-import-kicad.js app/library/library-panel.js
           app/library/library-store.js app/library/symbol-wizard.js"""),
    "LA05": {
        **adapter_sites(".rebaseTarget(", r'\binstanceIds\?\.forTarget\?\.\(',"app/notebook/notebook.js"),
        **adapter_sites(".rebaseTarget(", r'\binstances\.forTarget\(',"app/notebook/calculation-records.js"),
        **adapter_sites(".rebaseTarget(", r'\binstances\?\.forTarget\?\.\(',"app/notebook/sheet-widgets.js"),
    },
    "ED03": adapter_sites(".hits(", r'\bout\.length\s*<\s*limit.*?\bv\.hit\(',
        "app/editor/editor.js"),
    "LA09": {
        **adapter_sites("AtriumElectricalMaterial", r'\b1\.7241e-[58]\b|\bALPHA\s*=\s*0\.00393\b',
            "app/analysis/calculators.js app/analysis/pdn.js app/analysis/thermal.js"),
    },
    "LA07": {
        **adapter_sites(".platedBarrelArea(", r'\bPI\s*\*\s*\(drill\s*\+\s*plating', "app/analysis/ipc2152.js"),
        **adapter_sites("core.platedBarrelArea(", r'\bMath\.PI\s*\*\s*\((?:p\.)?drill\s*\+\s*tp', "app/analysis/pdn.js"),
        **adapter_sites(".platedBarrelArea(", r'\bMath\.PI\s*\*\s*\(v\.drill\s*\+\s*tp', "app/analysis/thermal.js"),
    },
    "LA08": {
        **adapter_sites(".ipc2221Current(", r"0?\.024\s*:\s*0?\.048|current:\s*\(aMil2, dT, internal\)\s*=>\s*kOf\(internal\)",
            "app/analysis/ipc2152.js"),
        **adapter_sites("ipc2221Current(areaMM2", r"0?\.048\s*\*\s*Math\.pow\(dT", "app/analysis/pdn.js"),
    },
    "LA06": adapter_sites(".paletteRamp(", r'\bt\s*=\s*!\(t\s*>\s*0\)\s*\?\s*0|\bfunction ramp\(t, dark',
        "app/analysis/thermal.js"),
    "PF06": adapter_sites("forwardMarkPrerequisites(ctx.list", r'(?<!\.)\bdeps\[j\]\.some\(i\s*=>\s*(?:ctx\.unavailable|held\.has|dirty\.has)',
        "app/pcb/polygon-pour.js"),
    "PK02": adapter_sites("materialize_choices(", r'\bchoices\.append\(\{"name":\s*name,\s*"selectedPath"',
        "scripts/format-2-qa/archive.py scripts/format-2-qa/sidecars.py"),
})

ROWS.update({row: dict.fromkeys(sites, "") for row, sites in ADAPTERS.items()})
# Codex enables each row or exact path in the integration commit that retires its copies.
# Review settings here only. The migration worktree cannot grant itself an exception.
ENFORCED = {row: tuple(ROWS[row]) for row in (
    "T01", "T02", "T03", "T04", "G01", "G02", "G05", "G08", "G09", "G17", "SUI03", "SUI01", "SUI02", "D04", "SUI05", "F03", "M3"
)}
ENFORCED.update({row: tuple(sites) for row, sites in ADAPTERS.items()})
ENFORCED["SUI04"] = tuple(ROWS["SUI04"])
ENFORCED["SUI07"] = tuple(ROWS["SUI07"])
ENFORCED["G03"] = (
    "app/checks/rules.js",
    MODEL,
    "app/formats/dxf.js",
    FAB,
    "app/formats/import-easyeda.js",
    KICAD,
    "app/formats/mcad-idf.js",
    "app/formats/mcad-idx.js",
    "app/formats/pcb-import.js",
    "app/formats/sexpr.js",
    "app/formats/step-export.js",
    "app/pcb/board-shape-core.js",
    "app/pcb/board-shape-editing.js",
    "app/pcb/pcb-draw.js",
    "app/pcb/polygon-pour.js",
    "app/pcb/router.js",
)

# Exact expression boundaries. These loops author native vertices, independent
# hole placements or a fixed lattice. Winding, import grammar and output
# opcodes remain free to use trig for analytic parameters without sampling.
OTHER_BOUNDARIES = {
    "app/formats/import-easyeda.js": (
        "Array.from({length:49},(_,i)=>[c[0]+rx*Math.cos(i*Math.PI/24),c[1]+ry*Math.sin(i*Math.PI/24)])",  # schematic only
    ),
    "app/pcb/board-shape-editing.js": (
        "holes.push({x:c[0]+rr*Math.cos(a),y:c[1]-rr*Math.sin(a),d:+o.holeDiameter||3.2})",
    ),
    "app/formats/fab-outputs.js": (
        "for(letk=0;k<=n;k++){consta=(start+360*k/n)*Math.PI/180;pts.push([Math.cos(a),-Math.sin(a)]);}",  # drill symbol polygon
    ),
    "app/pcb/polygon-pour.js": (
        "consta=(base+k*90)*Math.PI/180,u=[Math.cos(a),Math.sin(a)];",  # authored thermal spoke directions
        # An integer-grid template for neck removal and outline morphology.
        "x=Math.round(R*Math.cos(a)),y=Math.round(R*Math.sin(a));t[2*i]=x;t[2*i+1]=y;t[2*(i+h)]=-x;t[2*(i+h)+1]=-y;",
    ),
    "app/pcb/router.js": ("c[i]=Math.cos(2*Math.PI*i/k);s[i]=Math.sin(2*Math.PI*i/k);",),
}
# Source Copy for a pre-versioned Altium archive reproduces its originally
# authored track vertices. Require the exact legacy branch as well as its
# expression, so copying this sampler into the normal import path still fails.
MODEL_VERTICES = "Array.from({length:n+1},(_,i)=>arcPoint(s,s.start+sweep*i/n))"
ALTIUM_ARCHIVE = "if(legacy){constw=sweep(start,end),n=Math.max(2,Math.ceil(w/6));returnpath("
ALTIUM_VERTICES = "Array.from({length:n+1},(_,i)=>A.arcPoint({c,r},start+w*i/n))"
LITERALS = (
    r"""//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60"""
    r"""|(?:(?<=[=(,:;!?\[{])|(?<=\breturn))[ \t]*/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+/[dgimsuvy]*"""
)
IGNORED = re.compile(LITERALS)
LOOP = re.compile(r"\b(for|while|Array\s*\.\s*from)\s*\(")
CALC = re.compile(r"\b(sin|cos|arcPoint|arcAt|pointOnArc)\s*\(")
ASSIGN = re.compile(r"\b(\w+)\s*=(?!=|>)\s*([^;,\n]+)")
INDEXED_LOOKUP = re.compile(r"\[[^\[\]]*\]")
SAGITTA = re.compile(r"\bMath\.acos\(\s*(?:Math\.max\([^,]+,\s*)?1\s*-\s*[^;\n)]+/")
DECLARATION = r"\b(?:function\s*\*?|const|let|var)\s+(%s)\b(?=\s*[=(])"
PAD_ROW_COPY = re.compile(
    r"\b(\w+)\.padStack\s*&&[^;{}]{0,90}\b\1\.stackMode\b"
    r"|\b(\w+)\.stackMode\s*&&[^;{}]{0,90}\b\2\.padStack\b"
)
space = re.compile(r"\s+")
blank = lambda text: "".join("\n" if c == "\n" else " " for c in text)


def end_of(source, start, close):
    opening = source[start]
    level = 0
    for i in range(start, len(source)):
        level += (source[i] == opening) - (source[i] == close)
        if level == 0:
            return i + 1
    return len(source)


def function_scope(source, names):
    offset = 0
    for name in names:
        matches = list(re.finditer(rf"\bfunction\s+{name}\s*\(", source))
        if len(matches) != 1:
            raise ValueError(f"expected one {' › '.join(names)} function")
        start = end_of(source, matches[0].end() - 1, ")")
        start += re.match(r"\s*", source[start:]).end()
        if source[start:start + 1] != "{":
            raise ValueError(f"could not locate the {name} function body")
        offset += start
        source = source[start:end_of(source, start, "}")]
    return offset, source


def piece_owner(path, source):
    if path == MODEL:
        function_scope(source, ("triangulateRing",))
    elif path in ("app/pcb/router.js", "app/canvas/canvas-gpu.js"):
        if "Atrium.triangulateRing(" not in space.sub("", source):
            yield 0, "route obstacles and GPU fills must use the shared polygon triangulation"
    else:
        at, body = function_scope(source, ("fillPieces",))
        if "A.triangulateRing(" not in space.sub("", body) or ".splice(" in body:
            yield at, "copper contour decomposition must delegate ear clipping"


def ink_owner(path, source):
    if path == CURVES:
        function_scope(source, ("artworkInk",))
        if re.search(r"\bfunction\s+(?:analyticInk|polygonalInk)\s*\(", source):
            yield 0, "fragmented artwork classifiers were restored"
        return
    for names, retired in G02[path]:
        at, body = function_scope(source, names)
        if len(re.findall(r"\bartworkInk\s*\(", body)) != 1:
            yield at, "physical graphic artwork must come from artworkInk"
        if retired in space.sub("", body) or re.search(r"\b(?:analyticInk|polygonalInk|pathArc|regionOf|transformArc|placeContour)\s*\(", body):
            yield at, "restored local graphic artwork decision"


def span_owner(path, source):
    if path == APPEARANCE:
        function_scope(source, ("copperSpan",))
    if path != CONNECTIVITY: return
    at, body = function_scope(source, ("copperSpan",))
    if not re.search(r"\bPCB\s*\.\s*copperSpan\s*\(", body):
        yield at, "connectivity physical span must delegate to PCBAppearance"
    compact = space.sub("", body)
    if "return[0,127]" in compact or "[Math.min(a,b),Math.max(a,b)]" in compact:
        yield at, "restored local connectivity physical span"
    at, body = function_scope(source, ("builder", "addEntity"))
    if not re.search(r"\bpadLayer\s*\(\s*parent\s*,\s*i\s*\)", body) or "constdeclared=i.layer||" in space.sub("", body):
        yield at, "connectivity layer declaration must use the shared padLayer"


def indexed_angle(body, index):
    names = {index}
    for assignment in ASSIGN.finditer(body):
        expression = INDEXED_LOOKUP.sub("", assignment[2])
        if names.intersection(re.findall(r"\b\w+\b", expression)):
            names.add(assignment[1])
    sample = set()
    for call in CALC.finditer(body):
        end = end_of(body, call.end() - 1, ")")
        arguments = body[call.end():end - 1]
        if names.intersection(re.findall(r"\b\w+\b", arguments)):
            sample.add(call[1])
    return {"sin", "cos"} <= sample or bool(sample - {"sin", "cos"})


def samplers(path, source, authored=None):
    for loop in LOOP.finditer(source):
        end = end_of(source, loop.end() - 1, ")")
        header = source[loop.end():end - 1]
        if loop[1] == "for":
            index = re.match(r"\s*(?:(?:let|var)\s+)?(\w+)\s*=(?!=)", header)
        elif loop[1] == "while":
            index = re.match(r"\s*(\w+)", header)
        else:
            index = re.search(r",\s*\(\s*\w+,\s*(\w+)\s*\)\s*=>", header)
        if not index:
            continue
        at = re.match(r"\s*", source[end:]).end() + end
        if loop[1].startswith("Array"):
            body = header[index.end():]
        elif source[at:at + 1] == "{":
            body = source[at:end_of(source, at, "}")]
        else:
            body = re.split(r"[;\n]", source[at:], 1)[0]
        if not indexed_angle(body, index[1]):
            continue
        compact = space.sub("", source[loop.start():end] + body)
        if any(exception in compact for exception in OTHER_BOUNDARIES.get(path, ())):
            continue
        if authored and authored[0] <= loop.start() < authored[1] and compact.startswith(MODEL_VERTICES):
            continue
        if path == "app/formats/pcb-import.js" and compact.startswith(ALTIUM_VERTICES):
            preceding = space.sub("", source[max(0, loop.start() - 160):loop.start()])
            if preceding.endswith(ALTIUM_ARCHIVE):
                continue
        yield loop.start(), "local curve sampling; use resolved geometry with a model-space tolerance"


def ui_findings(row, path, source, uncommented):
    if row == "SUI01":
        patterns = {"retired standalone Appearance dialog": r"(?<![\w-])thp-dialog(?![\w-])"}
    elif row == "SUI02":
        if path == "app/index.html":
            uncommented = re.sub(r"<!--[\s\S]*?-->", lambda m: blank(m[0]), uncommented)
            patterns = {"retired second Help shortcut reference": r"""\bdata-action\s*=\s*(['"])cheatsheet\1"""}
        else:
            patterns = {
                "retired shortcut reference dialog": r"(?<![\w-])keys-dialog(?![\w-])",
                "retired shortcut reference route": r"\bAtriumEditorKeys\s*(?:\?\.|\.)\s*help\b",
            }
    elif row == "SUI03":
        patterns = {"retired violation-details policy": r"\bviolationDetails\b"}
    elif row == "SUI05":
        patterns = {
            "retired history dialog class": r"(?<![\w-])(?:fh-dialog|blame-dialog)(?![\w-])",
            "retired file history dialog route": r"""\bAtriumFileHistory\s*(?:(?:\?\.)?\[\s*['"]open['"]\s*\]|(?:\?\.|\.)\s*open\b)""",
            "retired direct Blame route": r"""\bAtriumBlame\s*(?:(?:\?\.)?\[\s*['"]showHistory['"]\s*\]|(?:\?\.|\.)\s*showHistory\b)""",
            "retired project history asset": r"\bhistory/project-history\.(?:js|css)\b",
        }
    elif row == "SUI07":
        if path == MOTION_INSPECTOR + "/waffle-extension.json":
            try:
                manifest = json.loads(uncommented)
            except ValueError:
                yield 0, "Motion Inspector must have an extension manifest"
                return
            if not isinstance(manifest, dict) or manifest.get("enabledByDefault") is not False or manifest.get("main") != "main.js":
                yield 0, "Motion Inspector must remain an optional extension with its own presentation"
            return
        if path == MOTION_INSPECTOR + "/main.js":
            return
        patterns = {"retired built-in Motion Inspector": r"\bAtriumMotionInspector\b|\beditor/motion-inspector\.(?:js|css)\b"}
    elif row == "F03":
        patterns = {
            "retired plain Undo dispatcher": r"\bpaintLegacy\s*(?:\?\.)?\s*\(",
            "retired Visual History renderer switch": r"""\bbutterEnabled(?:\?\.)?\s*\(\s*['"]visualHistory['"]|\.on(?:\?\.)?\s*\(\s*['"]butter\.visualHistory['"]""",
            "retired plain undo row": r"(?<![\w-])hist-opt-",
        }
    elif row == "D04":
        patterns = {
            "retired standalone DRC results panel": r"(?<![\w-])drc-panel(?![\w-])",
            "retired standalone DRC results route": r"\bAtriumDRC\s*(?:\?\.|\.)\s*openDialog\b",
        }
    elif row == "SUI04":
        patterns = {
            "retired review dialog or overlay": r"(?<![\w-])rd-(?:bar|chips?|current|dialog|form|intro|nav|note|range|status|title)(?![\w-])",
            "retired inline review module": r"\bhistory/review-diff\.js\b|\bAtriumReviewDiff\b",
            "retired inline review fallback": r"\bstartInline\b",
        }
        if path == GIT_PICKER and len(re.findall(r"\bfunction\s+openComparison\s*\(", source)) != 1:
            yield 0, "expected one openComparison launch/retry owner"
        for name in REVIEW_CALLERS.get(path, ()):
            headers = list(re.finditer(rf"\bfunction\s+{name}\s*\(", source))
            if len(headers) != 1:
                yield 0, f"could not identify the single {name} route"
                continue
            start = end_of(source, headers[0].end() - 1, ")")
            start += re.match(r"\s*", source[start:]).end()
            if source[start:start + 1] != "{":
                yield headers[0].start(), f"could not identify the {name} route body"
                continue
            end = end_of(source, start, "}")
            body = source[start:end]
            with_literals = uncommented[start:end]
            if path == GIT_PICKER:
                calls = list(re.finditer(r"\bopenComparison\s*\(", body))
                if len(calls) != 1:
                    yield headers[0].start(), f"{name} must delegate to the one openComparison launcher"
                else:
                    # The viewer passed into the launcher can start the comparison.
                    # A viewer launch elsewhere bypasses the common retry/current check.
                    first = calls[0].start()
                    last = end_of(body, calls[0].end() - 1, ")")
                    body = body[:first] + blank(body[first:last]) + body[last:]
                    with_literals = with_literals[:first] + blank(with_literals[first:last]) + with_literals[last:]
            elif not re.search(r"\bAtriumGit\s*(?:\?\.|\.)\s*compare\s*(?:\?\.)?\s*\(", body):
                yield headers[0].start(), f"{name} must delegate to AtriumGit.compare"
            if re.search(r"\bAtriumDiffView\b", uncommented[start:end]) or re.search(
                r"(?:\.|\?\.)\s*(?:start|sinceSave)\s*(?:\?\.)?\s*\(", body
            ) or re.search(r"""\[\s*(['"])(?:start|sinceSave)\1\s*\]\s*(?:\?\.)?\s*\(""", with_literals):
                yield headers[0].start(), f"{name} bypasses git-picker.openComparison"
    else:
        return
    for reason, pattern in patterns.items():
        for hit in re.finditer(pattern, uncommented):
            yield hit.start(), reason


def curve_findings(path, source):
    authored = None
    try:
        if path == MODEL:
            at, body = function_scope(source, ("arcProjection",))
            authored = (at, at + len(body))
            if MODEL_VERTICES not in space.sub("", body):
                yield at, "native authored arc vertices require the stored equal-angle projection"
        elif path == KICAD:
            at, body = function_scope(source, ("trackArc",))
            if len(re.findall(r"\barcProjection\b", body)) != 1 or not re.search(
                r"\bA\s*\.\s*arcProjection\s*\(", body
            ):
                yield at, "KiCad native track must retain its authored arc projection"
            for hit in re.finditer(r"\barcProjection\b", source):
                if not at <= hit.start() < at + len(body):
                    yield hit.start(), "authored KiCad track projection used outside trackArc"
            at, body = function_scope(source, ("pts",))
            if not re.search(r"\bG\s*\(\s*\)\s*\.\s*arc3\s*\(", body):
                yield at, "KiCad polygon arcs must use the shared S-expression projection"
        elif path == FAB:
            for hit in re.finditer(r"\barcProjection\b", source):
                yield hit.start(), "fabrication must project grid-collapse arcs through GeometryCurves"
            at, body = function_scope(source, ("gerber", "arcStroke"))
            if not re.search(r"\b(?:C|AtriumGeometryCurves)\s*\.\s*project\s*\(", body):
                yield at, "Gerber grid-collapse fallback must use the shared projector"
            if not re.search(r"\bdrawArc\s*\(", body):
                yield at, "representable Gerber arcs must retain exact opcodes"
    except ValueError as error:
        yield 0, str(error)
    for step in SAGITTA.finditer(source):
        yield step.start(), "local sagitta subdivision; use resolved geometry"
    yield from samplers(path, source, authored)


def finds(row, path, raw):
    if row in ADAPTERS:
        owner, retired = ADAPTERS[row][path]
        # Preserve quoted module names and embedded Python in the test harnesses.
        code = IGNORED.sub(lambda m: blank(m[0]) if m[0].startswith(("//", "/*")) else m[0], raw)
        if path == "mcp/board_runner.py" and row == "BR03":
            # The header codec is the Python owner. All other functions must delegate.
            definitions = list(re.finditer(r"(?ms)^def _frame_header\(.*?(?=^\S|\Z)", code))
            if len(definitions) != 1:
                yield 0, "expected one three-slot Python frame codec"
            elif sorted(re.findall(r"""struct\.(pack|unpack)\(\s*["']<3I["']""", definitions[0][0])) != ["pack", "unpack"]:
                yield definitions[0].start(), "the frame owner must encode and decode the header"
            code = re.sub(r"(?ms)^def _frame_header\(.*?(?=^\S|\Z)", lambda m: blank(m[0]), code)
        if scopes := ADAPTER_SCOPES.get((row, path)):
            source = IGNORED.sub(lambda m: blank(m[0]), code)
            for name in scopes:
                try:
                    at, body = function_scope(source, (name,))
                except ValueError as error:
                    yield 0, str(error)
                    continue
                if owner not in body:
                    yield at, f"{name} must delegate to {owner}"
                duplicate = retired.search(body)
                if duplicate:
                    yield at + duplicate.start(), f"restored local implementation of {owner}"
            return
        for name in ADAPTER_OWNERS.get((row, path), ()):
            try:
                at, body = function_scope(IGNORED.sub(lambda m: blank(m[0]), code), (name,))
            except ValueError as error:
                yield 0, str(error)
                continue
            end = at + len(body)
            code = code[:at] + blank(code[at:end]) + code[end:]
        if owner not in code:
            yield 0, f"missing delegation to {owner}"
        duplicate = retired.search(code)
        if duplicate:
            yield duplicate.start(), f"restored local implementation of {owner}"
        return
    source = IGNORED.sub(lambda m: blank(m[0]), raw)
    names = ROWS[row][path].split()
    if names:
        for item in re.finditer(DECLARATION % "|".join(names), source):
            yield item.start(), f"restore of retired {item[1]}"
    if row in DELEGATES:
        if path in DELEGATES[row]:
            scope, name = DELEGATES[row][path]
            try:
                at, body = function_scope(source, scope)
                if not re.search(rf"\b{name}\s*\(", body) or (
                    row == "G09" and re.search(r"\bM\.(?:padLand|pad|via)\(", body)
                ):
                    yield at, f"{path} must use the shared {name} decision"
                if row == "G05":
                    for hit in PAD_ROW_COPY.finditer(source):
                        yield hit.start(), f"{path} restores a local pad row decision"
            except ValueError as error:
                yield 0, str(error)
        else:
            owner = "padPlanes" if row == "G05" else "maskSeeds"
            if len(re.findall(rf"\bfunction\s*\*?\s+{owner}\s*\(", source)) != 1:
                yield 0, f"expected one shared {owner} decision"
            if row == "G05" and len(re.findall(DECLARATION % "hasPadRows", source)) != 1:
                yield 0, "expected one shared hasPadRows decision"
    geometry = {"G01": piece_owner, "G02": ink_owner, "G08": span_owner}
    if row in geometry:
        try:
            yield from geometry[row](path, source)
        except ValueError as error:
            yield 0, str(error)
    if row in ("SUI01", "SUI02", "SUI03", "SUI04", "SUI05", "SUI07", "F03", "D04"):
        uncommented = IGNORED.sub(lambda m: blank(m[0]) if m[0].startswith(("//", "/*")) else m[0], raw)
        yield from ui_findings(row, path, source, uncommented)
    if row == "G03":
        yield from curve_findings(path, source)


def controls():
    step = "app/formats/step-export.js"
    model = "function arcProjection(s) { return " + MODEL_VERTICES + "; }"
    kicad = "function trackArc() { A.arcProjection(arc); } function pts() { G().arc3(a, m, b); }"
    cases = (
        (MODEL, model, False),
        (MODEL, model + " function physicalInk() { return " + MODEL_VERTICES + "; }", True),
        (KICAD, kicad, False),
        (KICAD, kicad + " function physicalInk() { return A.arcProjection(arc); }", True),
        (KICAD, kicad.replace("G().arc3(a, m, b)", "readPolygon(a, m, b)"), True),
        (FAB, "function drillMapLayer() { return A.arcProjection(g); }", True),
        (FAB, "function drillMapLayer() { return {arc:g}; } function gerber() { function arcStroke() { C.project(edges, tol); drawArc(g); } }", False),
        (step, "function arcSteps(s, tolerance) { return 16; }", True),
        (step, "const pts = Array.from({length:24}, (_, i) => [r*Math.cos(i*.25), r*Math.sin(i*.25)]);", True),
        (step, "for (let j=0; j<=24; j++) { const t=j*.25; pts.push([Math.cos(t), Math.sin(t)]); }", True),
        ("app/formats/pcb-import.js", "const {center, start, sweep} = readArc(record); return {kind:'arc', center, start, sweep};", False),
        ("app/formats/pcb-import.js", "if (legacy) { const w=sweep(start,end), n=Math.max(2,Math.ceil(w/6)); return path(" + ALTIUM_VERTICES + ",l,width); }", False),
        ("app/formats/pcb-import.js", "return path(" + ALTIUM_VERTICES + ",l,width);", True),
        (step, "const x = r*Math.cos(end), y = r*Math.sin(end); return encodeNativeArc(x, y);", False),
        (step, "for (let i=0; i<parts.length; i++) { const t=parts[i].angle; setFrame(Math.cos(t), Math.sin(t)); }", False),
        (step, "// function arcSteps(s, tolerance) {}\nconst word = 'function arcSteps()';", False),
    )
    for path, source, reject in cases:
        if bool(list(finds("G03", path, source))) != reject:
            raise SystemExit(f"single-owner control failed: {source}")
    print("single-owner controls: rejected restored name and anonymous loop/array samplers; accepted native arcs and import grammar")
    fab = "app/formats/fab-outputs.js"
    span = "function copperSpan(i) { if (i.single) return [n,n]; return PCB.copperSpan(i); }"
    builder = "function builder() { function addEntity(i, parent) { const declared = padLayer(parent,i); } }"
    owners = (
        ("G05", CONNECTIVITY, "function builder() { padPlanes(p); }", False),
        ("G05", CONNECTIVITY, "function builder() { padPlanes(p); if (p.padStack && p.stackMode) select(); }", True),
        ("G05", "app/canvas/canvas-gpu.js", 'function stacked(p) { return PCB.hasPadRows(p) || p.kind === "via" && p.stackMode && p.stackMode !== "simple"; }', False),
        ("G05", "app/canvas/canvas-gpu.js", 'function stacked(p) { return PCB.hasPadRows(p) || p.stackMode && p.stackMode !== "simple" && (p.padStack || p.kind === "via"); }', True),
        ("G05", "app/pcb/autorouter.js", "function eachCopper() { function pad(p) { padPlanes(p); } } function other(q) { return q.padStack &&\n q.stackMode; }", True),
        ("G09", "app/checks/dfm.js", "function maskCandidates() { M.maskSeeds(p); }", False),
        ("G09", "app/checks/dfm.js", "function maskCandidates() { M.maskSeeds(p); M.padLand(p); }", True),
        ("G01", CONNECTIVITY, "function fillPieces(p) { return A.triangulateRing(p,a,true); }", False),
        ("G01", CONNECTIVITY, "function fillPieces(p) { A.triangulateRing(p,a,true); idx.splice(i,1); }", True),
        ("G01", "app/pcb/router.js", "function triangulate(p) { return Atrium.triangulateRing(p); }", True),
        ("G02", fab, "function analyse() { function graphic() { artworkInk(s); } }", False),
        ("G02", fab, "function analyse() { function graphic() { artworkInk(s); pathArc(s); } }", True),
        ("G02", fab, "function analyse() { function graphic() { if(s.fill&&pts.length>=3) plot(s); artworkInk(s); } }", True),
        ("G02", CURVES, "function artworkInk(s) {} function polygonalInk(s) {}", True),
        ("G02", CURVES, "function artworkInk(s) {}", False),
        ("G08", CONNECTIVITY, span + builder + "function backdrill() { return [Math.min(a,b),Math.max(a,b)]; }", False),
        ("G08", CONNECTIVITY, "function layerIndex(name) {} " + span + builder, True),
        ("G08", CONNECTIVITY, span.replace("if (i.single)", "if (!i.fromLayer) return [0,127]; if (i.single)") + builder, True),
    )
    for row, path, source, reject in owners:
        if bool(list(finds(row, path, source))) != reject:
            raise SystemExit(f"single-owner {row} control failed: {source}")
    print("single-owner controls: rejected restored polygonal ink and span decisions; accepted exact arc and backdrill policies")
    git_owner = ("function openComparison(open) { return open(AtriumDiffView); }"
                 "function reviewChanges() { return openComparison(viewer => viewer.sinceSave()); }")
    ui = (
        ("SUI01", "app/editor/theme-picker.js", 'function openDialog() { return el("dialog", "thp-dialog"); }', True),
        ("SUI01", "app/editor/theme-picker.js", 'attach("theme-gallery", () => Pref.show("appearance"));', False),
        ("SUI02", "app/editor/editor-key-dialogs.js", 'function help() { return container("keys-dialog"); }', True),
        ("SUI02", "app/editor/editor.js", 'case "cheatsheet": return AtriumEditorKeys.help(doc.kind);', True),
        ("SUI02", "app/editor/editor.js", 'registerAction("cheatsheet", () => ShortcutReference.open());', False),
        ("SUI02", "app/index.html", '<button data-action = "cheatsheet">Keyboard Cheat Sheet</button>', True),
        ("SUI02", "app/index.html", '<!-- deleted data-action="cheatsheet" --><button data-action="shortcuts">Keyboard Shortcuts</button>', False),
        ("SUI03", "app/editor/prefs.js", 'if (key === "pcb.violationDetails") return "click";', True),
        ("SUI03", "app/editor/prefs.js", 'if (!(key in DEFAULTS)) return v; // keeps legacy pcb.violationDetails too', False),
        ("SUI05", FILE_HISTORY, 'function open(h) { make("dialog", "fh-dialog"); }', True),
        ("SUI05", "app/history/blame.js", 'function run() { G.AtriumFileHistory?.["open"](host); }', True),
        ("SUI05", "app/lazy.js", 'register("history", spec, ["project-history", "file-history", "object-history"]);', False),
        ("SUI05", FILE_HISTORY, 'return {mount}; // .fh-dialog retired', False),
        ("SUI05", HISTORY_PANEL, 'return G.AtriumBlame?.showHistory(host, target);', True),
        ("SUI05", HISTORY_PANEL, 'return G.AtriumBlame.inspector(box, host, target);', False),
        ("SUI07", "app/automation/editor-command-host.js", 'L.need("AtriumMotionInspector").then(M => M.open());', True),
        ("SUI07", "app/lazy.js", 'register("AtriumMotionDiagnostics", spec);', False),
        ("SUI07", MOTION_INSPECTOR + "/waffle-extension.json", '{"main":"main.js","enabledByDefault":false}', False),
        ("SUI07", MOTION_INSPECTOR + "/waffle-extension.json", '{"main":"main.js","enabledByDefault":true}', True),
        ("F03", HISTORY_PANEL, 'function paintLegacy() {}', True),
        ("F03", HISTORY_PANEL, 'function paint() { if (!visual) return paintLegacy(); }', True),
        ("F03", HISTORY_PANEL, 'function update() { if (Labs.butterEnabled("visualHistory")) return; }', True),
        ("F03", HISTORY_PANEL, 'Prefs.on("butter.clipHistory", paint); view.update(states());', False),
        ("SUI05", HISTORY_PANEL, 'view = G.AtriumFileHistory.mount(box, host);', False),
        ("D04", "app/checks/drc.js", 'function openDialog() { return getDialog("drc-panel"); }', True),
        ("D04", "app/checks/drc-view.js", 'if (unavailable) return G.AtriumDRC?.openDialog(ctx);', True),
        ("D04", "app/checks/rules-editor.css", ".rules-editor, .drc-panel {inset:0}", True),
        ("D04", "app/checks/drc.js", 'function open(ctx) { return G.AtriumDRCView.run(ctx); }', False),
        ("D04", "app/checks/rules-editor.css", ".rules-editor .drc-list {gap:var(--s-2)}", False),
        ("SUI04", "app/history/review.css", ".rd-bar {position:absolute}", True),
        ("SUI04", MCAD_PANEL, 'const V = G.AtriumDiffView; function review() { return V.start?.(b,a); }', True),
        ("SUI04", MCAD_PANEL, 'const V = G.AtriumDiffView; function review() { return V?.["start"](b,a); }', True),
        ("SUI04", HISTORY_PANEL, 'function compare(a,b) { return G.AtriumGit.compare(a,b); } function reviewRestore(e) { return G.AtriumGit.compare(e); } function confirmRestore() { G.AtriumDiffView.close(); }', False),
        ("SUI04", GIT_PICKER, 'async function compare(b, a, o = {}) { const V = await L.need("AtriumDiffView"); return V.start(b,a,o); }' + git_owner, True),
        ("SUI04", GIT_PICKER, 'function compare(b, a) { return openComparison(viewer => viewer.start(b,a)); } function unrelated() { return AtriumDiffView.start(a,b); }' + git_owner, False),
        ("SUI04", GIT_PICKER, 'function compare(b, a) { if (other) return V.start(b,a); return openComparison(viewer => viewer.start(b,a)); }' + git_owner, True),
    )
    for row, path, source, reject in ui:
        if bool(list(finds(row, path, source))) != reject:
            raise SystemExit(f"single-owner {row} control failed: {source}")
    print("single-owner controls: rejected retired history surfaces and comparison bypasses, preserved compatibility routes")

    behavior = (
        ("LA04", "app/notebook/table-editor.js", "const span=V.projectedCell(state,visibleRows,r,c,touched);",
         "const m=T.merged(state,row.id,col.id);"),
        ("LA04", "app/notebook/table-visual.js",
         "function projectedCell(s,rows,r,c){return T.merged(s,rows[r].id,s.columns[c].id);} function draw(){return projectedCell(s,rows,r,c);}",
         "const merge=T.merged(s,shown.rows[r].id,s.columns[c].id);"),
        ("CQ02", "app/editor/context-menu.js", "AtriumKeymap.documentFitEntry()",
         '["Fit Document", "fit-document"]'),
        ("CQ02", "native/macos/main.swift", 'webView.evaluateJavaScript("window.AtriumKeymap.documentFitRegistration()")',
         'command(view, "Fit Document", "0", "fit")'),
        ("ED04", "app/editor/edit-selection.js", "for (const v of owned) A.moveItem(v.item,dx,dy,v);",
         "for (const v of owned) { if (v.points) v.item.points = v.points.map(move); else v.item.x = v.x + dx; }"),
        ("CQ04", "app/pcb/pcb-edit.js", "return projectSimilar(doc, defs, item, fields);",
         "function propValue(doc, defs, i, key) { return read(i, key); }"),
        ("CQ04", "app/pcb/pcb-edit.js", "return projectSimilar(doc, defs, item, fields);",
         'function padDrill(item) { add("drill", "Drill", item.drill || 0); }'),
        ("PF01", "app/formats/output-jobs.js", "const preparation = F.createPreparation(); return preparation.board(ctx.project,ctx.board,options);",
         "function localModel(ctx) { return F.analyse(ctx.project,ctx.board,options); }"),
        ("XF01", step, "const parseBody = src => reader.readWriter(src, limits, true);",
         r"function findRecords(text) { return text.search(/\bDATA\s*;/); }"),
        ("XF03", "app/formats/ipc2581.js", 'return xml.parse(String(text), {profile:"ipc"});',
         'function nextTag(text, i) { return text.indexOf("<", i); }'),
        ("BR01", PDN, "function AtriumPDNServe(scope) { scope.onmessage = receive; } "
         "function AtriumSolverClient(worker) { worker.onerror = fail; } "
         "function run(j, options) { return AtriumSolverClient(j, options, {makeWorker}); }",
         "function runLocally(worker) { worker.onmessage = receive; }"),
        ("BR01", "app/analysis/thermal.js", "return AtriumPDN.runSolver(j, options, {transfers(plain) { return plain.q.map(a => a.buffer); }});",
         "function useLocalWorker(active) { active.onerror = fail; }"),
        ("BR01", "app/workers/thermal-worker.js", "AtriumPDNServe(self, AtriumThermalCore(AtriumPDNCore()));",
         "function AtriumThermalServe(scope) { scope.onmessage = receive; }"),
        ("MH04", "app/checks/drc-markers.js", 'P.hoverStatus("drc", busy(host) ? null : statusText(item, "mm"));',
         'function writeStatus(text) { document.querySelector(".status-drc-hover").textContent = text; }'),
    )
    for row, path, delegate, restored in behavior:
        if list(finds(row, path, delegate)) or not list(finds(row, path, delegate + "\n" + restored)):
            raise SystemExit(f"single-owner {row} behavior control failed: {path}")
    preview = "function generate() { return captureRun(p, o, settings, s => s.run(set)); }"
    package = "function release() { return captureRun(p, o, settings, s => s.run(set)); }"
    restored = preview.replace("return", "J().settle?.(p, set, o); return")
    if list(finds("PF02", RELEASE, preview + package)) or not list(finds("PF02", RELEASE, restored + package)):
        raise SystemExit("single-owner PF02 release lifecycle control failed")
    save = "function saveReviewed(lib, def, project) { const ref = def.libraryRef; return Lib().portableDefinition(project, def); }"
    path = "app/library/library-sources.js"
    restored = save.replace("const ref", "const old = Store().inflate(project, def); const ref")
    if list(finds("LA03", path, save)) or not list(finds("LA03", path, restored)):
        raise SystemExit("single-owner LA03 folder projection control failed")
    print("single-owner controls: retained format policies, solver transfers and hover formatting; rejected local readers and lifecycle copies")



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="check a different worktree")
    parser.add_argument("--row", choices=ROWS, action="append", help="check a retirement before CI enforces it")
    parser.add_argument("--path", action="append", help="restrict selected rows to these repo-relative paths")
    parser.add_argument("--self-test", action="store_true", help="run only the positive and failing controls")
    args = parser.parse_args()
    controls()
    if args.self_test:
        return
    selected = {row: tuple(ROWS[row]) for row in args.row} if args.row else ENFORCED
    paths = {path for paths in selected.values() for path in paths}
    if args.path and not set(args.path) <= paths:
        parser.error("every --path must belong to a selected retirement")
    failed = False
    for row, entries in selected.items():
        for path in entries:
            if path not in ROWS[row]:
                parser.error(f"unknown enforcement path {path} for {row}")
            if args.path and path not in args.path:
                continue
            file = args.root / path
            if path in REMOVED.get(row, ()):
                if file.exists() or file.is_symlink():
                    print(f"{path}: {row}: restored retired implementation file")
                    failed = True
                continue
            if not file.is_file():
                print(f"{path}: {row}: cannot check missing source")
                failed = True
                continue
            source = file.read_text(encoding="utf-8")
            for index, reason in finds(row, path, source):
                print(f"{path}:{source.count(chr(10), 0, index) + 1}: {row}: {reason}")
                failed = True
    if failed:
        raise SystemExit(1)
    pending = [(row, len(set(paths) - set(ENFORCED.get(row, ())))) for row, paths in ROWS.items()]
    pending = [f"{count} {row} paths" for row, count in pending if count]
    print(f"single-owner: checked {', '.join(selected)}" + ("; pending " + ", ".join(pending) if pending else ""))


if __name__ == "__main__":
    main()
