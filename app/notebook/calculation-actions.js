"use strict";

// Keeping eligibility separate lets the palette advertise legal actions without opening
// the sheet composer. Read the current host again immediately before every actual write.
globalThis.AtriumCalculationActions = (() => {
  const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(id => b.includes(id));
  function activeInstance(host, doc) {
    if (host?.instanceId) return host.instanceId();
    const occurrence = globalThis.AtriumConnectionPreview?.location?.()?.occurrence;
    return occurrence?.docId === doc?.id ? occurrence.instanceId : undefined;
  }
  function writable(project, doc, host) {
    if (globalThis.AtriumLabs?.notebookEnabled() === false) return false;
    if (!project || doc?.kind !== "schematic" || project.atriumCompat?.readOnly || project.readOnly || doc.readOnly || doc.locked) return false;
    if (host?.canEdit?.(doc.id) === false || host?.canWrite?.(doc.id) === false || host?.folderProject?.()?.canEdit?.(doc.id) === false || globalThis.AtriumRevisions?.locked?.(project)) return false;
    if (["released","obsolete"].includes(project.revision?.status)) return false;
    return !globalThis.AtriumCollabLock?.manager?.()?.blocked(doc.id);
  }
  function selectedValue(project, doc, selection) {
    if (selection?.length !== 1) return null;
    const item = doc.items.find(i => i.id === selection[0]);
    if (item?.kind !== "part" || item.locked || item.readOnly || globalThis.AtriumPCBEdit?.isLocked?.(item)) return null;
    const binding = {scope:"item",docId:doc.id,itemId:item.id,field:"value"};
    const resolved = globalThis.AtriumNoteFields?.resolve(project,doc,item.ref + ".Value",binding);
    if (!resolved || resolved.broken || !resolved.defaultUnit) return null;
    const unit = resolved.defaultUnit;
    const typedUnit = globalThis.AtriumCalculationCore?.evaluate("1 " + unit);
    if (!typedUnit?.ok) return null;
    return {item, field:{...resolved,unit,dimensions:typedUnit.dimensions,tag:typedUnit.tag,scale:typedUnit.value}};
  }
  function target(answer, context = {}, host = context.host || globalThis.AtriumNavHost) {
    const project = host?.project?.(), doc = host?.doc?.(), result = answer?.result;
    const selection = host?.selection?.();
    if (!result?.ok || !writable(project,doc,host) || context.surface || host.revision() !== answer.projectRevision ||
      doc.id !== answer.documentId || (context.docId != null && doc.id !== context.docId) ||
      !sameIds(answer.selection || [],selection) || !sameIds(context.selection || answer.selection || [],selection)) return null;
    const currentInstance = activeInstance(host,doc);
    if ((answer.instanceId != null || currentInstance != null) && (answer.instanceId ?? context.instanceId) !== currentInstance) return null;
    const selected = selectedValue(project, doc, selection);
    const compatible = selected && Number.isFinite(result.value) && !result.assertion &&
      Array.isArray(result.dimensions) && result.dimensions.length === 7 && selected.field.dimensions.length === 7 &&
      (result.tag === "count") === (selected.field.tag === "count") &&
      result.dimensions.every((n,k) => n === selected.field.dimensions[k]);
    return {project, doc, selected:compatible ? selected : null};
  }
  function eligibleActions(answer, context = {}, host = context.host || globalThis.AtriumNavHost) {
    const t = target(answer,context,host);
    return answer?.result?.ok ? ["copy", ...(t ? ["insert"] : []), ...(t?.selected ? ["apply"] : [])] : [];
  }
  return Object.freeze({writable,activeInstance,selectedValue,target,eligibleActions});
})();
