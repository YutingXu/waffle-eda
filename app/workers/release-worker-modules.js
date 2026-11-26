"use strict";

if (!globalThis.AtriumDesignQueryWorkerModules && typeof require === "function") require("./design-query-worker-modules.js");

// The Release client and its file-script worker use this same ordered allowlist.
// Fab Profiles snapshots the sourced profiles during module evaluation.
globalThis.AtriumReleaseWorkerModules = Object.freeze((/** @type {[string, string][]} */ ([
  ["AtriumUUID", "../core/uuid-v7.js"], ["Atrium", "../core/model.js"], ["AtriumSpatial", "../core/spatial.js"], ["AtriumParts", "../library/parts.js"],
  ["AtriumAltiumRecords", "../formats/altium-records.js"], ["AtriumAltiumRules", "../checks/altium-rules.js"], ["AtriumComponentClasses", "../pcb/component-classes.js"],
  ...globalThis.AtriumDesignQueryWorkerModules,
  ["AtriumGeometry", "../core/geometry.js"], ["AtriumStackup", "../pcb/stackup.js"], ["AtriumViaStack", "../pcb/viastack.js"], ["AtriumGeometryCurves", "../pcb/resolved-geometry-curves.js"], ["AtriumPCBPours", "../pcb/pcb-pours.js"], ["AtriumPolygonPour", "../pcb/polygon-pour.js"],
  ["AtriumNetIntent", "../checks/net-intent.js"], ["AtriumRules", "../checks/rules.js"], ["AtriumProjectRules", "../checks/project-rules.js"],
  ["AtriumRooms", "../pcb/rooms.js"], ["AtriumDFA", "../checks/dfa.js"],
  ["AtriumDRCPours", "../checks/drc-pours.js"], ["AtriumSignals", "../core/signals.js"], ["AtriumConnectivity", "../checks/connectivity.js"],
  ["AtriumPCBAppearance", "../pcb/pcb-appearance.js"], ["AtriumLandContours", "../pcb/land-contours.js"], ["AtriumStrokeFont", "../canvas/stroke-font.js"], ["AtriumPCBText", "../pcb/pcb-text.js"], ["AtriumVectorize", "../canvas/vectorize.js"],
  ["AtriumPCBTextRich", "../pcb/pcb-text-rich.js"], ["AtriumPCBDraw", "../pcb/pcb-draw.js"],
  ["AtriumBoardShape", "../pcb/board-shape-core.js"], ["AtriumBoardShapeAuthoring", "../pcb/board-shape.js"],
  ["AtriumRigidFlex", "../pcb/rigid-flex.js"], ["AtriumFlexFold", "../canvas/flex-fold.js"],
  ["AtriumHDI", "../pcb/hdi.js"], ["AtriumSchObjects", "../schematic/sch-objects.js"], ["AtriumHierarchy", "../project/hierarchy.js"],
  ["AtriumMultichannel", "../schematic/multichannel.js"], ["AtriumVariants", "../project/variants.js"], ["AtriumDesignators", "../pcb/designator-place.js"],
  ["AtriumZip", "../core/zip.js"], ["AtriumFabPresets", "../formats/fab-presets.js"], ["AtriumFabPresetsJLCPCB", "../fab-presets/jlcpcb.js"],
  ["AtriumFabProfiles", "../formats/fab-profiles.js"], ["AtriumMaskOpenings", "../pcb/mask-openings.js"],
  ["AtriumGeometryMaterial", "../pcb/geometry-material.js"], ["AtriumResolvedGeometry", "../pcb/resolved-geometry.js"],
  ["AtriumFabOutputs", "../formats/fab-outputs.js"], ["AtriumBOM", "../formats/bom.js"],
  ["AtriumSTEPImport", "../formats/step-import.js"], ["Atrium3D", "../canvas/view3d.js"], ["AtriumSTEP", "../formats/step-export.js"],
  ["AtriumSchAppearance", "../schematic/sch-appearance.js"], ["AtriumSchematicOutput", "../formats/schematic-output.js"],
  ["AtriumKiCad", "../formats/kicad-export.js"], ["AtriumKiCadSchematic", "../formats/kicad-schematic.js"], ["AtriumXML", "../formats/mcad-xml.js"], ["AtriumIPC2581", "../formats/ipc2581.js"],
  ["AtriumPanel", "../pcb/panel.js"], ["AtriumSHA256", "../core/sha256.js"], ["AtriumOutputJobs", "../formats/output-jobs.js"]
])).map(entry => Object.freeze(entry)));
