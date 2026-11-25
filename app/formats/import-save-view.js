"use strict";
// Presentation for the first Save of an imported design. The editor owns the
// file, export plan and save policy, including any remembered project choice.
globalThis.AtriumImportSaveView = (() => {
  const t = AtriumI18n.define({
    "import_save.source": "Imported from {format}",
    "import_save.waffle": "Save as Waffle Project…",
    "import_save.report": "Import Report",
    "import_save.question": "Save “{name}” as a Waffle project?",
    "import_save.detail": "This design was imported from {format}. Saving as a Waffle project keeps everything you add and makes saves instant and Git-friendly. Your original {format} files stay untouched.",
    "import_save.export_to": "Export to {format}…",
    "import_save.cancel": "Cancel",
    "import_save.export_title": "Export “{name}” to {format}",
    "import_save.kept": "Kept",
    "import_save.converted": "Converted",
    "import_save.lost": "Lost",
    "import_save.more_details": "More details ({count})",
    "import_save.remember": "Remember for this project",
    "import_save.remember_session": "Remember while this import is open",
    "import_save.export": "Export",
    "import_save.portable_question": "Download “{name}” as a Waffle project ZIP?",
    "import_save.download_zip": "Download Format 2 ZIP"
  });
  const countText = value => AtriumI18n.number?.(value) ?? value.toLocaleString("en");
  let banner, active;
  function el(tag, css, text) { return AtriumNavCommon.classedElement(document, tag, css, text); }
  function clearHint() {
    if (!banner) return;
    const focused = banner.node.contains(document.activeElement);
    banner.language.disconnect();
    banner.node.remove();
    banner = null;
    if (focused) restore(globalThis.AtriumNavHost?.canvas?.());
  }
  function hint({formatLabel, onSave}) {
    if (!formatLabel || typeof onSave !== "function") {clearHint(); return;}
    const tabs = document.querySelector("#editor-area > .editor-tabbar");
    if (!tabs) return;
    if (!banner) {
      const node = el("div","import-save-hint no-i18n");
      const source = el("span","import-save-source");
      source.id = "import-save-source";
      const separator = el("span","import-save-separator","·");
      separator.setAttribute("aria-hidden","true");
      const save = AtriumUI.button(el("button","import-save-link"),"quiet","sm");
      save.addEventListener("click",event => banner?.onSave(event.currentTarget));
      save.setAttribute("aria-describedby",source.id);
      // What the import kept, approximated or dropped: the report sits with the import, not in Properties.
      const report = AtriumUI.button(el("button","import-save-link"),"quiet","sm");
      report.addEventListener("click",() => globalThis.AtriumNavHost?.act?.("import-report"));
      node.append(source,separator,save,el("span","import-save-separator","·"),report);
      node.lastChild.previousSibling.setAttribute("aria-hidden","true");
      const refresh = () => {
        source.textContent = t("import_save.source",{format:banner.format});
        save.textContent = t("import_save.waffle");
        banner.node.lastChild.textContent = t("import_save.report");
      };
      const language = new MutationObserver(refresh);
      language.observe(document.documentElement,{attributes:true,attributeFilter:["lang"]});
      banner = {node,refresh,language};
      tabs.after(node);
    }
    Object.assign(banner,{format:formatLabel,onSave});
    banner.refresh();
  }
  function restore(anchor) {
    if (document.querySelector("dialog[open]")) return;
    if (anchor?.isConnected && !anchor.disabled && anchor!==document.body && !anchor.closest("[inert]") && anchor.getClientRects().length)
      anchor.focus({preventScroll:true});
    else AtriumShell.focusEditor();
  }
  function sheet(title, options, content, buttons, cancelled, {totals,remember} = {}) {
    const anchor = options.anchor || document.activeElement, signal = options.signal;
    if (signal?.aborted) return Promise.resolve(cancelled);
    let choice = cancelled;
    const actions = buttons.map(item => ({
      label:item.label,primary:item.primary,focus:item.primary,size:"lg",run(){choice=item.value();}
    }));
    const dialog = AtriumShell.dialog({title,body:[totals,content,remember],actions,sheet:true,className:"import-save-sheet no-i18n"});
    dialog.dataset.returnFocus = "opener";
    if (content?.getAttribute("role") === "region") content.setAttribute("aria-labelledby",dialog.getAttribute("aria-labelledby"));
    const description = totals || content;
    if (description?.id) dialog.setAttribute("aria-describedby",description.id);
    const footer = dialog.querySelector(".ui-dialog-actions"), desktopOrder = [...footer.children];
    const narrowOrder = actions.map(action => action.button).reverse();
    const viewport = globalThis.visualViewport;
    function fit() {
      const stacked = (viewport?.width ?? document.documentElement.clientWidth) <= 480;
      if (stacked !== dialog.hasAttribute("data-stacked")) {
        const focused = footer.contains(document.activeElement) ? document.activeElement : null;
        dialog.toggleAttribute("data-stacked",stacked);
        footer.append(...(stacked ? narrowOrder : desktopOrder));
        focused?.focus({preventScroll:true});
      }
      if (!viewport) return;
      dialog.style.setProperty("--import-save-x",viewport.offsetLeft+viewport.width/2+"px");
      dialog.style.setProperty("--import-save-y",viewport.offsetTop+viewport.height/2+"px");
      dialog.style.setProperty("--import-save-w",viewport.width+"px");
      dialog.style.setProperty("--import-save-h",viewport.height+"px");
    }
    fit();
    viewport?.addEventListener("resize",fit);
    viewport?.addEventListener("scroll",fit);
    const cancel = () => {if (dialog.open) dialog.close();};
    dialog.addEventListener("cancel",event => {
      event.preventDefault();
      cancel();
      if (!signal?.aborted) restore(anchor);
    });
    signal?.addEventListener("abort",cancel,{once:true});
    return dialog.done.then(() => {
      viewport?.removeEventListener("resize",fit);
      viewport?.removeEventListener("scroll",fit);
      signal?.removeEventListener("abort",cancel);
      if (signal?.aborted) return cancelled;
      restore(anchor);
      return choice;
    });
  }
  // Coalesce repeated Save keys for the same session while its sheet is visible.
  function single(kind, options, cancelled, show) {
    if (options.signal?.aborted) return Promise.resolve(cancelled);
    if (active) {
      if (active.signal?.aborted)
        return active.job.catch(()=>{}).then(()=>single(kind,options,cancelled,show));
      const same = active.kind === kind && active.file === options.file && active.id === options.id &&
        active.sourceKey === options.sourceKey && active.name === options.name &&
        active.format === options.formatLabel && active.signal === options.signal;
      return same ? active.job : Promise.resolve(cancelled);
    }
    const current = {kind,file:options.file,id:options.id,sourceKey:options.sourceKey,
      name:options.name,format:options.formatLabel,signal:options.signal};
    active = current;
    try {current.job = Promise.resolve(show()).finally(() => {if (active === current) active = null;});}
    catch (error) {active=null;return Promise.reject(error);}
    return current.job;
  }
  function firstSave(options) {
    return single("choice",options,"cancel",async () => {
      const {name,format,formatLabel,file,id,sourceKey,signal} = options;
      const labels = {title:t("import_save.question",{name}),detail:t("import_save.detail",{format:format === "altium" ? "Altium" : formatLabel}),
        save:t("import_save.waffle"),cancel:t("import_save.cancel")};
      const canExport = options.canExport !== false;
      if (canExport) labels.export = t("import_save.export_to",{format:formatLabel});
      const native = globalThis.AtriumHost;
      if (native) {
        const binding = file && native.canConvertSibling?.(file) ? {file} : id && sourceKey ? {id,sourceKey} : null;
        if (!native.importSaveChoice || !binding) return "cancel";
        const anchor = options.anchor || document.activeElement;
        try {
          const choice = await native.importSaveChoice({...binding,name,format,labels,canExport,signal});
          return !signal?.aborted && (choice === "waffle" || choice === "export" && canExport) ? choice : "cancel";
        } catch (error) {if (signal?.aborted) return "cancel";throw error;}
        finally {if (!signal?.aborted) restore(anchor);}
      }
      const choices = [{label:labels.cancel,value:()=>"cancel"}];
      if (canExport) choices.push({label:labels.export,value:()=>"export"});
      choices.push({label:labels.save,primary:true,value:()=>"waffle"});
      const detail = el("p","import-save-description",labels.detail);
      detail.id = "import-save-description";
      return sheet(labels.title,options,detail,choices,"cancel");
    });
  }
  function report(options) {
    const cancelled = {proceed:false,remember:false};
    return single("report",options,cancelled,() => {
      const body = el("div","import-save-report");
      body.tabIndex = 0;
      body.setAttribute("role","region");
      const totals = el("dl","import-save-totals");
      totals.id = "import-save-totals";
      const groups = [["kept",t("import_save.kept")],["converted",t("import_save.converted")],["lost",t("import_save.lost")]];
      for (const [group,heading] of groups) {
        const features = options[group] || [];
        const count = features.reduce((sum,feature) => sum+(feature.count ?? 1),0);
        const total = el("div",group === "lost" && count > 0 ? "has-loss" : "");
        total.append(el("dt","",heading),el("dd","",countText(count)));
        totals.append(total);
        if (!features.length) continue;
        const section = el("section","import-save-group");
        section.append(el("h3","",heading));
        const list = el("ul");
        for (const feature of features) {
          const row = el("li"), label = el("span","import-save-feature",typeof feature === "string" ? feature : feature.label);
          label.dir = "auto"; row.append(label);
          if (feature.count > 1) {
            row.append(el("span","import-save-count","×"+countText(feature.count)));
          }
          if (feature.detail) {
            const detail = el("small","import-save-detail",feature.detail); detail.dir="auto"; row.append(detail);
          }
          if (feature.additionalDetails?.length) {
            const more = el("details","import-save-detail");
            more.append(el("summary","",t("import_save.more_details",{count:feature.additionalDetails.length})));
            function showReasons() {
              if (!more.open) return;
              more.removeEventListener("toggle",showReasons);
              for (const message of feature.additionalDetails) {
                const detail = el("div","",message); detail.dir="auto"; more.append(detail);
              }
            }
            more.addEventListener("toggle",showReasons);
            row.append(more);
          }
          list.append(row);
        }
        section.append(list);body.append(section);
      }
      let remember, field;
      if (options.allowRemember) {
        field = el("label","import-save-remember ui-checkbox-row");
        remember = el("input","ui-checkbox"); remember.type="checkbox";
        const label = options.rememberScope === "session" ? t("import_save.remember_session") : t("import_save.remember");
        field.append(remember,el("span","",label));
      }
      const title = t("import_save.export_title",{name:options.name,format:options.formatLabel});
      return sheet(title,options,body,[
        {label:t("import_save.cancel"),value:()=>cancelled},
        {label:t("import_save.export"),primary:true,value:()=>({proceed:true,remember:!!remember?.checked})}
      ],cancelled,{totals,remember:field});
    });
  }
  function confirmPortable(options) {
    return single("portable",options,false,() => sheet(t("import_save.portable_question",{name:options.name}),options,null,[
      {label:t("import_save.cancel"),value:()=>false},
      {label:t("import_save.download_zip"),primary:true,value:()=>true}
    ],false));
  }
  return Object.freeze({hint,clearHint,firstSave,report,confirmPortable});
})();
