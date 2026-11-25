"use strict";

// Board and project workflow dialogs resolve their tools only after a menu or keyboard command requests them.
globalThis.AtriumEditorWorkflows = (() => {
  // The module each workflow action opens (workflow() below).
  const WORKFLOW_NEEDS={compare:"AtriumRevisionReview",connectivity:"AtriumDesignReview",export:"AtriumDesignReview",symbols:"AtriumSymbols",blocks:"AtriumBlocks",
    eco:"AtriumECO","eco-reverse":"AtriumECO",rules:"AtriumRules",bom:"AtriumBOM",annotate:"AtriumAnnotate","fab-outputs":"AtriumFabOutputs",fab:"AtriumFabOutputs",
    print:"AtriumPrint","export-pdf":"AtriumPrint","output-jobs":"AtriumOutputJobs",step:"AtriumSTEP",logo:"AtriumLogo",stackup:"AtriumStackup",viaStack:"AtriumViaStack",
    viaTemplates:"AtriumViaStack",fabProfiles:"AtriumFabProfiles","rule-sets":"AtriumRuleSets","via-stubs":"AtriumViaStubs",compile:"AtriumERC",erc:"AtriumERC",
    messages:"AtriumMessages",length:"AtriumLength",mcp:"AtriumAI",autoroute:"AtriumAutorouter","autoroute-all":"AtriumAutorouter","autoroute-net":"AtriumAutorouter",
    "autoroute-connection":"AtriumAutorouter","autoroute-component":"AtriumAutorouter","autoroute-area":"AtriumAutorouter",fanout:"AtriumAutorouter",
    "library-panel":"AtriumLibrary","library-place":"AtriumLibrary","library-sources":"AtriumLibrary","footprint-wizard":"AtriumLibrary","footprint-editor":"AtriumLibrary","symbol-editor":"AtriumLibrary",
    "edit-footprint":"AtriumLibrary","edit-symbol":"AtriumLibrary","component-new":"AtriumLibrary","symbol-wizard":"AtriumSymbolWizard"};
  const boardShapeTabs={"board-shape":"define","board-dimensions":"dims","board-wizard":"wizard","import-dxf":"import","export-dxf":"export"};
  const boardActions=new Set(["step","blocks","connectivity","stackup","logo","viaStack","viaTemplates","fabProfiles","rule-sets","via-stubs","length","autoroute","autoroute-all","autoroute-net","autoroute-connection","autoroute-component","autoroute-area","fanout"]);
  async function checkDRC(ctx) {
    const host = globalThis.AtriumNavHost, d = ctx?.doc, project = ctx?.project;
    const current = () => !host || globalThis.AtriumNavHost === host && host.doc() === d && host.project() === project;
    const L = globalThis.AtriumLazy, M = () => globalThis.AtriumMessages;
    const status = text => {
      if (!current()) return;
      ctx?.info?.(text);
      M()?.show(host?.messageContext() || ctx, {title:"Design Rule Check", group:"DRC", detail:true, status:text,
        rerun:host && (() => host.act("drc"))});
    };
    if (!host) {
      try {if (!M()) await L?.need("AtriumMessages");} catch { /* status can still use the caller */ }
      status("Open a board in the editor to run Design Rule Check.");
      return null;
    }
    ctx.info?.("Checking…");
    try {
      if (!M()) await L?.need("AtriumMessages");
      if (!current()) return null;
      const names = L?.forAction("drc", d?.kind)?.filter(n => n !== "AtriumDRCMarkers");
      if (names && !L.has(names)) {
        status("Checking…");
        await L.need(names);
      }
      if (!current()) return null;
      if (!globalThis.AtriumDRCView) throw Error("Design Rule Check is unavailable.");
      return await AtriumDRCView.run(ctx);
    } catch (error) {status("Could not run Design Rule Check. " + error.message); return null;}
  }
  function open(a,{selectBoard,retry,context,info}){
    if (a === "drc") return selectBoard() ? checkDRC(context()) : null;
    const shapeTab=boardShapeTabs[a];
    if(shapeTab && globalThis.AtriumBoardShape && !selectBoard())return;
    const mod=shapeTab?globalThis.AtriumBoardShape&&{open:c=>AtriumBoardShape.open(c,{tab:shapeTab})}:{compare:globalThis.AtriumRevisionReview,connectivity:globalThis.AtriumDesignReview&&{open:AtriumDesignReview.connectivity},export:globalThis.AtriumDesignReview&&{open:AtriumDesignReview.exportDesign},symbols:globalThis.AtriumSymbols,blocks:globalThis.AtriumBlocks,eco:globalThis.AtriumECO,...(globalThis.AtriumECO?.workflows||{}),rules:globalThis.AtriumRules,bom:globalThis.AtriumBOM,annotate:globalThis.AtriumAnnotate,"fab-outputs":globalThis.AtriumFabOutputs,print:globalThis.AtriumPrint&&{open:c=>AtriumPrint.open(c,{mode:"print"})},"export-pdf":globalThis.AtriumPrint&&{open:c=>AtriumPrint.open(c,{mode:"pdf"})},fab:globalThis.AtriumFabOutputs,"output-jobs":globalThis.AtriumOutputJobs,step:globalThis.AtriumSTEP,logo:globalThis.AtriumLogo,stackup:globalThis.AtriumStackup,viaStack:globalThis.AtriumViaStack,viaTemplates:globalThis.AtriumViaStack&&{open:AtriumViaStack.templatesDialog},fabProfiles:globalThis.AtriumFabProfiles,"rule-sets":globalThis.AtriumRuleSets,"via-stubs":globalThis.AtriumViaStubs,compile:globalThis.AtriumERC,erc:globalThis.AtriumERC&&{open:AtriumERC.options},messages:globalThis.AtriumMessages&&{open:c=>AtriumMessages.isOpen?.()?AtriumMessages.close():AtriumMessages.open(c)/* integ-msg */},length:globalThis.AtriumLength,...(globalThis.AtriumAutorouter?.workflows||{}),mcp:globalThis.AtriumAI,...(globalThis.AtriumLibrary?.workflows||{}),...(globalThis.AtriumSymbolWizard?.workflows||{}),"component-new":globalThis.AtriumLibrary?.openSymbolEditor&&{open:c=>AtriumLibrary.openSymbolEditor(c,null)}}[a];
    if(!mod){
      if(!shapeTab && retry(WORKFLOW_NEEDS[a]))return;
      info("This feature is unavailable in this build.");return;
    }
    if(boardActions.has(a) && !selectBoard())return;
    mod.open(context());
  }
  return {open,checkDRC};
})();
