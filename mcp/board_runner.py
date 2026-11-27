"""Run the editor's JavaScript headlessly with system JavaScriptCore or Node.

Board tools share a long-lived engine. App modules load lazily in dependency
order, and optional modules can be absent from a build. Scripts and translation
run in disposable workers.
"""
import ctypes as c
import ctypes.util
from functools import lru_cache
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
APP = HERE.parent / "app"
SI_PACKAGE = APP / "extensions" / "packages" / "waffle.si.js"
SI_SUPPORT = ("api", "stackup", "impedance", "field-solver", "via-stubs")


def _app(name, *deps, optional=False):
    return (APP / (name + ".js"), ("headless",) + deps, optional)


# name -> (file, dependencies, optional)
MODULES = {
    "headless": (HERE / "headless.js", (), False),
    "diagnostic-failures": _app("checks/diagnostics"),
    "diagnostics": _app("checks/performance-diagnostics", "diagnostic-failures"),
    "motion": _app("editor/editor-motion"),
    "proposal": (APP / "automation/proposal.js", (), False),
    "format-2-codec": _app("formats/format-2-codec", "source-file"),
    "format-2-units": _app("formats/format-2-units"),
    "format-2-values": _app("formats/format-2-values", "format-2-units"),
    "design-query-record": _app("checks/design-query-record"),
    "link-record": _app("project/link-record", "uuid-v7"),
    "datasheet-record": _app("notebook/datasheet-record"),
    "links": _app("project/links", "link-record", "model", "datasheet-record", "design-query-record", "calculation-records"),
    "format-2-model": _app("formats/format-2-model", "uuid-v7", "pour-marker", "format-2-codec", "format-2-values", "notebook-image-format", "design-query-record", "link-record", "datasheet-record"),
    "format-2-git": _app("formats/format-2-git", "format-2-model"),
    "saved-views": _app("project/saved-views", "format-2-model"),
    "slides": _app("notebook/slides", "saved-views", "sch-objects"),
    "canvas-input": _app("canvas/canvas-input"),
    "base64": _app("core/base64"),
    "import-sidecars": _app("formats/import-sidecars", "source-file", "base64"),
    "format-2-closure": _app("formats/format-2-closure", "format-2-model", "import-sidecars"),
    "folder-project-mcp": (HERE / "folder-project.js", ("headless", "table-format", "format-2-closure"), False),
    "collab-crdt": _app("project/collab-crdt"),
    "folder-save-mcp": (HERE / "folder-save.js", ("folder-project-mcp", "proposal", "collab-crdt", "format-2-models"), False),
    # The format registry and native editor validation are shared with the desktop.
    "obsolete-project": _app("project/obsolete-project"),
    "uuid-v7": _app("core/uuid-v7"),
    "pour-marker": _app("pcb/pour-marker"),
    "model": _app("core/model", "uuid-v7"),
    "sch-objects": _app("schematic/sch-objects", "model"),
    "placement": _app("pcb/placement", "model"),
    "paste-plan": _app("editor/paste-plan", "placement", "notebook", "calculations"),
    "edit-selection": _app("editor/edit-selection", "sch-objects", "paste-plan"),
    "notebook-image-format": _app("notebook/notebook-image-format", "mcad-xml"),
    "notebook-images": _app("notebook/notebook-images", "model", "notebook-image-format"),
    "preferred-values": _app("notebook/preferred-values"),
    "electrical-material": _app("analysis/electrical-material"),
    "calculators": _app("analysis/calculators", "preferred-values", "electrical-material"),
    "calculation-records": _app("notebook/calculation-records", "note-fields"),
    "calculation-display": _app("notebook/calculation-display", "calculation-records", "calculation-core"),
    "calculation-intent": _app("notebook/calculation-intent"),
    "query-fields": _app("checks/query-fields", "model", "calculation-core", "note-fields"),
    "design-query-parser": _app("checks/design-query-parser", "design-query-record", "calculation-intent"),
    "design-query-geometry": _app("checks/design-query-geometry", "spatial", "board-shape"),
    "design-query-context": _app("checks/design-query-context", "query-fields", "design-query-geometry"),
    "design-query-index": _app("checks/design-query-index", "design-query-context"),
    "design-query": _app("checks/design-query", "design-query-parser", "design-query-index"),
    "butter-query-service": _app("checks/query-service", "design-query", "format-2-codec", "multichannel"),
    "calculation-helpers": _app("notebook/calculation-helpers", "preferred-values"),
    "calculation-core": _app("notebook/calculation-core", "calculation-intent"),
    "calculation-design": _app("notebook/calculation-design", "model", "calculation-records", "note-fields", "query-fields"),
    "calculation-graph": _app("notebook/calculation-graph", "calculation-core", "calculation-design", "calculation-helpers"),
    "calculation-checks": _app("notebook/calculation-checks", "calculation-graph", "design-query-record"),
    "calculations": _app("notebook/calculations", "calculation-intent", "calculation-checks"),
    "numeric-fields": _app("editor/numeric-fields", "calculations", "calculators", "design-query", "rules", "viastack", "edit-selection"),
    "hierarchy": _app("project/hierarchy", "model", "sch-objects", "design-query-record"),
    "sheet-connections": _app("schematic/sheet-connections", "hierarchy", optional=True),
    "altium-records": _app("formats/altium-records"),
    "altium-rules": _app("checks/altium-rules", "altium-records"),
    "pcb-appearance": _app("pcb/pcb-appearance"),
    "geometry": _app("core/geometry"),
    "land-contours": _app("pcb/land-contours", "pcb-appearance", "geometry-curves"),
    "geometry-material": _app("pcb/geometry-material", "geometry-curves", "polygon-pour", "stackup", "viastack", "spatial"),
    "resolved-geometry": _app("pcb/resolved-geometry", "geometry-material", "mask-openings", "pcb-text", "board-shape", "pcb-draw"),
    "pcb-draw": _app("pcb/pcb-draw", "geometry", "model", "geometry-curves"),
    "component-classes": _app("pcb/component-classes", "model"),
    # Net-name intent (app/checks/net-intent.js): the one pair recogniser and rail/ground classifier.
    "net-intent": _app("checks/net-intent"),
    # The rule engine (app/checks/rules.js) and the project rule book it reads (app/checks/project-rules.js, project.rules):
    # every module that needs "rules" gets both.
    "rules-engine": _app("checks/rules", "model", "land-contours", "geometry-curves", "net-intent", "signals", "altium-rules", "pcb-draw", "component-classes", "design-query", "query-exchange"),
    "rules": _app("checks/project-rules", "rules-engine"),
    # Signals and tags (format 1.4, app/core/signals.js): validates project.signals and keeps the legacy mirror.
    "signals": _app("core/signals", "model", "net-intent"),
    "blocks": _app("schematic/blocks", "placement"),
    "net-ties": _app("checks/net-ties"),
    # Rust/WebAssembly kernels (app/engine-core.js); connectivity.js falls back to JS without them.
    "engine-core": _app("engine-core", optional=True),
    "connectivity": _app("checks/connectivity", "model", "pcb-appearance", "net-ties", "engine-core"),
    "revision-review": _app("history/revision-review", "model"),
    "board-runner": (HERE / "board-runner.js", ("model", "net-intent", "altium-rules", "rules", "signals", "blocks", "connectivity", "revision-review", "query"), False),
    "variants": _app("project/variants", "model"),
    "multichannel": _app("schematic/multichannel", "model", "sch-objects", "hierarchy", optional=True),
    "rooms": _app("pcb/rooms", "model", optional=True),
    "core": (None, ("model", "sch-objects", "hierarchy", "altium-rules", "rules", "signals", "blocks", "proposal", "variants", "multichannel", "rooms"), False),
    "parts": _app("library/parts", "model"),
    "zip": _app("core/zip"),
    "zipjs-deflate": _app("vendor/zipjs-deflate"),
    "format-2-models": _app("formats/format-2-models", "zipjs-deflate", "source-file", "sexpr", "zip"),
    "pcb-pours": _app("pcb/pcb-pours"),
    "pcb-net-labels": _app("canvas/pcb-net-labels", "pcb-pours"),
    "stackup": _app("pcb/stackup", "model"),
    "mask-openings": _app("pcb/mask-openings", "pcb-appearance", "rules", "viastack"),
    "fab-outputs": _app("formats/fab-outputs", "model", "pcb-appearance", "designator-place", "zip", "drc-pours", "board-shape-sources", "resolved-geometry"),
    # Poured copper against the Clearance rules (drc-pours.js): outputs verify it before they are made.
    "drc-pours": _app("checks/drc-pours", "rules", "pcb-pours"),
    "bom": _app("formats/bom", "model", "zip"),
    "bom-optimiser": _app("formats/bom-optimiser", "bom", optional=True),
    "component-match": _app("library/component-match"),
    "eco": _app("schematic/eco", "model", "hierarchy", "component-match"),
    # Design authoring (place_part, add_wire, ...) and ECO v2 (update_pcb).
    "pcb-edit": _app("pcb/pcb-edit", "model", "pcb-appearance", optional=True),
    "sch-author": _app("schematic/sch-author", "model", "sch-objects", "parts", "eco", "pcb-edit"),
    "annotate": _app("notebook/annotate", "model", "eco"),
    "erc": _app("checks/erc", "model", "messages", "hierarchy", "net-ties", "rules"),  # settings: the project rule book
    "rule-scope-demand": _app("checks/rule-scope-demand"),
    "polygon-pour": _app("pcb/polygon-pour", "rule-scope-demand", "geometry", "model", "pour-marker", "pcb-appearance", "pcb-pours", "board-shape", "stackup", "rules", "engine-core", "rooms", "dfa", "viastack"),
    "pour-manager": _app("pcb/pour-manager", "polygon-pour"),
    "kicad-export": _app("formats/kicad-export", "model", "stackup", "pcb-draw", "rules", "pcb-pours", "pcb-appearance",
                        "pcb-text", "designator-place", "board-shape", "zip", "variants"),
    "frame-conversion": _app("formats/frame-conversion", "hierarchy", "sch-objects", "sch-appearance", "multichannel", "erc"),
    "schematic-output": _app("formats/schematic-output", "sch-appearance", "sch-curves", "sch-objects", "canvas"),
    "altium-export": _app("formats/altium-export", "schematic-output", "sch-curves", "hierarchy", "sexpr", "model", "stackup", "board-shape", "pcb-draw", "designator-place", "rules", "zip", "sch-objects"),
    "geometry-curves": _app("pcb/resolved-geometry-curves"),
    "board-shape-core": _app("pcb/board-shape-core", "model", "geometry-curves"),
    "board-shape": _app("pcb/board-shape", "board-shape-core", optional=True),
    "board-shape-sources": _app("formats/board-shape-sources", "board-shape"),
    "rigid-flex": _app("pcb/rigid-flex", "geometry", "land-contours", "stackup", optional=True),
    "step-import": _app("formats/step-import", optional=True),
    "step-export": _app("formats/step-export", "sexpr", "step-import", "model", "stackup", "board-shape", "rigid-flex", "fab-outputs", "flex-fold"),
    "kicad-schematic": _app("formats/kicad-schematic", "schematic-output", "kicad-export", "sch-objects"),
    "spatial": _app("core/spatial"),
    "sch-appearance": _app("schematic/sch-appearance", "model"),
    "sch-curves": _app("schematic/sch-curves", "model"),
    "canvas": _app("canvas/canvas", "model", "pcb-appearance", "pcb-text", "designator-place", "pcb-pours", "spatial", "connectivity",
                   "sch-appearance", "stackup"),
    "svg-canvas": (HERE / "svg-canvas.js", ("headless",), False),
    "vectorize": _app("canvas/vectorize"),
    "pcb-text-rich": _app("pcb/pcb-text-rich", "vectorize"),
    "stroke-font": _app("canvas/stroke-font"),
    "pcb-text": _app("pcb/pcb-text", "pcb-appearance", "stroke-font", "pcb-text-rich"),
    "designator-place": _app("pcb/designator-place", "model", "pcb-text"),
    "path-record": _app("core/path-record"),
    "pdf": _app("formats/pdf", "path-record"),
    "notebook-output": _app("formats/notebook-output"),
    "stix-math-data": _app("vendor/stix-two-math"),
    "math-font": _app("notebook/math-font", "stix-math-data"),
    "math-tex": _app("notebook/math-tex"),
    "math-pdf": _app("notebook/math-pdf"),
    "math": _app("notebook/math", "math-font", "math-tex", "math-pdf"),
    "note-fields": _app("notebook/note-fields", "model", "hierarchy"),
    "notebook": _app("notebook/notebook", "note-fields", "link-record"),
    "notebook-font-data": _app("vendor/notebook-fonts/faces"),
    "notebook-fonts": _app("notebook/notebook-fonts", "notebook-font-data"),
    "rich-text-view": _app("notebook/rich-text-view", "note-fields", "notebook-fonts"),
    "rich-text": _app("notebook/rich-text", "notebook", "rich-text-view"),
    "widget-fallback": _app("notebook/widget-fallback"),
    "widget-catalogue": _app("notebook/widget-catalogue", "widget-fallback"),
    "sheet-widgets": _app("notebook/sheet-widgets", "widget-catalogue"),
    "table-data": _app("notebook/table-data", "source-file"),
    "table-format": _app("notebook/table-format", "table-data", "format-2-codec", "notebook"),
    "table-exchange": _app("notebook/table-exchange", "table-data"),
    "table-formulas": _app("notebook/table-formulas", "table-data", "calculation-graph"),
    "table-query": _app("notebook/table-query", "table-data", "design-query"),
    "table-visual": _app("notebook/table-visual", "table-exchange", "table-formulas", "sheet-widgets"),
    "review-comments": _app("history/review-comments", "model"),
    "sch-note-ink": _app("notebook/sch-note-ink"),
    "sch-note-leader": _app("notebook/sch-note-leader"),
    "sch-note-layer": _app("notebook/sch-note-layer"),
    "review-notes-model": _app("history/review-notes-model", "rich-text", "review-comments", "sheet-widgets",
                               "sch-note-ink", "sch-note-leader", "sch-note-layer"),
    "print": _app("formats/print", "notebook-output", "pdf", "pdf-fonts", "pcb-text", "canvas", "fab-outputs", "sheet-connections"),
    # Embedded Unicode font for PDF output and drawing documents (draftsman).
    "dejavu": _app("vendor/dejavu-sans"),
    "pdf-fonts": _app("formats/pdf-fonts", "pdf", "dejavu"),
    "drawing-views": _app("formats/drawing-views", "print", "bom", "stackup", "board-shape", "step-export", optional=True),
    "drawing": _app("formats/drawing", "drawing-views", optional=True),
    "messages": _app("editor/messages"),
    "sexpr": _app("formats/sexpr", "model", "geometry-curves"),
    "import-kicad": _app("formats/import-kicad", "sexpr"),
    # KiCad symbol and footprint libraries paired into components; folder libraries (library-sources.js).
    "library-import-kicad": _app("library/library-import-kicad", "import-kicad", "library-store"),
    "catalogue": _app("library/catalogue", "model", "component-families"),
    "library-sources": _app("library/library-sources", "library", "catalogue", "library-import-kicad", "altium-io"),
    "import-eagle": _app("formats/import-eagle", "sexpr"),
    "import-easyeda": _app("formats/import-easyeda", "sexpr"),
    "export-eagle": _app("formats/export-eagle", "model", "erc", "board-shape", "import-eagle", "source-file", "translator-provenance"),
    "export-easyeda-standard": _app("formats/export-easyeda-standard"),
    "export-easyeda-pro": _app("formats/export-easyeda-pro"),
    "export-easyeda": _app("formats/export-easyeda", "model", "board-shape", "source-file", "zip", "import-formats",
                           "translator-provenance", "export-easyeda-standard", "export-easyeda-pro"),
    "import-link": _app("formats/import-link", "model", "rules", "pcb-pours"),
    # Altium Designer files (binary OLE through the vendored SheetJS cfb reader, or ASCII): io.js picks the importer.
    "cfb": _app("vendor/cfb.min"),
    "sha256": _app("core/sha256"),
    "source-file": _app("project/source-file", "sha256"),
    "altium-ids": _app("formats/altium-ids"),  # stable ids of imported Altium objects
    "sch-import": _app("formats/sch-import", "model", "sch-objects", "altium-ids", "altium-records"),
    "altium-typefaces": _app("formats/altium-typefaces", "sexpr", "typeface-reader"),
    "typeface-reader": _app("formats/pdf-fonts"),
    "pcb-import": _app("formats/pcb-import", "altium-typefaces", "model", "pcb-pours", "altium-rules", "board-shape-sources", "stackup", "altium-ids"),
    "altium-io": _app("formats/io", "model", "cfb", "source-file", "sch-import", "pcb-import", "library-import-altium"),
    "library-import-altium": _app("library/library-import-altium", "library-pairing"),  # SchLib + PcbLib pairs into components
    "sch-patch": _app("formats/sch-patch", "source-file", "altium-records"),
    "pcb-patch": _app("formats/pcb-patch", "source-file", "altium-records"),
    "source-copy": _app("formats/source-copy", "altium-io", "sch-patch", "pcb-patch", "pour-marker"),
    # Imported board rules (import_design source_rules "use"): Altium source rules -> doc.rules, stale pours repoured.
    "import-rules": _app("formats/import-rules", "rules", "polygon-pour", optional=True),
    "import-formats": (None, ("sexpr", "import-kicad", "library-import-kicad", "import-eagle", "import-easyeda", "import-link", "board-shape-sources", "stackup", "hierarchy", "altium-io"), False),
    "netlist": _app("schematic/netlist", "model", "hierarchy", optional=True),
    "dxf": _app("formats/dxf", "model", "board-shape", optional=True),
    "mcad": _app("formats/mcad", "model", "board-shape", "pcb-edit", "step-export", "stackup", optional=True),
    "mcad-xml": _app("formats/mcad-xml", optional=True),
    "mcad-idx": _app("formats/mcad-idx", "mcad-xml", "mcad", optional=True),
    "mcad-idf": _app("formats/mcad-idf", "mcad", "mcad-idx", optional=True),
    "mcad-step": _app("formats/mcad-step", "mcad", "step-import", "collision-3d", optional=True),
    "translator-table": _app("translator-table"),
    "translator-registry": _app("formats/translator-registry", "translator-table", "obsolete-project"),
    "translator-precision": _app("formats/translator-precision", "format-2-model"),
    "translator-provenance": _app("formats/translator-provenance"),
    "import-export": _app("formats/import-export", "model", "translator-registry"),
    "translator-adapters": _app("formats/translator-adapters"),
    "translator-exports": _app("formats/translator-exports"),
    "translator-manufacturing": _app("formats/translator-manufacturing"),
    "translators": _app("formats/translators", "translator-registry", "translator-provenance"),
    "viastack": _app("pcb/viastack", "stackup", optional=True),
    "via-stubs": _app("pcb/via-stubs", "rules", "stackup", "viastack", optional=True),
    "si": _app("analysis/si", "rules", "stackup", "impedance", "rigid-flex", "pcb-pours", optional=True),
    "pdn": _app("analysis/pdn", "model", "land-contours", "stackup", "pcb-pours", "electrical-material", optional=True),
    # Thermal: IPC-2152 current capacity (also the Current Capacity DRC rule) and the temperature rise map.
    "ipc2152": _app("analysis/ipc2152", "rules", "stackup", "pdn", optional=True),
    "thermal": _app("analysis/thermal", "model", "stackup", "pcb-pours", "pdn", "variants", "board-shape", optional=True),
    "stress": _app("analysis/stress", "model", "sch-objects", "hierarchy", "variants", "electrical-material", optional=True),
    "rule-sets": _app("checks/rule-sets", "rules", "fab-profiles", optional=True),
    "impedance": _app("analysis/impedance", optional=True),
    # Impedance plan (app/analysis/impedance-plan.js): per-layer solutions and ranked fixes for an impedance spec.
    "impedance-plan": _app("analysis/impedance-plan", "stackup", "impedance", "rigid-flex", optional=True),
    "dfa": _app("checks/dfa", "rules", optional=True),
    "constraints": _app("checks/constraints", "rules", "stackup", "impedance", "dfa", "length", optional=True),
    # Optional modules: skipped when this build does not include them.
    "z-clearance": _app("checks/z-clearance", "rules", "stackup", optional=True),
    "flex-drc": _app("checks/flex-drc", "rigid-flex", "rules", optional=True),
    "flex-fold": _app("canvas/flex-fold", "rigid-flex", optional=True),
    "collision-3d": _app("canvas/collision-3d", "geometry", "step-export", "flex-fold", "step-import", optional=True),
    # Creepage and clearance by voltage (app/checks/creepage.js): the Creepage Distance rule's DRC hook and the layout hint.
    "creepage": _app("checks/creepage", "geometry", "rules", "signals", "net-intent-index", "pcb-pours", "board-shape", optional=True),
    "drc": _app("checks/drc", "rules", "connectivity", "length", "z-clearance", "flex-drc", "collision-3d", "query", "xsignals", "topology", "parallel-segment", "return-path", "impedance-checks", "creepage",
                "pcb-appearance", "pcb-text", "designator-place", "mask-openings", optional=True),
    "drc-fixes": _app("checks/drc-fixes", "rules"),
    "waivers": _app("checks/waivers", "model", optional=True),
    "drc-waivers": _app("checks/drc-waivers", "model", "waivers", optional=True),
    "fab-profiles": _app("formats/fab-profiles", "rules", "fab-presets-jlcpcb", optional=True),  # JLC profiles are the sourced presets
    "panel": _app("pcb/panel", "fab-outputs", "board-shape", "fab-profiles", "stackup", "rules", optional=True),
    "ipc2581": _app("formats/ipc2581", "mcad-xml", "fab-outputs", "stackup", "board-shape", "rules", optional=True),
    "odb-eda": _app("formats/odb-eda"),
    "odb": _app("formats/odb", "odb-eda", "fab-outputs", "stackup", "board-shape", "variants", "bom", "rigid-flex", "viastack", "panel", "zipjs-deflate"),
    "output-jobs": _app("formats/output-jobs", "sha256", "fab-outputs", "ipc2581", "bom", "zip", "stackup", "board-shape", "rigid-flex", "step-export", "kicad-export",
                        "kicad-schematic", "erc", "drc", "connectivity", "pcb-appearance", "fab-profiles", "panel", "drawing", optional=True),
    "release": _app("formats/release", "output-jobs", "variants", optional=True),  # output-jobs-v2: release / list_releases
    # fab-presets: Fab Capability Presets (data in app/fab-presets/) and the DFM check
    "fab-presets": _app("formats/fab-presets", "rules", "query", "stackup", "impedance", optional=True),
    "fab-presets-jlcpcb": _app("fab-presets/jlcpcb", "fab-presets", optional=True),
    "dfm": _app("checks/dfm", "geometry", "fab-presets-jlcpcb", "board-shape", "polygon-pour", "pcb-text", "designator-place", "mask-openings", optional=True),
    # Design Insights (list_insights): the engine and its board and schematic checks; si/return-path/ipc2152 when present.
    "insights-core": _app("checks/insights", "geometry", "model", "land-contours", optional=True),
    "insights": _app("checks/insights-sch", "insights-core", "insights-pcb", "sch-objects", "erc", optional=True),
    # Net intent index (suggestions, conventions, completion) and the insights that read it (docs/design/net-intent.md P1/P2),
    # registered after the schematic checks, as the editor loads them.
    "net-intent-index": _app("checks/net-intent-index", "net-intent", "model", "sch-objects", optional=True),
    "insights-intent": _app("checks/insights-intent", "insights", "net-intent-index", optional=True),
    "insights-pcb": _app("checks/insights-pcb", "insights-core", "polygon-pour", "board-shape", "viastack", "rules", "stackup", "pcb-pours", "si", "return-path", "ipc2152", optional=True),
    "timing": _app("pcb/timing-vision", "rules", "stackup", "impedance", optional=True),
    "length": _app("pcb/length-tuning", "geometry", "rules", "stackup", "timing", "xsignals", optional=True),
    # High-speed suite: rule query scopes (InxSignal...), xSignals, topology, parallel segments, return path, field solver.
    "query-exchange": _app("checks/query-exchange"),
    "query": _app("checks/query", "model", "design-query", "query-exchange", optional=True),
    "xsignals": _app("pcb/xsignals", "rules", "query", optional=True),
    "signals-panel": _app("editor/signals-panel", "rules", "signals", "net-intent", "net-intent-index", optional=True),
    "topology": _app("pcb/topology", "rules", optional=True),
    "parallel-segment": _app("pcb/parallel-segment", "rules", "stackup", optional=True),
    "return-path": _app("analysis/return-path", "si", optional=True),
    "impedance-checks": _app("analysis/impedance-checks", "stackup", "si", optional=True),
    "field-solver": _app("analysis/field-solver", "impedance", optional=True),
    # The source checkout can run the original files before preparing its built-in package.
    "si-package": (SI_PACKAGE, ("headless",), False),
    "si-ibis": (HERE.parent / "extensions" / "si" / "ibis.js", ("headless",), True),
    "si-solver": (HERE.parent / "extensions" / "si" / "solver.js", ("headless",), True),
    "si-channel": (HERE.parent / "extensions" / "si" / "channel.js", ("headless",), True),
    "si-sim": (HERE.parent / "extensions" / "si" / "engine.js", ("headless", "si-ibis", "si-solver", "si-channel", *SI_SUPPORT), True),
    "router": _app("pcb/router", "geometry", "rules", "pcb-appearance", optional=True),
    # Route Suggestions (suggest_route): the engine and the habits profile.
    "route-habits": _app("pcb/route-habits", optional=True),
    "route-suggest": _app("pcb/route-suggest-engine", "geometry", "router", "route-habits", "stackup", "viastack", optional=True),
    "fanout": _app("pcb/fanout", "rules", "pcb-appearance", optional=True),
    "autorouter": _app("pcb/autorouter", "geometry", "rules", "connectivity", "pcb-appearance", "fanout", optional=True),
    "autorouter-v2": _app("pcb/autorouter-v2", "autorouter", "fanout", "router", "length", "viastack", optional=True),
    "api": _app("core/atrium-api", "model", "rules", "proposal", optional=True),
    "scripting": _app("automation/scripting", "model", "api", optional=True),
    # Library tools (create_footprint, create_symbol, validate_library_def, update_parts_from_library).
    "component-families": _app("library/component-families", "model"),
    "library-pairing": _app("library/library-pairing"),
    "library-store": _app("library/library-store", "sha256", "library-pairing"),  # content hashes, 3D blob table, health checks (library-management)
    "library": _app("library/library-panel", "model", "parts", "component-families", "library-store"),
    # Package families for the wizard (footprint-packages.js installs into whichever loads second).
    "footprint-packages": _app("library/footprint-packages", optional=True),
    "footprint-wizard": _app("library/footprint-wizard", "library", "footprint-packages"),
}


