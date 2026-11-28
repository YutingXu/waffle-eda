"use strict";

const assert=require("node:assert/strict");
async function observeFrames(page) {
  await page.evaluate(()=>{
    const h=AtriumNavHost;
    window.waffleRowVisible=row=>{
      if(!row)return false;
      const r=row.getBoundingClientRect();
      return r.height>0 && row.contains(document.elementFromPoint(r.left+Math.min(24,r.width/2),r.top+r.height/2));
    };
    h.on("frame",()=>{window.waffleFrame={doc:h.currentId(),tool:h.tool(),highlight:h.highlight(),revision:h.revision(),selection:h.selection()};});
  });
}
// A result can be selectable before the user finishes typing. Start the clock
// with the first key in a paced burst and require an empty list before each trial.
async function selectByTyping(page, measure, box, empty, label, text, predicate, arg) {
  await box.fill("zzzz-missing-result");
  await empty();
  await box.focus();
  await box.press("ControlOrMeta+a");
  await measure(label,{type:"keydown",key:text[0]},predicate,arg,
    ()=>page.keyboard.type(text,{delay:24}));
}
async function shell({page,repeat,measure,workload}) {
  workload.typingDelayMs=24;
  await observeFrames(page);
  const palette=page.locator(".nav-palette[open]"),box=palette.getByRole("combobox");
  const selectable=t=>()=>{
    const rows=document.querySelectorAll('.nav-palette[open] [role=option]:not([aria-disabled=true])');
    for(const row of rows){
      const label=row.querySelector(".nav-palette-label")?.textContent.replace(/…$|\.{3}$/,"");
      if(label?.toLowerCase()===t.toLowerCase() && window.waffleRowVisible(row))
        return {label,typed:document.querySelector(".nav-palette[open] [role=combobox]").value};
    }
  };
  for(let i=0;i<repeat;i++){
    await page.locator("#canvas").focus(); await page.keyboard.press("ControlOrMeta+Shift+p");
    await selectByTyping(page,measure,box,()=>palette.getByRole("option",{name:/preferences/i}).first().waitFor({state:"hidden"}),
      "palette-command-selectable","preferences",selectable,"Preferences");
    await palette.locator('[role=option][aria-selected=true] .nav-palette-label').filter({hasText:/^Preferences…?$/i}).waitFor();
    await measure("palette-enter-preferences-ready",{type:"keydown",key:"Enter"},()=>()=>{
      const focus=document.querySelector(".prf-dialog[open] .prf-nav [aria-current=page]");
      return focus?.getClientRects().length && focus.textContent;
    },null,()=>box.press("Enter"));
    await page.keyboard.press("Escape");
    await page.evaluate(()=>AtriumNavHost.act("quick-open"));
    const n=1+i%2, id="sheet-m"+n;
    await selectByTyping(page,measure,box,()=>palette.getByRole("option",{name:/module/i}).first().waitFor({state:"hidden"}),
      "quick-open-document-selectable","module "+n,selectable,"Module "+n);
    await palette.locator('[role=option][aria-selected=true] .nav-palette-label').filter({hasText:new RegExp("^Module "+n+"$")}).waitFor();
    await measure("quick-open-enter-sheet-drawn",{type:"keydown",key:"Enter"},id=>()=>window.waffleFrame?.doc===id &&
      !document.querySelector(".nav-palette[open]") && id,id,()=>box.press("Enter"));
  }
}

async function library({page,repeat,measure,workload}) {
  workload.typingDelayMs=24;
  await page.evaluate(()=>AtriumNavHost.act("library"));
  await observeFrames(page);
  const panel=page.locator(".panel-library"),box=panel.getByRole("searchbox",{name:"Search the library"});
  for(let i=0;i<repeat;i++){
    // Start from an empty result list on every pass, even when a recent symbol is promoted.
    await selectByTyping(page,measure,box,()=>panel.locator('.lib-row[data-def="std-r"]').waitFor({state:"hidden"}),
      "library-symbol-selectable","resistor",()=>()=>{
      const r=document.querySelector('.panel-library .lib-row[data-def="std-r"]');
      return window.waffleRowVisible(r) && !r.matches("[aria-disabled=true]") &&
        {def:r.dataset.def,typed:document.querySelector(".panel-library input[type=search]").value};
    },null);
    const row=panel.locator('.lib-row[data-def="std-r"]');
    await row.focus();
    await measure("library-enter-placement-ready",{type:"keydown",key:"Enter"},()=>()=>AtriumNavHost.placing() &&
      window.waffleFrame?.tool==="place" && "place",null,()=>page.keyboard.press("Enter"));
    // Exercise the placement to independently verify which definition Enter picked.
    const before=await page.evaluate(()=>AtriumNavHost.doc().items.filter(i=>i.def==="std-r").length);
    await page.locator("#canvas").click({position:{x:70,y:90}});
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.filter(i=>i.def==="std-r").length),before+1);
    await page.keyboard.press("Escape");
  }
}

