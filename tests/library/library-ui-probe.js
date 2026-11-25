// Library UI regressions in headless Chrome:
//   probe.sh tests/library/library-ui-probe.js  (the probe() result must be all true / empty arrays, with no ERRS)
async function probe(){
  const wait=ms=>new Promise(r=>setTimeout(r,ms)),out={};
  await AtriumLazy.need(["AtriumLibrary"]);const L=AtriumLibrary,W=AtriumFootprintWizard;
  dispatchEvent(new CustomEvent("atrium-command",{detail:"library-panel"}));await wait(200);
  const P=L.mountPanel(),ctx=P.ctx,proj=()=>ctx.currentProject();
  window.confirm=()=>false; // "Discard changes?" -> No
  // #14: × on a dirty footprint editor asks first (confirm says no, so it stays open).
  const fe=L.openFootprintEditor(ctx,null);await wait(50);
  fe.change(()=>fe.draft.footprint.pads.push({number:"1",x:0,y:0,w:1,h:1,shape:"rect",drill:0}));
  fe.dialog.querySelector(".lib-close").click();out.dirtyCloseKeptOpen=fe.dialog.open;
  fe.dialog.dispatchEvent(new Event("cancel",{cancelable:true}));out.escKeptOpen=fe.dialog.open;
  window.confirm=()=>true;fe.dialog.querySelector(".lib-close").click();out.closedAfterYes=!fe.dialog.open;
  // #8: deleting a hovered pad leaves rendering working.
  const fh=L.openFootprintEditor(ctx,null);await wait(50);
  fh.change(()=>fh.draft.footprint.pads.push({number:"1",x:0,y:0,w:2,h:2,shape:"rect",drill:0},{number:"2",x:4,y:0,w:2,h:2,shape:"rect",drill:0}));fh.stage.fit();
  const hc=fh.dialog.querySelector("canvas.fe-canvas"),hr=hc.getBoundingClientRect(),hs=fh.stage.toScreen([4,0]);
  for(const t of ["pointermove","pointerdown","pointerup"])hc.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:hr.left+hs[0],clientY:hr.top+hs[1],button:0,pointerId:1}));
  hc.dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}));
  try{fh.stage.render();out.hoverRenderOk=fh.draft.footprint.pads.length===1;}catch(e){out.hoverRenderOk=e.message;}
  fh.dialog.close();
  // #13: footprint choice in the symbol editor is undoable and marks the editor dirty.
  const r=proj().library.find(d=>d.id==="std-r");
  const se=L.openSymbolEditor(ctx,{...r,footprint:undefined});await wait(50);
  se.setTab("props");se.dialog.querySelector('select[aria-label="Use footprint of"]');
  const sel=[...se.dialog.querySelectorAll("select")].find(s=>s.getAttribute("aria-label")==="Use footprint of");
  sel.value=sel.options[1].value;sel.dispatchEvent(new Event("change"));
  out.seDirty=/•/.test([...se.dialog.querySelectorAll("button")].find(b=>/^Save( •)?$/.test(b.textContent)).textContent);out.seFootprintSet=!!se.build().footprint;
  se.dialog.querySelector("canvas").dispatchEvent(new KeyboardEvent("keydown",{key:"z",metaKey:true,bubbles:true}));
  out.seUndoRemovesFootprint=!se.build().footprint;
  se.dialog.close();
  // #15: Open in Footprint Editor commits nothing until Save.
  const before=proj().library.length;
  L.openWizard(ctx);await wait(80);
  const wiz=document.querySelector("dialog.fw-dialog[open]");
  [...wiz.querySelectorAll("button")].find(b=>b.textContent==="Open in Footprint Editor").click();await wait(80);
  out.libraryUnchangedWhileEditing=proj().library.length===before;
  const fe2=document.querySelector("dialog.fe-dialog[open]");window.confirm=()=>true;
  [...fe2.querySelectorAll("button")].find(b=>b.textContent==="Cancel").click();await wait(20);
  out.cancelLeavesLibrary=proj().library.length===before;
  // #3: an invalid wizard result keeps the dialog open with the error, buttons disabled.
  L.openWizard(ctx);await wait(80);
  const w2=document.querySelector("dialog.fw-dialog[open]"),fam=w2.querySelector('[aria-label="Package family"]');fam.value="nolead";fam.dispatchEvent(new Event("change"));await wait(30);
  const pitch=[...w2.querySelectorAll("input")].find(i=>i.getAttribute("aria-label")==="Pitch e");pitch.value="0.65";pitch.dispatchEvent(new Event("input"));await wait(30);
  const add=[...w2.querySelectorAll("button")].find(b=>b.textContent==="Add to library");
  out.addDisabled=add.disabled;add.disabled=false;add.click();await wait(20);
  out.wizardStillOpen=w2.open;out.wizardStatus=w2.querySelector(".lib-error").textContent;w2.close();
  // #10: in a library-file view, Del and E do not touch the project def.
  const def=W.generate({family:"chip",preset:"0603"});
  L.sourceStore.save([{id:"lf",name:"File lib",path:"f.atrlib",defs:[def]}]);
  P.render();const src=document.querySelector(".lib-source");src.value="lf";src.dispatchEvent(new Event("change"));await wait(20);
  P.selected=def.id;P.render();
  [...document.querySelectorAll(".lib-detail-actions button")].find(b=>b.textContent==="Add to project").click();await wait(20);
  const copy=proj().library.find(d=>d.libraryRef?.id===def.id);out.copyHasOwnId=!!copy&&copy.id!==def.id;
  P.selected=def.id;P.render();
  const list=document.querySelector(".lib-list");list.dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}));
  out.projectCopyKept=!!proj().library.find(d=>d.libraryRef?.id===def.id);
  out.noEditorOpened=(list.dispatchEvent(new KeyboardEvent("keydown",{key:"e",bubbles:true})),!document.querySelector("dialog.se-dialog,dialog.fe-dialog"));
  // #17: Update parts on a def whose update throws reports once, no second TypeError.
  src.value="project";src.dispatchEvent(new Event("change"));P.selected="std-r";P.render();
  const errs=window.__errs.length,orig=ctx.edit;ctx.edit=()=>{throw Error("boom")};
  [...document.querySelectorAll(".lib-detail-actions button")].find(b=>b.textContent==="Update parts").click();
  ctx.edit=orig;await wait(20);out.updateErrorsUncaught=window.__errs.slice(errs);
  return out;
}