def resolve(names):
    """Files for `names` and their dependencies, dependencies first, without duplicates."""
    order, seen = [], set()

    def visit(name):
        if name in seen:
            return
        seen.add(name)
        path, deps, optional = MODULES[name]
        if name == "si-sim" and SI_PACKAGE.is_file():
            # Use the installed first-party package only when a simulation needs it.
            path, deps, optional = HERE / "si-builtin.js", ("si-package", *SI_SUPPORT), False
        for dep in deps:
            visit(dep)
        if path is not None and (not optional or path.is_file()):
            order.append((name, path))
    for name in names:
        visit(name)
    return order


@lru_cache(maxsize=1)
def translator_table():
    """The manifest that generates the same registry used by the editor worker."""
    return json.loads((APP / "translators.json").read_text(encoding="utf-8"))


def translator_modules(entries, direction):
    roots = tuple(dict.fromkeys(root for entry in entries for root in entry["modules"][direction]))
    return ("headless", "translators", "model") + (("obsolete-project",) if direction == "import" else ()) + roots + ("translator-adapters", "translator-exports", "translator-manufacturing")


def load_jsc():
    names = []
    if sys.platform == "darwin":
        names = ["/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore"]
    elif sys.platform.startswith("linux"):
        names = [ctypes.util.find_library("javascriptcoregtk-" + version) for version in ("6.0", "4.1", "4.0")]
    for name in filter(None, names):
        try:
            return c.CDLL(name)
        except OSError:
            continue
    return None