async function bom({page,repeat,measure,workload}) {
  const data=await page.evaluate(async()=>{
    const h=AtriumNavHost,V=await AtriumLazy.need("AtriumVariants"),B=await AtriumLazy.need("AtriumBOM"),doc=h.doc();
    const base=doc.items.find(i=>i.kind==="part" && i.ref.startsWith("R"));
    const parts=Array.from({length:12},(_,n)=>({...base,id:"trace-bank-"+n,ref:"RB"+(n+1),value:"TRACE-BANK A",x:20+n*10,y:190}));
    const adjacent=Array.from({length:96},(_,n)=>({...base,id:"trace-lot-"+n,ref:"RC"+(n+1),value:"TRACE-BANK lot "+Math.floor(n/4),x:20+n%12*10,y:205+Math.floor(n/12)*10}));
    let v;
    h.edit(()=>{
      let index=0;
      for(const d of h.project().documents) for(const p of d.items) if(p.kind==="part") p.value="Batch "+Math.floor(index++/2);
      doc.items.push(...parts,...adjacent);
      v=V.create(h.project(),{name:"Eight fitted"});V.setParts(h.project(),v.id,parts.slice(0,4).map(V.keyOf),{fitted:false});},"Add assembly variant");
    localStorage.setItem("atrium-bom-v1",JSON.stringify({groupBy:["comment"],columns:["comment","designator","quantity"]}));
    const collected=B.collect(h.project(),{source:"schematic",variant:""});
    const groups=B.build(collected,{groupBy:["comment"]}).length;
    const fitted=collected.parts.length;
    h.act("bom");
    return {variant:v.id,baseParts:fitted,groups};
  });
  Object.assign(workload,{baseFitted:data.baseParts,groupedLines:data.groups,filteredLines:25,groupedParts:12,variantGroupParts:8});
  const dialog=page.locator("dialog.bom-dialog[open]"),filter=dialog.getByRole("searchbox",{name:"Search BOM lines"});
  await filter.fill("TRACE-BANK");
  const variant=dialog.getByRole("combobox",{name:"Assembly variant"});
  const check=({quantity,value,total,variant})=>()=>{
    const rows=document.querySelectorAll("tr.bom-line"),summary=document.querySelector(".bom-summary")?.textContent;
    if(rows.length!==25 || !rows[0].getClientRects().length || !summary?.includes(total.toLocaleString("en-US")+" parts") || !summary.includes("25 shown"))return;
    const r=Array.from(rows).find(row=>row.querySelector(".refs")?.textContent.startsWith("RB"));
    if(!r)return;
    const at=k=>Array.from(document.querySelectorAll("th[data-key]")).findIndex(e=>e.dataset.key===k);
    const read=k=>r.querySelector('[data-c="'+at(k)+'"]')?.textContent.trim();
    if(read("quantity")!==String(quantity) || read("comment")!==value || r.querySelector(".refs")?.textContent!==(variant?"RB5-RB12":"RB1-RB12"))return;
    if(variant!==summary.includes("Variant Eight fitted") || !Array.from(rows).every(row=>row===r || row.querySelector(".num")?.textContent.trim()==="4"))return;
    return {quantity,total,shown:rows.length,refs:r.querySelector(".refs").textContent};
  };
  await page.evaluate(()=>window.waffleDebug=()=>({summary:document.querySelector(".bom-summary").textContent,headers:[...document.querySelectorAll("th[data-key]")].map(e=>e.dataset.key),row:document.querySelector("tr.bom-line").innerText}));
  const cell=dialog.locator("tr.bom-line").filter({has:page.locator(".refs",{hasText:/^RB/})}).locator("td").filter({hasText:/^TRACE-BANK/});
  let value="TRACE-BANK A";
  for(let i=0;i<repeat;i++){
    const fitted=i%2===0, quantity=fitted?8:12,total=data.baseParts-(fitted?4:0);
    await variant.click();
    const option=dialog.getByRole("option",{name:fitted?"Eight fitted":"Base design",exact:true}).filter({visible:true});
    await measure("bom-filtered-variant",{type:"click"},check,
      {quantity,total,value,variant:fitted},()=>option.click());
    // Edit the complete group in the base design each time.
    if(fitted) await variant.selectOption("");
    await cell.click(); await page.keyboard.press("F2");
    const editor=dialog.locator(".bom-editor");
    value="TRACE-BANK edit "+i;
    await editor.fill(value);
    await measure("bom-filtered-group-edit",{type:"keydown",key:"Enter"},check,
      {quantity:12,total:data.baseParts,value,variant:false},()=>editor.press("Enter"));
    assert.equal(await page.evaluate(v=>AtriumNavHost.doc().items.filter(p=>p.id.startsWith("trace-bank-")&&p.value===v).length,value),12);
    // Set up a transition in the opposite direction for the following pass.
    if(fitted) await variant.selectOption(data.variant);
  }
}
module.exports={shell,library,bom};
