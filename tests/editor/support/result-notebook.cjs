"use strict";

const assert=require("node:assert/strict");
async function notebook({page,cdp,repeat,measure,clipboard,workload}) {
  Object.assign(workload,{tableRows:1000,tableColumns:50,rangeRows:100,rangeColumns:4,dependentFormulas:4});
  await page.evaluate(async()=>{
    const h=AtriumNavHost;
    h.selectDocument("trace-notebook");
    const editor=await AtriumLazy.need("AtriumTableEditor"),T=AtriumTableData, R=AtriumTableFormulas;
    const table=AtriumSheetWidgets.make("table",[5,35]),state=T.create(1000,50),changes=[];
    for(let n=0;n<4;n++) {
      changes.push({rowId:state.rows[0].id,columnId:state.columns[n].id,content:{kind:"literal",text:String(n+2)}});
      const letter="ABCD"[n];
      changes.push({rowId:state.rows[n].id,columnId:state.columns[4].id,content:R.scan(state,"=SUM("+letter+"1:"+letter+"100)")});
    }
    table.widget.state=T.batch(state,changes);
    h.edit(()=>h.doc().items.push(table),"Insert trace table",[table]);
    window.waffleTableId=table.id;
    for(const type of ["compositionstart","compositionupdate","compositionend","beforeinput","input"]) window.addEventListener(type,e=>{
      if(window.waffleIMEEvents && e.target.getAttribute("aria-label")==="Cell contents or formula") window.waffleIMEEvents.push([type,e.inputType,e.data,e.isTrusted]);
    },true);
    h.on("frame",()=>{ if(window.waffleUndoWatch) window.waffleUndoRevision=h.revision(); });
    window.waffleOpenTable=()=>editor.open(h,"trace-notebook",table.id);
    window.waffleOpenTable();
  });
  const dialog=page.locator(".table-editor"),grid=dialog.getByRole("grid");
  const coord=(r,c)=>'[role="gridcell"][aria-rowindex="'+r+'"][aria-colindex="'+c+'"]';
  const cell=(r,c)=>grid.locator(coord(r,c));
  const source=[2,3,4,5];
  const dependents=expected=>()=>{
    const values=expected.map((_,i)=>document.querySelector('.table-viewport [aria-rowindex="'+(i+1)+'"][aria-colindex="5"]')?.textContent);
    return expected.every((v,i)=>String(v)===values[i]) && values;
  };
  await cell(1,5).filter({hasText:/^2$/}).waitFor();
  for(let n=0;n<repeat;n++){
    const values=source.map(k=>k+2+n%2);
    await cell(1,1).click();
    await clipboard(Array.from({length:100},()=>values.join("\t")).join("\n"));
    await measure("notebook-paste-dependent-formulas",{type:"paste",selector:".table-viewport"},dependents,values.map(v=>100*v),
      ()=>page.keyboard.press("ControlOrMeta+v"));
    await undo("paste",values);
    // Select the bottom right corner, then shift-select the top left so all four totals stay visible.
    await grid.evaluate(e=>{const h=e.querySelector("[role=gridcell]").getBoundingClientRect().height; e.scrollTop=99*h;});
    await cell(100,4).click();
    await grid.evaluate(e=>{e.scrollTop=0;});
    await cell(1,1).click({modifiers:["Shift"]});
    await measure("notebook-fill-dependent-formulas",{type:"keydown",key:"d"},dependents,source.map(v=>100*v),
      ()=>grid.press("ControlOrMeta+d"));
    await undo("fill",source);
    const text="電圧"+String(n),kana="でんあつ"+String(n);
    await page.evaluate(()=>{window.waffleIMEEvents=[];window.waffleDebug=()=>({events:window.waffleIMEEvents,value:document.activeElement.value});});
    await cell(1,2).click(); await grid.press("F2");
    const editor=dialog.getByRole("textbox",{name:"Cell contents or formula"});
    await editor.press("ControlOrMeta+a");
    await measure("notebook-ime-preedit",{type:"compositionstart"},t=>()=>{
      const e=document.activeElement;
      return e?.value===t && e.getClientRects().length && t;
    },kana,()=>cdp.send("Input.imeSetComposition",{text:kana,selectionStart:kana.length,selectionEnd:kana.length}));
    await measure("notebook-ime-commit-text",{type:"beforeinput"},t=>()=>{
      const e=document.activeElement;
      return e?.value===t && e.getClientRects().length && t;
    },text,()=>cdp.send("Input.insertText",{text}));
    await measure("notebook-ime-save-cell",{type:"keydown",key:"Enter"},t=>()=>{
      const node=document.querySelector('.table-viewport [aria-rowindex="1"][aria-colindex="2"]');
      return node?.textContent===t && node.getClientRects().length && t;
    },text,()=>editor.press("Enter"));
    // Restore the original seed before the next paste/fill cycle.
    await cell(1,2).click(); await grid.press("F2"); await editor.fill("3"); await editor.press("Enter");
    assert.equal(await cell(1,2).textContent(),"3");
  }
  async function undo(kind, changed) {
    const result=await measure("notebook-grid-undo-"+kind,{type:"keydown",key:"z"},dependents,source,
      ()=>grid.press("ControlOrMeta+z"),1000);
    if(result.status==="completed") await page.evaluate(()=>AtriumNavHost.act("redo"));
    // Confirm the range is still edited before measuring Undo from the canvas.
    for(let i=0;i<4;i++) await cell(i+1,5).filter({hasText:new RegExp("^"+changed[i]*100+"$")}).waitFor();
    const revision=await page.evaluate(()=>AtriumNavHost.revision());
    await dialog.getByRole("button",{name:"Done",exact:true}).click();
    await page.locator("#canvas").focus();
    await measure("notebook-canvas-undo-"+kind,{type:"keydown",key:"z"},before=>{
      window.waffleUndoWatch=true; window.waffleUndoRevision=before;
      return ()=>{
        const h=AtriumNavHost,table=h.doc().items.find(x=>x.id===window.waffleTableId);
        if(!table || h.revision()===before || window.waffleUndoRevision!==h.revision())return;
        const s=table.widget.state,T=AtriumTableData;
        if(T.get(s,s.rows[0].id,s.columns[0].id)?.content?.text!=="2" || T.get(s,s.rows[99].id,s.columns[3].id)?.content)return;
        window.waffleUndoWatch=false;return "range restored on canvas";
      };
    },revision,()=>page.keyboard.press("ControlOrMeta+z"));
    await page.evaluate(()=>window.waffleOpenTable());
    for(let i=0;i<4;i++) await cell(i+1,5).filter({hasText:new RegExp("^"+source[i]+"$")}).waitFor();
  }
}
module.exports={notebook};