_SIGNATURES = None
_JSC_FUNCTION = c.CFUNCTYPE(c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_size_t,
                           c.POINTER(c.c_void_p), c.POINTER(c.c_void_p))


def _bind(lib):
    global _SIGNATURES
    if _SIGNATURES is lib:
        return
    ref, exception = c.c_void_p, c.POINTER(c.c_void_p)
    signatures = {
        "JSGlobalContextCreate": (ref, [ref]),
        "JSGlobalContextCreateInGroup": (ref, [ref, ref]),
        "JSGlobalContextRelease": (None, [ref]),
        "JSContextGetGroup": (ref, [ref]),
        "JSGarbageCollect": (None, [ref]),
        "JSStringCreateWithUTF8CString": (ref, [c.c_char_p]),
        "JSStringRelease": (None, [ref]),
        "JSStringGetLength": (c.c_size_t, [ref]),
        "JSStringGetCharactersPtr": (c.c_void_p, [ref]),
        "JSValueMakeString": (ref, [ref, ref]),
        "JSValueProtect": (None, [ref, ref]),
        "JSValueUnprotect": (None, [ref, ref]),
        "JSValueToStringCopy": (ref, [ref, ref, exception]),
        "JSEvaluateScript": (ref, [ref, ref, ref, ref, c.c_int, exception]),
        "JSObjectCallAsFunction": (ref, [ref, ref, ref, c.c_size_t, exception, exception]),
    }
    optional = {
        "JSValueMakeNumber": (ref, [ref, c.c_double]),
        "JSObjectMakeFunctionWithCallback": (ref, [ref, ref, _JSC_FUNCTION]),
        # Private but exported by every JavaScriptCore build: a watchdog that
        # terminates long-running scripts.
        "JSContextGroupSetExecutionTimeLimit": (None, [ref, c.c_double, ref, ref]),
        "JSContextGroupClearExecutionTimeLimit": (None, [ref]),
    }
    for table, required in ((signatures, True), (optional, False)):
        for name, (ret, args) in table.items():
            function = getattr(lib, name, None)
            if function is None:
                if required:
                    raise ValueError("JavaScriptCore lacks " + name + ".")
                continue
            function.argtypes, function.restype = args, ret
    _SIGNATURES = lib


