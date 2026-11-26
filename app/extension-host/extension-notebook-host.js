"use strict";
// Trusted host-side bridge, loaded for notebook contributions only. Workers receive
// data messages through their owner-bound channel and never receive these capabilities.
globalThis.AtriumExtensionNotebookHost = {create({
  activate, paletteAvailable, paletteDeclared, notebookModule, commandPool, attached, info,
  packageOf, bundleDigest, timeoutOf, hostsOf, pools, pool, start, stop, flush, request, sizeOf
}) {
  async function invokeContribution(e, command, event, protocol = "invoke", permission = "ui:command", signal) {
    const epoch = globalThis.AtriumLabs.notebookSignal();
    const current = () => !epoch.aborted && !signal?.aborted && paletteAvailable(e, false) && e.perms[permission] === true;
    if (!current()) throw Error("This extension is unavailable.");
    await activate(e.id, "onCommand:" + command);
    if (!current()) throw Error("This extension is unavailable.");
    const owner = commandPool(e.id);
    const budget = protocol === "widgetInvoke" ? Math.min(timeoutOf(e), AtriumExtensionWidgetDeclarations.limits.timeout) : timeoutOf(e);
    const worker = owner.worker;
    // A mixed package may also run ordinary commands. Reclaim its worker only if
    // a notebook invocation is still executing when the user switches Labs off.
    const cancel = () => {if (owner.worker === worker) stop(owner,"Notebook turned off.","cancelled");};
    epoch.addEventListener("abort",cancel,{once:true});
    try {
      const result = await request(owner, {t: protocol, ext: e.id, command, args: [event]}, budget, e.id);
      if (!current()) throw Error("This extension is unavailable.");
      return result;
    } finally {epoch.removeEventListener("abort",cancel);}
  }
  let searchSeq = 0;
  function cancelSearches(e) {
    for (const p of pools.values()) if (p.search && p.owner === e.id) p.search.cancel();
  }
  async function paletteSearch(e, provider, query, signal, emit) {
    if (!paletteAvailable(e, true) || signal?.aborted || [...pools.values()].filter(p => p.search && !p.cancelled).length >= 8) return;
    const hosts = provider.hosts.filter(h => hostsOf(e).includes(h));
    const p = pool("search:" + (++searchSeq), {network: hosts}, e.id);
    let stopped = false, emitted = 0;
    const cancel = () => {
      if (stopped) return;
      stopped = true; p.cancelled = true;
      if (p.worker) {
        p.post({t: "cancelSearch"}); flush(p);
        // Cancellation is observable by the provider, and its worker is reclaimed even if it ignores it.
        for (const n of p.nets.values()) n.ctrl?.abort();
        setTimeout(() => stop(p, "Search cancelled.", "cancelled"), 0);
      }
    };
    p.search = {pool: p, hosts, rate: {at: 0, calls: 0, logs: 0}, cancel, emit(rows) {
      if (!stopped && paletteAvailable(e, true) && ++emitted <= 8 && Array.isArray(rows) && rows.length <= 24 && sizeOf(rows) <= 192000) emit(rows);
    }};
    signal?.addEventListener?.("abort", cancel, {once: true});
    try {
      const files = await packageOf(e);
      if (stopped || !paletteAvailable(e, true)) return;
      await start(p);
      if (stopped || !paletteAvailable(e, true)) return;
      await request(p, {t: "search", source: files[provider.module], data: provider.data ? files[provider.data] : undefined, query}, 2000, e.id);
    } finally {
      signal?.removeEventListener?.("abort", cancel);
      stop(p, "Search finished."); pools.delete(p.key);
    }
  }

  // Notebook declarations can be parked in an installed or project package. They
  // gain no live capability until the package, permission and current Labs epoch agree.
  const admitted = new WeakMap(), checkedMath = new WeakMap();
  function bindPalette(P) {
    P?.attach({available:paletteAvailable,invoke:(r,command,event,signal)=>invokeContribution(r,command,event,"paletteInvoke","ui:command",signal),search:paletteSearch,info});
  }
  async function checkNotebook(manifest,files,record,epoch) {
    const c=manifest.contributes;
    if (epoch.aborted) return;
    const fail=message=>{throw Error(message);};
    if (paletteDeclared(c)) {
      const D=await notebookModule("AtriumExtensionPaletteDeclarations","extension-palette-declarations");
      D.validate(manifest,files,fail);
    }
    if (!epoch.aborted && c.widgets!==undefined) {
      const W=await notebookModule("AtriumExtensionWidgetDeclarations","extension-widget-declarations");
      W.validate(manifest);
    }
    if (record && c.mathFunctions?.length && !epoch.aborted) {
      const old=checkedMath.get(manifest);
      if (old?.epoch===epoch && old.hash===record.hash) return;
      const P=await notebookModule("AtriumExtensionPalette","extension-palette");
      if (epoch.aborted) return;
      await P.validateMathPackage(record);
      if (!epoch.aborted) checkedMath.set(manifest,{epoch,hash:record.hash});
    }
  }
  function admitNotebook(e,epoch) {
    if (epoch.aborted || !paletteAvailable(e,false)) return;
    const prior=admitted.get(e);
    if (prior?.epoch===epoch) return prior.job;
    const admission={epoch,ready:false};
    const job=(async()=>{
      const files=await packageOf(e);
      if (!files || epoch.aborted || !paletteAvailable(e,false)) return;
      if (e.manifest.contributes.mathFunctions?.length && !e.hash) e.hash=bundleDigest(e.manifest,files);
      await checkNotebook(e.manifest,files,e,epoch);
      if (epoch.aborted || !paletteAvailable(e,false) || !attached()) return;
      const c=e.manifest.contributes;
      const P=paletteDeclared(c) ? await notebookModule("AtriumExtensionPalette","extension-palette") : null;
      if (epoch.aborted || !paletteAvailable(e,false) || !attached()) return;
      bindPalette(P);
      admission.ready=true;
      P?.add(e);
      if (c.widgets?.length) globalThis.AtriumExtensionWidgetDeclarations.install(e,{
        current:(r,permission)=>paletteAvailable(r,false) && r.perms[permission]===true,
        invoke:(r,command,data,protocol)=>invokeContribution(r,command,data,protocol,"ui:widgets")
      });
    })();
    admission.job=job; admitted.set(e,admission);
    return job;
  }
  function remove(e,stopOwner=false) {
    if (stopOwner) {
      const owner=pools.get("ext:"+e.id);
      if (owner?.worker) stop(owner,"Notebook turned off.","cancelled");
    }
    admitted.delete(e); checkedMath.delete(e.manifest);
    cancelSearches(e);
    globalThis.AtriumExtensionPalette?.remove(e);
    globalThis.AtriumExtensionWidgetDeclarations?.remove(e.id);
  }
  function permissionChanged(e,permission,network) {
    if (permission === "ui:widgets" || permission === "read:project") {
      globalThis.AtriumPalette?.invalidateProvider?.("sheet-widgets");
      globalThis.AtriumSheetWidgetRuntime?.invalidate?.();
    }
    if (network || permission === "ui:command") {
      cancelSearches(e);
      globalThis.AtriumExtensionPalette?.invalidate(e);
    }
  }
  if (globalThis.AtriumLabs.notebookEnabled()) bindPalette(globalThis.AtriumExtensionPalette);
  return {admit:admitNotebook, check:checkNotebook, isReady:e=>admitted.get(e)?.ready === true,
    connect:()=>bindPalette(globalThis.AtriumExtensionPalette), remove, permissionChanged};
}};
