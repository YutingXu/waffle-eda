"use strict";
// Prepare one actual project export. The reviewed files are also the files committed by Save.
// First-save state and destination grants stay outside the design and its import provenance.
globalThis.AtriumImportExport = (() => {
  const G = globalThis, running = new WeakMap();
  const load = name => G[name] || G.AtriumLazy.need(name);
  // Command-line renderers use the same source messages without loading the editor language UI.
  const AtriumI18n = G.AtriumI18n || {define:table => (id,args) => table[id].replace(/\{(\w+)\}/g,(token,key)=>args?.[key] ?? token)};
  const t = AtriumI18n.define({
    "import_export.noWriter": "There is no installed project writer for this source format.",
    "import_export.sourceMissing": "Re-select the imported source files before exporting this design.",
    "import_export.rememberChanged": "The export preference changed in another tab.",
    "import_export.rememberFailed": "The export preference could not be saved.",
    "import_export.preferenceReason": "The export preference could not be saved. {reason}",
    "import_export.targetIssue": "The selected export destination is unavailable. {reason}",
    "import_export.noOutput": "The project writer produced no verifiable output.",
    "import_export.destinationUnavailable": "A distinct export destination is unavailable.",
    "import_export.designChanged": "The design changed before the export was confirmed. Save again to review the current design.",
    "import_export.unconfirmed": "The selected destination did not confirm the export.",
    "import_export.failed": "The export could not be completed. {reason}",
    "import_export.filename": "{name} export",
    "import_export.exportSuffix": "{name}-export{extension}",
    "import_export.design": "Design",
    "import_export.altiumAscii": "Altium Designer (ASCII)",
    "import_export.originalEagle": "Original EAGLE {record}",
    "import_export.reportKind": "{kind}",
    "import_export.missingDefinition": "The exported project does not include this Waffle definition.",
    "import_export.targetType": "Choose a separate export file.",
    "import_export.sourcePicked": "Choose a separate file. This is an imported source.",
    "import_export.newFile": "Choose a new file with a different name so the imported originals stay read-only.",
    "import_export.browserUnwritable": "The browser can no longer write the remembered file.",
    "import_export.beforeDownload": "The design changed before the download.",
    "import_export.unauthorized": "The export destination is no longer authorized.",
    "import_export.beforeExport": "The design changed before the export.",
    "import_export.targetChanged": "The chosen export file changed or its permission expired. Choose a new destination.",
    "import_export.duringExport": "The design or destination changed during export.",
    "import_export.verifyFailed": "The destination could not verify the written export.",
    "import_feature.part": "Component",
    "import_feature.track": "Track",
    "import_feature.via": "Via",
    "import_feature.pad": "Pad",
    "import_feature.polygon": "Copper polygon",
    "import_feature.wire": "Wire",
    "import_feature.junction": "Junction",
    "import_feature.netlabel": "Net label",
    "import_feature.sheetsymbol": "Sheet symbol",
    "import_feature.sheetentry": "Sheet entry",
    "import_feature.offsheet": "Off-sheet connector",
    "import_feature.textframe": "Text frame",
    "import_feature.graphic": "Graphic",
    "import_feature.label": "Label",
    "import_feature.frame": "Named frame",
    "import_feature.math": "Equation",
    "import_feature.richtext": "Rich text",
    "import_feature.calculation": "Calculation",
    "import_feature.widget": "Sheet widget",
    "import_feature.imageMarkup": "Image annotation",
    "import_feature.notesLayer": "Notes layer",
    "import_feature.sticky": "Sticky note",
    "import_feature.callout": "Callout",
    "import_feature.reviewItem": "Review item",
    "import_feature.inkStroke": "Ink stroke",
    "import_feature.image": "Image",
    "import_feature.bus": "Bus",
    "import_feature.busentry": "Bus entry",
    "import_feature.noerc": "No ERC marker",
    "import_feature.port": "Port",
    "import_feature.power": "Power symbol",
    "import_feature.text": "Text",
    "import_feature.line": "Line",
    "import_feature.polyline": "Polyline",
    "import_feature.rectangle": "Rectangle",
    "import_feature.ellipse": "Ellipse",
    "import_feature.arc": "Arc",
    "import_feature.dimension": "Dimension",
    "import_feature.keepout": "Keepout",
    "import_feature.region": "Region",
    "import_feature.hole": "Hole",
    "import_feature.boardCutout": "Board cutout",
    "import_feature.boardOutline": "Board outline",
    "import_feature.pcbDocument": "PCB document",
    "import_feature.schematicDocument": "Schematic document",
    "import_feature.schematicPage": "Schematic page",
    "import_feature.footprintGraphic": "Footprint graphic",
    "import_feature.footprintPad": "Footprint pad",
    "import_feature.symbolGraphic": "Symbol graphic",
    "import_feature.symbolPin": "Symbol pin",
    "import_feature.designRule": "Design rule",
    "import_feature.sourceDesignRule": "Source design rule",
    "import_feature.netRuleOverride": "Net rule override",
    "import_feature.netTie": "Net tie",
    "import_feature.stepBody": "STEP body",
    "import_feature.stepSidecar": "STEP sidecar",
    "import_feature.3dBody": "3D body",
    "import_feature.filledCopperRegion": "Filled copper region",
    "import_feature.schematicPackageAssociation": "Schematic package association",
    "import_feature.padNetAssignment": "Pad net assignment",
    "import_feature.offSheetConnectorDirection": "Off-sheet connector direction",
    "import_feature.assemblyVariant": "Assembly variant",
    "import_feature.outputJob": "Output job",
    "import_feature.bomView": "BOM view",
    "import_feature.reusableLayoutBlock": "Reusable layout block",
    "import_feature.reviewThread": "Review thread",
    "import_feature.reviewReply": "Review reply",
    "import_feature.ruleCompanion": "Rule companion",
    "import_feature.layer": "Layer",
    "import_feature.footprintArtwork": "Footprint artwork",
    "import_feature.symbolArtwork": "Symbol artwork",
    "import_feature.textDelimiter": "Text delimiter",
    "import_feature.symbolMirror": "Symbol mirror",
    "import_feature.padShape": "Pad shape",
    "import_feature.padOutline": "Pad outline",
    "import_feature.blindVia": "Blind or buried via span",
    "import_feature.regionCutout": "Internal region cutout",
    "import_feature.powerPlane": "Power plane settings",
    "import_feature.easyedaEdition": "EasyEDA document edition",
    "import_feature.physicalLayerStack": "Physical layer stack",
    "import_feature.schematicPageSetup": "Schematic page setup",
    "import_feature.wireNetName": "Wire net name",
    "import_feature.netBoardRules": "Net-specific board rules",
    "import_feature.boardDesignRules": "Board design rules",
    "import_feature.originalDocumentSetting": "Original document setting",
    "import_export.disabledRule": "Disabled rules are omitted from the KiCad design.",
    "import_feature.maskOrPaste": "Mask or paste expansion",
    "import_feature.clearance": "Clearance",
    "import_feature.trackWidth": "Track width",
    "import_feature.viaSize": "Via size",
    "import_feature.boardRule": "Board rule {rule}",
    "import_feature.originalRecord": "Original {record}",
    "import_feature.symbolRecord": "Symbol {record}",
    "import_feature.documentRecord": "Document {record}",
    "import_feature.footprint": "Footprint"
  });
  const featureKeys = {
    "part":"import_feature.part", "track":"import_feature.track", "via":"import_feature.via",
    "pad":"import_feature.pad", "polygon":"import_feature.polygon", "wire":"import_feature.wire",
    "junction":"import_feature.junction", "netlabel":"import_feature.netlabel", "sheetsymbol":"import_feature.sheetsymbol",
    "sheetentry":"import_feature.sheetentry", "offsheet":"import_feature.offsheet", "textframe":"import_feature.textframe",
    "graphic":"import_feature.graphic", "label":"import_feature.label", "frame":"import_feature.frame",
    "math":"import_feature.math", "richtext":"import_feature.richtext", "calculation":"import_feature.calculation",
    "widget":"import_feature.widget", "imagemarkup":"import_feature.imageMarkup", "noteslayer":"import_feature.notesLayer",
    "sticky":"import_feature.sticky", "callout":"import_feature.callout", "reviewitem":"import_feature.reviewItem",
    "inkstroke":"import_feature.inkStroke", "image":"import_feature.image", "bus":"import_feature.bus",
    "busentry":"import_feature.busentry", "noerc":"import_feature.noerc", "port":"import_feature.port",
    "power":"import_feature.power", "text":"import_feature.text", "line":"import_feature.line",
    "polyline":"import_feature.polyline", "rectangle":"import_feature.rectangle", "ellipse":"import_feature.ellipse",
    "arc":"import_feature.arc", "dimension":"import_feature.dimension", "keepout":"import_feature.keepout",
    "region":"import_feature.region", "hole":"import_feature.hole", "boardcutout":"import_feature.boardCutout",
    "boardoutline":"import_feature.boardOutline", "pcbdocument":"import_feature.pcbDocument", "schematicdocument":"import_feature.schematicDocument",
    "schematicpage":"import_feature.schematicPage", "footprintgraphic":"import_feature.footprintGraphic", "footprintpad":"import_feature.footprintPad",
    "symbolgraphic":"import_feature.symbolGraphic", "symbolpin":"import_feature.symbolPin", "designrule":"import_feature.designRule",
    "sourcedesignrule":"import_feature.sourceDesignRule", "netruleoverride":"import_feature.netRuleOverride", "nettie":"import_feature.netTie",
    "stepbody":"import_feature.stepBody", "stepsidecar":"import_feature.stepSidecar", "3dbody":"import_feature.3dBody",
    "filledcopperregion":"import_feature.filledCopperRegion", "schematicpackageassociation":"import_feature.schematicPackageAssociation", "padnetassignment":"import_feature.padNetAssignment",
    "offsheetconnectordirection":"import_feature.offSheetConnectorDirection", "assemblyvariant":"import_feature.assemblyVariant", "outputjob":"import_feature.outputJob",
    "bomview":"import_feature.bomView", "reusablelayoutblock":"import_feature.reusableLayoutBlock", "reviewthread":"import_feature.reviewThread",
    "reviewreply":"import_feature.reviewReply", "rulecompanion":"import_feature.ruleCompanion", "layer":"import_feature.layer",
    "footprint":"import_feature.footprint", "component":"import_feature.part", "copperpolygon":"import_feature.polygon",
    "footprintartwork":"import_feature.footprintArtwork", "symbolartwork":"import_feature.symbolArtwork", "textdelimiter":"import_feature.textDelimiter",
    "symbolmirror":"import_feature.symbolMirror", "padshape":"import_feature.padShape", "padoutline":"import_feature.padOutline",
    "blindorburiedviaspan":"import_feature.blindVia", "internalregioncutout":"import_feature.regionCutout", "powerplanesettings":"import_feature.powerPlane",
    "easyedadocumentedition":"import_feature.easyedaEdition", "physicallayerstack":"import_feature.physicalLayerStack", "schematicpagesetup":"import_feature.schematicPageSetup",
    "wirenetname":"import_feature.wireNetName", "netspecificboardrules":"import_feature.netBoardRules", "boarddesignrules":"import_feature.boardDesignRules",
    "originaldocumentsetting":"import_feature.originalDocumentSetting",
    "maskorpasteexpansion":"import_feature.maskOrPaste", "namedframe":"import_feature.frame", "offsheetconnector":"import_feature.offsheet", "equation":"import_feature.math"
  };
  function featureName(kind) {
    const key = featureKeys[kind.toLowerCase().replace(/[^a-z0-9]/g,"")];
    if (key) return t(key);
    if (kind.startsWith("Original EAGLE ")) return t("import_export.originalEagle",{record:kind.slice(15)});
    if (kind.startsWith("Board rule ")) {
      const id = kind.slice(11), title = G.AtriumRules?.types[id]?.title || id;
      const known = {clearance:"import_feature.clearance",width:"import_feature.trackWidth",viaStyle:"import_feature.viaSize"}[id];
      return t("import_feature.boardRule",{rule:known ? t(known) : G.AtriumI18n?.text?.(title,"rules") || title});
    }
    for (const [prefix,key] of [["Original ","import_feature.originalRecord"],["Symbol ","import_feature.symbolRecord"],["Document ","import_feature.documentRecord"]])
      if (kind.startsWith(prefix)) return t(key,{record:kind.slice(prefix.length)});
    return t("import_export.reportKind",{kind:G.AtriumI18n?.text?.(kind,"translator") || kind});
  }
  function descriptor(id) {
    const row = G.AtriumTranslatorRegistry?.get(id);
    return row?.group === "design" && row.import && row.export ? row : null;
  }
  function formatName(id, edition) {
    if (id === "altium") return t("import_export.altiumAscii");
    if (id === "easyeda" && edition) return edition === "pro" ? "EasyEDA Pro" : "EasyEDA Standard";
    return descriptor(id)?.label || id;
  }
  function snapshot(project) {
    const documents = project.documents.filter(d => !G.Atrium.pristineImportPlaceholder(d));
    return documents.length === project.documents.length ? project : {...project,documents};
  }
  function reasonText(raw) {
    if (raw === "Disabled rules are omitted from the KiCad design.") return t("import_export.disabledRule");
    if (raw === "The exported project does not include this Waffle definition.") return t("import_export.missingDefinition");
    return G.AtriumI18n?.text?.(raw,"translator") || raw;
  }
  function summary(report) {
    const result = {kept:[],converted:[],lost:[]};
    for (const row of report.kinds) {
      const refs = row.references || [];
      // A source wire can produce many target segments. Their output inventory is already
      // in the full report; the Save sheet counts the features the user can actually edit.
      if (refs.length && refs.every(r => r.reason === "Records written from this document.")) continue;
      const label = featureName(row.kind);
      for (const [status, category] of [["kept","kept"],["approximated","converted"],["dropped","lost"]]) {
        if (!row[status]) continue;
        const reasons = new Map();
        if (status !== "kept") for (const ref of refs) {
          if (ref.status === status && ref.reason)
            reasons.set(ref.reason,(reasons.get(ref.reason) || 0) + (ref.count ?? 1));
        }
        const details = [...reasons].sort((a,b) => b[1] - a[1]).map(([reason,count]) => {
          const detail = reasonText(reason);
          if (count === row[status]) return detail;
          return "×" + (G.AtriumI18n?.number?.(count) ?? String(count)) + " " + detail;
        });
        result[category].push({label,count:row[status],...(details.length ? {detail:details.slice(0,2).join(" · ")} : {}),
          ...(details.length > 2 ? {additionalDetails:details.slice(2)} : {})});
      }
    }
    return result;
  }
  function nameOf(project, result) {
    if (result.files.length === 1) return result.files[0].name.split("/").at(-1);
    const stem = String(result.details?.archivePrefix || project.name || t("import_export.design")).replace(/[\\/:*?"<>|\x00-\x1f]/g,"-").trim();
    return t("import_export.filename",{name:stem && stem !== "." && stem !== ".." ? stem : t("import_export.design")});
  }
  async function prepare({format,project,provenance,edition,signal,translate}) {
    if (!descriptor(format)) throw Error(t("import_export.noWriter"));
    signal?.throwIfAborted();
    const writer = translate || (await load("AtriumTranslatorClient")).export;
    const options = {scope:"project",usedFeatures:true,provenance,signal,...(edition ? {edition} : {})};
    const result = await writer(format,snapshot(project),options);
    signal?.throwIfAborted();
    if (result?.report?.direction !== "export" || result.report.translator !== format || !Array.isArray(result.report.kinds) || !result.files?.length)
      throw Error(t("import_export.noOutput"));
    return {...result,format,formatLabel:formatName(format,result.details?.edition || edition),name:nameOf(project,result),summary:summary(result.report)};
  }
  function source(session) {
    const entry = session?.entry, id = entry?.report?.translator;
    if (!session?.sourceKey || !session.sourceFile || !id || id !== session.translator || entry.report.direction !== "import") return null;
    return {id,file:session.sourceFile};
  }
  function sourceEdition(session) {
    if (session.edition || session.translator!=="easyeda") return session.edition;
    const file = session.sourceFile, p = session.entry.provenance;
    const name = G.AtriumTranslatorClient?.pathOf?.(file) || file.path || file.name;
    const inputs = p?.files || [];
    let matches = inputs.filter(f=>(f.path || f.name)===(file.path || name));
    if (!matches.length) matches = inputs.filter(f=>f.name===file.name);
    if (matches.length!==1) return;
    const owners = new Set(matches[0].documents);
    const modes = new Set((p.fields || []).filter(r=>r.type==="document" && owners.has(r.id))
      .map(r=>r.values?.sourceEncoding).filter(e=>e==="easyeda-standard" || e==="easyeda-pro"));
    if (modes.size===1) return [...modes][0].slice(8);
  }
  async function targetService() {
    const host = G.AtriumHost;
    if (host?.writeImportExport) return host;
    if (host?.platform) return null;
    return await load("AtriumBrowserImportExport");
  }
  function targetRequest(session) {
    return {file:session.sourceFile,sources:session.sourceFiles || [session.sourceFile],sourceKey:session.sourceKey};
  }
  async function recall(session) {
    if (!source(session) || session.current?.() === false) return null;
    const service = await targetService();
    try { return await service?.recalledImportExport?.(targetRequest(session)) || null; }
    catch (error) {
      if (["NotAllowedError","NotFoundError"].includes(error.name) || error.code === "stale_destination") return null;
      throw Error(t("import_export.targetIssue",{reason:error.message}));
    }
  }
  async function forget(session) {
    if (!source(session)) return false;
    const service = await targetService();
    return !!await service?.forgetImportExport?.(targetRequest(session));
  }
  const bytes = f => f.bytes || new TextEncoder().encode(f.text);
  async function run({session,project,choice,signal,isCurrent,anchor}) {
    const imported = source(session);
    if (!imported) return {status:"unavailable",reason:t("import_export.sourceMissing")};
    if (!descriptor(imported.id)) return {status:"unavailable",reason:t("import_export.noWriter")};
    const current = () => !signal?.aborted && session.current?.() !== false && isCurrent?.() !== false;
    const revision = session.revision?.(), reviewed = () => current() && revision === session.revision?.();
    const stale = () => signal?.aborted ? {status:"cancelled"} : {status:"stale",reason:t("import_export.designChanged")};
    if (!current()) return stale();
    const service = await targetService();
    if (!service) return {status:"unavailable",reason:t("import_export.destinationUnavailable")};
    const request = targetRequest(session), remembered = choice === "export" ? null : await recall(session);
    if (!current()) return stale();
    if (choice !== "export" && !remembered) return {status:"unconfigured"};
    const groups = G.AtriumImportReports?.provenance?.() ?? session.entry.provenance;
    const plan = await prepare({project,format:imported.id,edition:sourceEdition(session),provenance:groups,signal});
    if (!reviewed()) return stale();
    let remember = false;
    if (!remembered) {
      const view = await load("AtriumImportSaveView");
      const answer = await view.report({name:project.name || session.name,formatLabel:plan.formatLabel,...plan.summary,
        allowRemember:typeof service.rememberImportExport === "function" && service.canRemember?.(request) !== false,
        rememberScope:service.rememberScope?.(request),signal,anchor});
      if (!answer?.proceed) return {status:"cancelled"};
      remember = answer.remember === true;
    }
    if (!reviewed()) return stale();
    const payload = plan.files.length === 1 ? {bytes:bytes(plan.files[0])} : {files:plan.files.map(f=>({name:f.name,bytes:bytes(f)}))};
    // The desktop bridge owns the system sheet and consumes the signal locally.
    // The browser writer additionally rechecks the editor revision before commit.
    const input = {...request,name:plan.name,...payload,signal,...(remembered ? {destination:remembered.destination} : {})};
    const receipt = await service.writeImportExport(input,{current:reviewed,signal});
    if (!receipt) return {status:"cancelled"};
    if (receipt.downloaded) return {status:"downloaded",name:receipt.name,remembered:false,revision};
    if (!receipt.destination || !receipt.name) throw Error(t("import_export.unconfirmed"));
    if (!current()) return {...stale(),committed:true};
    let savedPreference = !!remembered && !receipt.preferenceError;
    let preferenceError = receipt.preferenceError && t("import_export.preferenceReason",{reason:receipt.preferenceError});
    try {
      if (remember && service.rememberImportExport) {
        savedPreference = !!await service.rememberImportExport({...request,destination:receipt.destination});
        if (!savedPreference) preferenceError = t("import_export.rememberFailed");
      }
      else if (choice === "export") await service.forgetImportExport?.(request);
    } catch (error) { preferenceError = t("import_export.preferenceReason",{reason:error.message}); }
    return {status:"exported",revision,destination:receipt.destination,name:receipt.name,remembered:savedPreference,...(preferenceError ? {preferenceError} : {})};
  }
  async function exportImported(input) {
    const session = input?.session;
    if (!session) return {status:"unavailable",reason:t("import_export.destinationUnavailable")};
    if (running.has(session)) return running.get(session);
    const task = run(input).catch(error => {
      if (error?.name === "AbortError") return {status:"cancelled"};
      if (error?.name === "NotAllowedError" || error?.code === "stale_destination")
        return {status:"stale",reason:t("import_export.targetIssue",{reason:error.message})};
      throw Error(t("import_export.failed",{reason:error.message || String(error)}));
    });
    running.set(session,task);
    try { return await task; } finally { if (running.get(session) === task) running.delete(session); }
  }
  return Object.freeze({message:t,prepare,summary,snapshot,descriptor,formatName,recall,forget,exportImported});
})();
globalThis.AtriumLazy?.register?.("AtriumBrowserImportExport",{scripts:["formats/import-export-browser.js"],deps:["AtriumZip"]});