# bool (*JSShouldTerminateCallback)(JSContextRef, void*): called each time the watchdog slice expires.
_TERMINATE = c.CFUNCTYPE(c.c_bool, c.c_void_p, c.c_void_p)


def _peak_rss():
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)


class ToolLimit(ValueError):
    """An in-process call ran past its time or memory limit; its JavaScript state is discarded."""


class JavaScriptCore:
    """Call the public JSContext C API and pass project data as JS string arguments."""
    def __init__(self, lib, modules=("board-runner",)):
        self.lib = lib
        _bind(lib)
        self.context = lib.JSGlobalContextCreate(None)
        if not self.context:
            raise ValueError("Could not create the JavaScriptCore context.")
        self.loaded, self.functions = set(), {}
        self.diagnostics_clock = None
        self.timer = hasattr(lib, "JSContextGroupSetExecutionTimeLimit")
        self.armed = None  # Seconds per API entry while the watchdog stays armed (scripts).
        try:
            self.evaluate("globalThis.__waffleUUIDSeed = " + json.dumps(os.urandom(10).hex()))
            self.ensure(modules)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.context:
            self.lib.JSGlobalContextRelease(self.context)
            self.context = None
            self.diagnostics_clock = None

    def install_diagnostics_clock(self):
        """Install a monotonic clock in the trusted board context on first recording."""
        if self.diagnostics_clock is not None:
            return
        make_number = getattr(self.lib, "JSValueMakeNumber", None)
        make_function = getattr(self.lib, "JSObjectMakeFunctionWithCallback", None)
        if not make_number or not make_function:
            return  # The headless wall-clock shim tells the recorder to omit durations.
        if self.value_text(self.evaluate('Object.hasOwn(globalThis.performance ?? {}, "__waffleDiagnosticsNow")')) != "true":
            return  # This engine already has its own performance clock.
        monotonic_ns = time.monotonic_ns
        try:
            epoch = monotonic_ns()
        except OSError:
            return

        @_JSC_FUNCTION
        def now(context, _function, _receiver, _argc, _argv, _exception):
            try:
                elapsed = (monotonic_ns() - epoch) / 1_000_000
            except OSError:
                elapsed = float("nan")
            return make_number(context, elapsed)

        install = self.evaluate('(now) => Object.defineProperty(performance, "__waffleDiagnosticsNow", {value: now})')
        self.lib.JSValueProtect(self.context, install)
        try:
            clock = make_function(self.context, None, now)
            if clock and self.lib.JSObjectCallAsFunction(self.context, install, None, 1, (c.c_void_p * 1)(clock), None):
                self.diagnostics_clock = now  # ctypes must retain the callback until JSGlobalContextRelease.
        finally:
            self.lib.JSValueUnprotect(self.context, install)

    def ensure(self, names):
        for name, path in resolve(names):
            if name not in self.loaded:
                self.evaluate(path.read_text(encoding="utf-8"), str(path))
                if name == "engine-core":
                    requested = self.value_text(self.evaluate("AtriumEngine.candidates.join(',')")).split(",")
                    for variant in ("simd128", "mvp"):
                        if variant not in requested:
                            continue
                        asset = path.with_name("engine-" + variant + ".js")
                        if asset.is_file():
                            self.evaluate(asset.read_text(encoding="utf-8"), str(asset))
                            self.evaluate("AtriumEngine.activate(" + json.dumps(variant) + ")")
                            if self.value_text(self.evaluate("AtriumEngine.available")) == "true":
                                break
                    self.evaluate("AtriumEngine.finish()")
                self.loaded.add(name)

    def string(self, ref):
        """Copy a JSString as UTF-16 code units: two bytes per character, no transcoding buffer."""
        length = self.lib.JSStringGetLength(ref)
        if not length:
            return ""
        data = c.string_at(self.lib.JSStringGetCharactersPtr(ref), length * 2)
        return data.decode("utf-16-le", "surrogatepass")

    def arm(self, seconds):
        """Keep the watchdog armed for every later API call on this context.

        JavaScriptCore drains the microtask queue whenever the outermost API call
        returns, including lookups and string conversions. A per-call limit leaves
        those drains unbounded (`await null; for (;;) {}`), so script contexts arm
        the limit once and never clear it."""
        if not self.timer:
            raise ValueError("This JavaScriptCore has no execution time limit.")
        self.armed = float(seconds)
        self.lib.JSContextGroupSetExecutionTimeLimit(self.lib.JSContextGetGroup(self.context), self.armed, None, None)

    def value_text(self, value):
        string = self.lib.JSValueToStringCopy(self.context, value, None)
        if not string:
            if self.armed:
                raise ValueError("The script exceeded its time limit of %g s." % self.armed)
            raise ValueError("JavaScriptCore could not return the report.")
        try:
            return self.string(string)
        finally:
            self.lib.JSStringRelease(string)

    def evaluate(self, script, url=None):
        string = self.lib.JSStringCreateWithUTF8CString(script.encode("utf-8"))
        source = self.lib.JSStringCreateWithUTF8CString(url.encode("utf-8")) if url else None
        exc = c.c_void_p()
        try:
            result = self.lib.JSEvaluateScript(self.context, string, None, source, 1, c.byref(exc))
            if exc.value:
                raise ValueError(self.value_text(exc.value))
            return result
        finally:
            self.lib.JSStringRelease(string)
            if source:
                self.lib.JSStringRelease(source)

    def function(self, name):
        if name not in self.functions:
            # The function stays rooted by the shared script's global binding.
            self.functions[name] = self.evaluate("globalThis." + name)
        return self.functions[name]

    def run(self, payloads, entry="AtriumBoardReport", timeout=None, memory=None):
        """Call `entry`. With `timeout` (s) or `memory` (bytes of peak-RSS growth) the watchdog
        checks both every quarter second and terminates the call past either limit."""
        args = (c.c_void_p * len(payloads))()
        protected = []
        exc = c.c_void_p()
        group = self.lib.JSContextGetGroup(self.context) if (timeout or memory) and self.timer and not self.armed else None
        guard, self.stopped = None, None
        if group:
            started, base = time.monotonic(), _peak_rss()

            def should_stop(_ctx, _data):
                if timeout and time.monotonic() - started > timeout:
                    self.stopped = "its time limit of %g s" % timeout
                elif memory and _peak_rss() - base > memory:
                    self.stopped = "its memory limit of %d MB" % (memory >> 20)
                if self.stopped is None:  # Returning false does not re-arm the watchdog: arm it again.
                    self.lib.JSContextGroupSetExecutionTimeLimit(group, 0.25, c.cast(guard, c.c_void_p), None)
                return self.stopped is not None
            guard = _TERMINATE(should_stop)
        try:
            for index, payload in enumerate(payloads):
                string = self.lib.JSStringCreateWithUTF8CString(payload)
                if not string:
                    raise ValueError("Expected a UTF-8 project file.")
                value = self.lib.JSValueMakeString(self.context, string)
                self.lib.JSValueProtect(self.context, value)
                protected.append(value)
                args[index] = value
                self.lib.JSStringRelease(string)
            if group:
                self.lib.JSContextGroupSetExecutionTimeLimit(group, 0.25, c.cast(guard, c.c_void_p), None)
            result = self.lib.JSObjectCallAsFunction(self.context, self.function(entry), None, len(payloads), args, c.byref(exc))
            if self.stopped:
                raise ToolLimit("The operation exceeded " + self.stopped + " and was stopped.")
            if exc.value:
                message = self.value_text(exc.value)
                if (group or self.armed) and "terminat" in message.lower():
                    raise ValueError("The script exceeded its time limit of %g s." % (timeout or self.armed))
                raise ValueError(message)
            if not result:
                raise ValueError("The script exceeded its time limit of %g s." % (timeout or self.armed or 0))
            return self.value_text(result)
        finally:
            if group:
                self.lib.JSContextGroupClearExecutionTimeLimit(group)
            for value in protected:
                self.lib.JSValueUnprotect(self.context, value)

    def collect(self):
        self.lib.JSGarbageCollect(self.context)


