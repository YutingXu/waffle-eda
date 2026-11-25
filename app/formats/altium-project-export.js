"use strict";

// File › Export › Altium Project. The worker returns the actual ASCII design files;
// the editor only presents the review and packages their original encoded bytes.
globalThis.AtriumAltiumProjectExport = (() => {
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  async function open(host = globalThis.AtriumNavHost) {
    const project = host.project(), rev = host.revision?.();
    const d = el("dialog", null, "work-dialog ui-dialog");
    d.setAttribute("aria-label", "Export Altium Project (ASCII)");
    const title = el("h2", "Export Altium Project (ASCII) ");
    title.append(el("span", "Preview", "preview-badge"));
    const list = el("ul"), guidance = el("p"), details = el("details"), notes = el("ul");
    const summary = el("summary", "Export details"); details.append(summary, notes); guidance.hidden = true;
    const status = el("p", "Preparing project files…"); status.setAttribute("role", "status");
    const foot = el("div", null, "work-actions ui-dialog-actions"), close = el("button", "Cancel", "ui-button"), go = el("button", "Export…", "ui-button");
    go.dataset.variant = "primary";
    close.type = go.type = "button"; close.onclick = () => d.close(); go.disabled = true;
    let result;
    go.onclick = async () => {
      go.disabled = true;
      try {
        if (host.project() !== project || host.revision?.() !== rev) throw Error("The project changed. Open Export Altium Project again.");
        const prefix = result.details.archivePrefix?.replace(/\/$/, "") || "";
        const bytes = AtriumZip.create(result.files.map(f => ({name: prefix ? prefix + "/" + f.name : f.name, data: f.bytes ?? f.text})));
        if (await (host.exportFile || AtriumIO.exportFile)(result.details.name, bytes)) {
          host.info?.("Exported " + result.details.name + " (preview)"); d.close();
        }
      } catch (error) {status.textContent = error.message;} finally {go.disabled = false;}
    };
    const native = el("button", "Export Altium source copy…", "ui-button");
    native.type = "button"; native.hidden = true;
    native.onclick = () => {
      const originals = project.documents.filter(doc => {
        const source = globalThis.AtriumImportReports?.sourceDocument(doc) || doc;
        return doc.kind === "pcb" && source.sourceEncoding !== "ascii" && /\.pcbdoc$/i.test(source.sourceName || "");
      });
      const chosen = originals.find(b => b.id === host.currentId()) || originals[0];
      if (!chosen || host.project() !== project || host.revision?.() !== rev) {status.textContent = "The project changed. Open Export Altium Project again."; return;}
      d.close(); host.selectDocument(chosen.id); host.act("export");
    };
    const split = el("button","One sheet per frame", "ui-button");
    split.type="button"; split.hidden=true;
    foot.append(native, close, split, go);
    const body = el("div");
    body.append(el("p", "Extract the ZIP into one folder, then open the .PrjPcb in Altium Designer. It includes an ASCII SchDoc for each sheet and PcbDoc for each board."), list, guidance, details, status);
    d.append(title, body, foot);
    const request=new AbortController(), session=host.folderProject?.();
    globalThis.AtriumShell.openDialog(d, {title, body, actions: foot, initialFocus: close, beforeRemove() { request.abort(); }});
    async function review(pageMode) {
      try {
      result = await AtriumTranslatorClient.export("altium", project, {scope: "project", pageMode, provenance: globalThis.AtriumImportReports?.provenance() || []});
      if (!d.open) return;
      const files = result.details.outputs || result.files;
      let models = 0;
      for (const file of files) {
        if (AtriumTranslatorRegistry.forName(file.name)?.id === "step") {models++; continue;}
        const counts = Object.entries(file.counts || {}).filter(([,value]) => value).map(([k,v]) => v + " " + k);
        list.append(el("li", [file.name, counts.join(", ")].filter(Boolean).join(" · ")));
      }
      if (models) list.append(el("li", models + " STEP companion " + (models === 1 ? "file" : "files")));
      const step = result.report.notes.find(note => /choose Embed Model/i.test(note));
      const source = result.report.notes.find(note => /export design.*Altium source copy/i.test(note));
      if (step || source) {
        guidance.textContent = [step,source].filter(Boolean).join(" ");
        guidance.hidden = false; native.hidden = !source;
      }
      for (const note of result.report.notes) notes.append(el("li", note));
      summary.textContent = "Export details (" + notes.childElementCount + ")";
      go.disabled = !result.files.length; status.textContent = "";
      } catch (error) {if (d.open) status.textContent = error.message;}
    }
    split.onclick=async()=>{
      split.disabled=true;
      await review("frames");
      if (result?.files.length) split.hidden=true;
      split.disabled=false;
    };
    try {
      if (session?.completeFor("export") === false) {
        await session.requireClosure({purpose:"export",signal:request.signal});
      }
      await session?.ensureImportReports?.();
      if (!d.open) return d;
      if (host.project()!==project || host.revision?.()!==rev) throw Error("The project changed. Open Export Altium Project again.");
      const large=globalThis.AtriumSchematicOutput?.oversized(project,"altium") || [];
      if (large.length) {
        split.hidden=large.some(d=>!d.items.some(i=>i.kind==="textframe"&&i.role==="frame"));
        status.textContent=large.map(d=>d.name).join(", ")+" exceeds Altium’s 1651 mm page limit. "+(split.hidden?"Add named frames to divide the drawing.":"Export a parent sheet and one child per frame.");
      } else await review();
    } catch(error) {if(d.open)status.textContent=error.message;}
    return d;
  }
  globalThis.AtriumNavCommon?.ready?.(h => h.registerAction("export-altium", () => open(h)));
  return Object.freeze({open});
})();