REPORT_TIMEOUT, REPORT_MEMORY = 120, 2 << 30  # Board reports run in-process under the watchdog too.


class WorkerStopped(ValueError):
    """A read-only inspection can be retried in a fresh subprocess."""


def _split(text):
    head, sep, body = text.partition("\n")
    return json.loads(head), (body if sep else None)


JSC_HELPER = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"


def jsc_cli_path():
    """The system `jsc` helper when the jsc-cli engine should run board calls, else None.

    ATRIUM_MCP_ENGINE=inprocess keeps every call in the server's own JavaScriptCore context;
    ATRIUM_JSC_CLI names another jsc binary."""
    if os.environ.get("ATRIUM_MCP_ENGINE", "").lower() in ("inprocess", "in-process", "jsc", "node"):
        return None
    path = os.environ.get("ATRIUM_JSC_CLI") or (JSC_HELPER if sys.platform == "darwin" else None)
    return path if path and os.path.isfile(path) and os.access(path, os.X_OK) else None


def _resident(pid):
    """Resident bytes of process `pid` (macOS proc_pid_rusage), or None."""
    try:
        lib = _resident.lib = getattr(_resident, "lib", None) or c.CDLL("/usr/lib/libproc.dylib")
        info = (c.c_uint64 * 32)()
        if lib.proc_pid_rusage(int(pid), 0, info) != 0:
            return None
        return int(info[8])  # rusage_info_v0: uuid (2 words), user, system, idle wakeups, interrupt wakeups, pageins, wired, resident
    except (OSError, AttributeError):
        return None


class CliWorker:
    """One long-lived `jsc` helper process running mcp/jsc-worker.js (see its protocol).

    Calls exchange files in a private temporary folder (mode 0700). The parent enforces each
    call's time and memory limits by killing the process, like the in-process watchdog."""
    def __init__(self, path):
        self.dir = tempfile.mkdtemp(prefix="atrium-engine-")
        self.seq = 0
        self.process = subprocess.Popen([path, str(HERE / "jsc-worker.js")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, cwd=self.dir)

    def alive(self):
        return self.process.poll() is None

    def close(self):
        try:
            self.process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def kill(self):
        self.process.kill()
        self.process.wait()
        self.process.stdout.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def call(self, files, entry, parts, timeout=None, memory=None):
        self.seq += 1
        names = []
        try:
            for index, part in enumerate(parts):
                name = os.path.join(self.dir, "%d-%d" % (self.seq, index))
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as fp:
                    fp.write(part)
                names.append(name)
            out = os.path.join(self.dir, "%d-out" % self.seq)
            names.append(out)
            request = {"modules": files, "entry": entry, "parts": names[:-1], "out": out}
            if self.seq == 1:
                request["uuidSeed"] = os.urandom(10).hex()
            line = json.dumps(request, ensure_ascii=True) + "\n"
            self.process.stdin.write(line.encode("ascii"))
            self.process.stdin.flush()
            started, base = time.monotonic(), (_resident(self.process.pid) if memory else None)
            import select
            while True:
                wait = 0.25
                if timeout:
                    wait = min(wait, max(0.0, timeout - (time.monotonic() - started)))
                if select.select([self.process.stdout], [], [], wait)[0]:
                    break
                if timeout and time.monotonic() - started > timeout:
                    raise ToolLimit("The operation exceeded its time limit of %g s and was stopped." % timeout)
                if memory and base is not None:
                    now = _resident(self.process.pid)
                    if now is not None and now - base > memory:
                        raise ToolLimit("The operation exceeded its memory limit of %d MB and was stopped." % (memory >> 20))
            if not self.process.stdout.readline():
                raise WorkerStopped("The design engine stopped unexpectedly.")
            with open(out, "rb") as fp:
                reply = json.loads(fp.read().decode("utf-8"))
        except (BrokenPipeError, OSError):
            raise WorkerStopped("The design engine stopped unexpectedly.") from None
        finally:
            for name in names:
                try:
                    os.unlink(name)
                except OSError:
                    pass
        if "error" in reply:
            raise ValueError(reply["error"])
        return reply["text"]


def safe_which(name):
    """Find an executable on PATH using absolute PATH entries only.

    Windows searches the current folder first, and the MCP server or the Git merge driver may be
    started inside a project repository, so a committed node.exe there must never be picked.
    """
    dirs = [d for d in os.environ.get("PATH", "").split(os.pathsep) if d and os.path.isabs(d)]
    old = os.environ.get("NoDefaultCurrentDirectoryInExePath")
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    try:
        found = shutil.which(name, path=os.pathsep.join(dirs)) if dirs else None
    finally:
        if old is None: os.environ.pop("NoDefaultCurrentDirectoryInExePath", None)
        else: os.environ["NoDefaultCurrentDirectoryInExePath"] = old
    return os.path.abspath(found) if found else None


class BoardRunner:
    def __init__(self, backend=None):
        lib = load_jsc() if backend != "node" else None
        self.lib = lib
        self.jsc = JavaScriptCore(lib, ()) if lib else None
        self.node = safe_which("node") if not self.jsc and backend != "jsc" else None
        # Board calls run in the jsc helper when it is available (JIT); scripts keep their sandbox.
        self.cli = jsc_cli_path() if backend in (None, "jsc-cli") else None
        self.cli_worker = None
        self.worker = None
        self.generation = 0  # Changes whenever a fresh worker discards the JavaScript state.
        self.comparison_loaded = False
        if not self.jsc and not self.node:
            raise ValueError("Board checks need system JavaScriptCore (included with macOS), JavaScriptCoreGTK, or Node.js 18+ in PATH.")

    @property
    def backend(self):
        return "jsc-cli" if self.cli else "jsc" if self.jsc else "node"

    def close(self):
        if self.jsc:
            self.jsc.close()
        self.stop_worker()
        self.stop_cli()

    def stop_cli(self, kill=False):
        if self.cli_worker is not None:
            (self.cli_worker.kill if kill else self.cli_worker.close)()
            self.cli_worker = None
            self.comparison_loaded = False

    def stop_worker(self):
        if self.worker is not None:
            try:
                self.worker.stdin.close()
            except OSError:
                pass
            try:
                self.worker.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.worker.kill()
                self.worker.wait()
            self.worker.stdout.close()
            self.worker = None
        self.comparison_loaded = False

    def alive(self):
        return self.jsc is not None or self.worker is not None and self.worker.poll() is None

    def has_comparison(self):
        return self.comparison_loaded and self.alive()

    # ------------------------------------------------------------ inspections
    def report(self, tool, document, library, project_rules=None):
        payload = {"tool":tool, "document":document, "library":library, "projectRules":project_rules}
        try:
            return self.run(payload)
        except WorkerStopped:
            return self.run(payload)

    def load_comparison(self, committed, saved):
        self.comparison_loaded = False
        encoding = json.detect_encoding(saved)
        if encoding != "utf-8":
            saved = saved.decode(encoding).encode("utf-8")
        elif not saved.isascii():
            saved.decode("utf-8")  # Reject malformed Unicode before either runtime consumes it.
        if b"\0" in saved or "\0" in committed:
            raise ValueError("Invalid project JSON.")
        committed_bytes = committed.encode("utf-8")
        if committed_bytes == saved:
            self.run({"tool":"load_git_comparison", "identical":True}, saved)
        else:
            self.run({"tool":"load_git_comparison"}, committed_bytes, saved)
        if self.jsc and len(saved) + len(committed) >= 2**20:
            self.jsc.collect()
        self.comparison_loaded = True

    def clear_comparison(self):
        if self.has_comparison():
            try:
                self.run({"tool":"clear_git_comparison"})
            except WorkerStopped:
                pass  # Termination also discards the heap.
        self.comparison_loaded = False

    def revision_page(self, options):
        return self.run({"tool":"compare_git_head", "options":options})

    def run(self, payload, *snapshots):
        text = self.call("AtriumBoardReport", ("board-runner",), payload, *snapshots,
                         retry=payload["tool"] != "compare_git_head", timeout=REPORT_TIMEOUT, memory=REPORT_MEMORY)
        return json.loads(text)

    # ------------------------------------------------------------ automation
    def headless(self, op, args=None, body=None, modules=(), timeout=None, memory=None):
        """Call AtriumHeadless. Returns (header, body or None)."""
        payload = {"op":op, "args":args or {}}
        parts = (body if isinstance(body, bytes) else body.encode("utf-8"),) if body is not None else ()
        if any(b"\0" in part for part in parts):
            raise ValueError("Invalid project JSON.")
        text = self.call("AtriumHeadless", ("headless", "core") + tuple(modules), payload, *parts, timeout=timeout, retry=True, memory=memory)
        head, raw = _split(text)
        if isinstance(head, dict) and (requested := head.pop("updateNumericFields", None)):
            deadline = time.monotonic() + (timeout or 60)
            while True:
                result, _ = self.headless("numeric_settlement", modules=requested, timeout=timeout, memory=memory)
                if result.get("error"):
                    raise ValueError(result["error"])
                if not result.get("pendingNumeric"):
                    break
                if time.monotonic() >= deadline:
                    self.headless("numeric_settlement", {"cancel": True}, timeout=timeout, memory=memory)
                    raise TimeoutError("Numeric field updates exceeded the operation time limit.")
                time.sleep(0.001)
        return head, raw

    def performance_control(self, action, outcome=None, *, projection="shareable"):
        if action == "start" and self.jsc and not self.cli:
            self.jsc.ensure(("headless",))
            self.jsc.install_diagnostics_clock()
        text = self.call("AtriumHeadlessDiagnostics", ("diagnostics",), {"action": action, "outcome": outcome, "projection": projection},
                         timeout=5, retry=True)
        return json.loads(text)

    def collect(self):
        if self.jsc:
            self.jsc.collect()

    def call(self, entry, modules, payload, *parts, timeout=None, retry=False, memory=None):
        if self.cli:
            return self.call_cli(entry, modules, payload, parts, timeout, memory)
        if self.jsc:
            self.jsc.ensure(modules)
            header = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
            try:
                return self.jsc.run((header, *parts), entry, timeout, memory)
            except ToolLimit:
                # A terminated call can leave half-built state: start over with a fresh context.
                self.jsc.close()
                self.jsc = JavaScriptCore(self.lib, ())
                self.generation += 1
                self.comparison_loaded = False
                raise
        files = [str(path) for name, path in resolve(modules) if name != "headless"]
        if self.worker is None or self.worker.poll() is not None:
            self.stop_worker()
            if not retry:
                raise WorkerStopped("The design inspection process stopped.")
            self.worker = subprocess.Popen([self.node, "--expose-gc", str(MODULES["headless"][0]), "--stdio"], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.generation += 1
        header = json.dumps(dict(payload, entry=entry, modules=files), ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        reply = self._exchange(self.worker, (header, *parts), timeout)
        return reply

    def call_cli(self, entry, modules, payload, parts, timeout, memory):
        # The same strings the in-process context receives: an ASCII JSON header, then UTF-8 parts.
        for part in parts:
            try:
                part.decode("utf-8")
            except UnicodeDecodeError:
                raise ValueError("Expected a UTF-8 project file.") from None
        files = [str(path) for name, path in resolve(modules)]
        header = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if self.cli_worker is None or not self.cli_worker.alive():
            if self.cli_worker is not None:
                self.stop_cli(kill=True)
            self.cli_worker = CliWorker(self.cli)
            self.generation += 1
        try:
            return self.cli_worker.call(files, entry, (header, *parts), timeout, memory)
        except (ToolLimit, WorkerStopped):
            # A stopped call can leave half-built state: the next call starts a fresh process.
            self.stop_cli(kill=True)
            raise

    @staticmethod
    def _read_node_reply(worker, timeout):
        if not timeout:
            return worker.stdout.readline()
        # Windows select() accepts sockets only. A blocking reader also lets the
        # deadline cover the whole line when the worker sends a partial response.
        from queue import Empty, SimpleQueue
        from threading import Thread

        reply = SimpleQueue()

        def read():
            try:
                reply.put(worker.stdout.readline())
            except Exception as error:
                reply.put(error)

        reader = Thread(target=read, daemon=True)
        reader.start()
        try:
            line = reply.get(timeout=timeout)
        except Empty:
            worker.kill()
            reader.join()
            raise ToolLimit("The operation exceeded its time limit of %g s and was stopped." % timeout) from None
        if isinstance(line, Exception):
            raise line
        return line

    def _exchange(self, worker, parts, timeout=None):
        # Frame raw file bytes separately. JSON files may contain newlines, and
        # quoting the entire project as a JSON string would duplicate its storage.
        header = _frame_header(parts)
        try:
            worker.stdin.write(header)
            for part in parts:
                worker.stdin.write(part)
            worker.stdin.flush()
            line = self._read_node_reply(worker, timeout)
            if not line:
                raise BrokenPipeError()
        except ToolLimit:
            if worker is self.worker:
                self.stop_worker()
            raise
        except OSError:
            if worker is self.worker:
                self.stop_worker()
            raise WorkerStopped("The design inspection process stopped.") from None
        reply = json.loads(line)
        if "error" in reply:
            raise ValueError(reply["error"])
        if "text" in reply:
            return reply["text"]
        return json.dumps(reply["result"])

    def sandbox(self, modules, header, project_text, timeout):
        """Run AtriumHeadlessScript in a short-lived child process and discard it afterwards.

        The child (this file with --script) builds a fresh JavaScriptCore context, arms the
        watchdog for every API call (asynchronous scripts settle in the microtask drain that
        follows each call) and watches its own memory. The parent kills it at a hard
        wall-clock deadline, so no script can hang, exhaust or crash the MCP server.
        """
        # Scripts only run where they are both isolated and stoppable. A JavaScriptCore build without the
        # execution watchdog could spin until the wall-clock kill, and node:vm is not a security boundary
        # (it can reach `process`), so both need an explicit opt-in.
        if self.jsc and not hasattr(self.lib, "JSContextGroupSetExecutionTimeLimit") and os.environ.get("ATRIUM_ALLOW_UNLIMITED_SCRIPTS") != "1":
            raise ValueError("Scripts are disabled: this JavaScriptCore has no execution time limit. "
                             "Set ATRIUM_ALLOW_UNLIMITED_SCRIPTS=1 to run them anyway.")
        if not self.jsc and os.environ.get("ATRIUM_ALLOW_NODE_SCRIPTS") != "1":
            raise ValueError("Scripts are disabled under Node, whose vm module is not a sandbox. Install "
                             "JavaScriptCore (macOS has it; on Linux, libjavascriptcoregtk), or set "
                             "ATRIUM_ALLOW_NODE_SCRIPTS=1 if you trust every project and script you run.")
        if self.jsc:
            request = json.dumps(dict(header, modules=list(modules), timeoutS=float(timeout)), ensure_ascii=True,
                                 separators=(",", ":")).encode("utf-8")
            command = [sys.executable, "-I", str(Path(__file__).resolve()), "--script"]
        else:
            files = [str(path) for name, path in resolve(modules) if name != "headless"]
            request = json.dumps(dict(header, modules=files, timeoutMs=int(timeout*1000)), ensure_ascii=True).encode("utf-8")
            command = [self.node, *_node_sandbox_flags(self.node), str(MODULES["headless"][0]), "--sandbox"]
        text = _run_child(command, (request, project_text), timeout)
        if self.jsc:
            return _split(text)
        reply = json.loads(text.partition("\n")[0])
        if "error" in reply:
            raise ValueError(reply["error"])
        return _split(reply["text"])

    def translate(self, direction, translator, options, body, timeout, memory, companion=None, output=None,
                  notebook_modules=(), imported=False, cancel_event=None):
        """Run the shared translator against data in a disposable JS worker."""
        entries = [entry for entry in translator_table() if entry[direction] and (translator is None or entry["id"] == translator)]
        if not entries:
            raise ValueError("Translator %r does not support %s. See list_translators." % (translator, direction))
        modules = translator_modules(entries, direction) + tuple(notebook_modules)
        if imported:
            modules += ("import-export",)
        if direction == "export" and translator in ("kicad", "altium") and options.get("pageMode") == "frames":
            modules += ("frame-conversion",)
        request = {"op": "translate", "args": {"direction": direction, "translator": translator, "options": options, "imported": imported}}
        return self._translate(request, modules, body, timeout, memory, companion, output, cancel_event)

    def translated_job(self, options, body, timeout, memory, output, notebook_modules=(), translator_ids=None):
        # An older plan without translator IDs still loads the full set of permitted exporters.
        selected = None if translator_ids is None else set(translator_ids)
        odb_needed = options.get("odbEnabled") is True and options.get("odbNeeded") is True
        entries = [entry for entry in translator_table() if entry["export"]
                   and (selected is None or entry["id"] in selected)
                   and (entry["id"] != "odb" or odb_needed)]
        modules = translator_modules(entries, "export") + ("output-jobs", "drc-waivers", "print") + tuple(notebook_modules)
        return self._translate({"op": "translated_job", "args": options}, modules, body, timeout, memory, None, output)

    def _translate(self, request, modules, body, timeout, memory, companion, output, cancel_event=None):
        request["streamOutput"] = output is not None
        if self.jsc:
            request.update(modules=modules, timeoutS=timeout, memory=memory)
            command = [sys.executable, "-I", str(Path(__file__).resolve()), "--translate"]
        else:
            request["modules"] = [str(path) for name, path in resolve(modules) if name != "headless"]
            command = [self.node, *_node_sandbox_flags(self.node, memory), str(MODULES["headless"][0]), "--translate"]
        head = json.dumps(request, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        parts = (head, body) if companion is None else (head, body, companion)
        response, data = _split(_run_child(command, parts, timeout, task="translation", output=output, cancel_event=cancel_event))
        if output is None:
            return response, data
        for file in response["files"]:
            length = output.read(4)
            if len(length) != 4:
                raise ValueError("The translation ended before returning complete files.")
            file["length"], = struct.unpack("<I", length)
            file["start"] = output.tell()
            output.seek(file["length"], os.SEEK_CUR)
        end = output.tell()
        if end != output.seek(0, os.SEEK_END):
            raise ValueError("The translation ended before returning complete files.")
        return response, None


SCRIPT_GRACE = 2.0           # Seconds past a script's limit before its process is killed.
SCRIPT_MEMORY = 1 << 30      # Peak resident bytes a script process may reach.


def _frame_header(parts=None, *, stream=None):
    """Pack or unpack the little-endian three-slot stdio header. Lengths are byte counts."""
    if stream is not None:
        return struct.unpack("<3I", stream.read(12))
    lengths = [len(part) for part in parts]
    if any(length > 0xffffffff for length in lengths):
        raise ValueError("This project exceeds the JavaScript runtime input size.")
    return struct.pack("<3I", *(lengths + [0]*(3-len(lengths))))


def _frames(parts):
    return _frame_header(parts) + b"".join(parts)


class TranslationCancelled(ValueError):
    code = "cancelled"


def _run_child(command, parts, timeout, task="script", output=None, cancel_event=None):
    """Run with a hard deadline. Return stdout text, or just its header if files are spooled."""
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE if output is None else output, stderr=subprocess.DEVNULL,
                               start_new_session=True)
    finished = None
    if cancel_event is not None:
        from threading import Event, Thread
        finished = Event()
        def monitor():
            while not finished.wait(0.05):
                if cancel_event.is_set():
                    process.kill()
                    return
        Thread(target=monitor, daemon=True).start()
    try:
        out, _ = process.communicate(_frames(parts), timeout=timeout + SCRIPT_GRACE)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise ValueError("The %s exceeded its time limit of %g s and its process was stopped." % (task, timeout)) from None
    except BaseException:
        process.kill()
        process.communicate()
        raise
    finally:
        if finished is not None:
            finished.set()
    if cancel_event is not None and cancel_event.is_set():
        raise TranslationCancelled("Import cancelled before the destination was published.")
    if output is not None:
        output.seek(0)
        out = output.readline()
    if not out:
        raise ValueError("The %s process stopped unexpectedly (exit status %s)." % (task, process.returncode))
    text = out.decode("utf-8", "surrogatepass")
    head = json.loads(text.partition("\n")[0])
    if set(head) == {"error"}:
        raise ValueError(head["error"])
    if task == "translation" and process.returncode:
        raise ValueError("The translation process stopped before returning complete results.")
    return text


@lru_cache(maxsize=8)
def _node_sandbox_flags(node, memory=SCRIPT_MEMORY):
    """Node's permission model: no child processes, workers, native addons or writes; reads only the app."""
    flags = ["--max-old-space-size=%d" % (memory >> 20)]
    try:
        major = int(subprocess.run([node, "-p", "process.versions.node"], capture_output=True, text=True, timeout=10).stdout.split(".")[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return flags
    if major >= 20:
        flags += ["--permission" if major >= 22 else "--experimental-permission", "--allow-fs-read=" + str(APP), "--allow-fs-read=" + str(HERE)]
    return flags


def _memory_guard(limit, task="script"):
    """Stop this process once its peak resident memory passes `limit` bytes."""
    import resource
    import threading
    scale = 1 if sys.platform == "darwin" else 1024
    error = "The %s used more than %d MB of memory and was stopped." % (task, limit >> 20)
    result = {"log": [], "error": error, "result": None} if task == "script" else {"error": error}
    message = json.dumps(result).encode("ascii") + b"\n"

    def watch():
        while True:
            time.sleep(0.05)
            if resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale > limit:
                os.write(1, message)
                os._exit(3)
    threading.Thread(target=watch, daemon=True).start()


def _script_child():
    """`board_runner.py --script`: run one headless script under JavaScriptCore and print the result."""
    _memory_guard(SCRIPT_MEMORY)
    stream = sys.stdin.buffer
    lengths = _frame_header(stream=stream)
    parts = [stream.read(length) for length in lengths if length]
    request = json.loads(parts[0])
    modules, timeout = tuple(request.pop("modules")), float(request.pop("timeoutS"))
    payload = json.dumps(request, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    deadline = time.monotonic() + timeout
    try:
        lib = load_jsc()
        if lib is None:
            raise ValueError("JavaScriptCore is unavailable.")
        context = JavaScriptCore(lib, ("headless",) + modules)
        try:
            context.function("AtriumHeadlessScript")
            context.function("AtriumHeadlessScriptTake")
            if context.timer:
                context.arm(timeout)
            head, body = _split(context.run((payload, parts[1]), "AtriumHeadlessScript"))
            for _ in range(1000):
                if "pending" not in head or time.monotonic() >= deadline:
                    break
                head, body = _split(context.run((str(head["pending"]).encode(),), "AtriumHeadlessScriptTake"))
        finally:
            context.close()
        if "pending" in head:
            head, body = {"log": [], "error": "The script did not finish within its time limit. Headless scripts cannot wait on timers.", "result": None}, None
    except ValueError as error:
        head, body = ({"log": [], "error": str(error), "result": None} if "time limit" in str(error) else {"error": str(error)}), None
    out = json.dumps(head, ensure_ascii=True).encode("ascii") + (b"\n" + body.encode("utf-8", "surrogatepass") if body is not None else b"")
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()


def _translate_child():
    stream = sys.stdin.buffer
    header_size, body_size, companion_size = _frame_header(stream=stream)
    request = json.loads(stream.read(header_size))
    modules, timeout, memory = tuple(request.pop("modules")), request.pop("timeoutS"), request.pop("memory")
    _memory_guard(memory, task="translation")
    success = False
    try:
        lib = load_jsc()
        if lib is None:
            raise ValueError("JavaScriptCore is unavailable.")
        context = JavaScriptCore(lib, modules)
        try:
            header = json.dumps(request, ensure_ascii=True, separators=(",", ":")).encode("ascii")
            parts = (header, stream.read(body_size))
            if companion_size:
                parts += (stream.read(companion_size),)
            out = context.run(parts, "AtriumHeadless", timeout=timeout)
            if request["streamOutput"]:
                result = json.loads(out)
                stream_out = sys.stdout.buffer
                stream_out.write(out.encode("utf-8") + b"\n")
                del parts, out
                for index, file in enumerate(result["files"]):
                    query = json.dumps({"op": "translated_file", "args": {"index": index}}).encode("ascii")
                    _, data = _split(context.run((query,), "AtriumHeadless", timeout=timeout))
                    raw = data.encode("latin-1" if file["binary"] else "utf-8")
                    stream_out.write(struct.pack("<I", len(raw)))
                    stream_out.write(raw)
                    del data, raw
                return
            success = True
        finally:
            context.close()
    except ToolLimit:
        out = json.dumps({"error": "The translation exceeded its time limit of %g s and was stopped." % timeout})
    except ValueError as error:
        out = json.dumps({"error": str(error)})
    sys.stdout.buffer.write(out.encode("utf-8", "surrogatepass"))
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    if sys.argv[1:] == ["--script"]:
        _script_child()
    elif sys.argv[1:] == ["--translate"]:
        _translate_child()
