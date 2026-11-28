"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {execFile,execFileSync} = require("node:child_process");
const run = require("node:util").promisify(execFile);
const {fixture} = require("../../support/datasheet-pdf.cjs");
const docs = require("../../support/docs-family-ui.cjs");

async function query({page,type,repeat}) {
  const refs = await page.evaluate(async () => {
    await AtriumLazy.need("AtriumButterEditor"); await AtriumLazy.need("AtriumIntelUI");
    await (await AtriumLazy.need("AtriumQueryUI")).open();
    return AtriumNavHost.doc().items.filter(i=>i.kind==="part").slice(0,2).map(i=>i.ref);
  });
  const box = page.locator(".intel-query-source");
  for (let i=0;i<repeat;i++) {
    const ref = refs[i%2];
    await type("design-query-first-object",box,'part where designator = "'+ref+'"', ref=>() => {
      const first = document.querySelector('.intel-query-results [data-index="0"]');
      if (first?.getClientRects().length && first.querySelector(".ui-row-title")?.textContent===ref) return ref;
    },ref);
  }
}

async function find({page,type,repeat}) {
  await page.evaluate(() => AtriumNavHost.act("find-replace"));
  await page.getByLabel("Scope",{exact:true}).selectOption("project");
  const box = page.locator(".fr-find");
  const refs = await page.evaluate(()=>AtriumNavHost.project().documents.filter(d=>d.items.some(o=>o.kind==="part")).slice(1,3)
    .map(d=>({ref:d.items.find(o=>o.kind==="part").ref,doc:d.name})));
  for(let i=0;i<repeat;i++) {
    const target=refs[i%2];
    await type("project-find-matching-row",box,target.ref,t=>()=> {
      const row=Array.from(document.querySelectorAll(".fr-hit")).find(e=>e.querySelector("mark")?.textContent===t.ref && e.querySelector(".fr-doc")?.textContent===t.doc);
      return row?.getClientRects().length && t;
    },target);
  }
}

async function comments({page,type,repeat,workload}) {
  workload.localThreads=300;
  await page.evaluate(async count=>{
    const R=await AtriumLazy.need("AtriumReviewComments"),h=AtriumNavHost;
    for(let i=0;i<count;i++) R.add(h.project(),{doc:h.currentId(),text:"Check local thread "+String(i).padStart(4,"0"),anchor:{kind:"point",at:[0,0]}});
    R.toggle(true);
  },workload.localThreads);
  const box=page.getByRole("searchbox",{name:"Search comments"});
  for(let i=0;i<repeat;i++) {
    const term=String(100+i).padStart(4,"0");
    await type("local-review-matching-thread",box,term,t=>()=>{
      const rows=document.querySelectorAll(".rc-thread");
      return rows.length===1 && rows[0].getClientRects().length && rows[0].textContent.includes("Check local thread "+t) && t;
    },term);
  }
}

async function pdf({page,type,repeat,workload}) {
  workload.pdfPages=24;
  await docs.enable(page,["datasheets"]);
  await docs.run(page,"butter.datasheets.reader");
  const panel=page.locator(".panel-datasheet");
  const [chooser]=await Promise.all([page.waitForEvent("filechooser"),panel.getByRole("button",{name:"Open PDF…"}).click()]);
  await chooser.setFiles({name:"Trace datasheet.pdf",mimeType:"application/pdf",buffer:fixture(workload.pdfPages)});
  await panel.locator(".docs-page img").first().waitFor();
  await panel.getByRole("button",{name:"Find in datasheet"}).click();
  for(let i=0;i<repeat;i++){
    const n=i%2?12:22;
    await type("pdf-first-visible-matching-page",panel.getByRole("searchbox"),"page "+n,n=>{
      const count=document.querySelector(".docs-find .ui-pager-position");
      let receivedAt, reset=count.textContent!=="1 of 1";
      const observer=new MutationObserver(()=>{
        if(!window.waffleResult.input) return;
        if(count.textContent!=="1 of 1") reset=true;
        else if(reset && receivedAt===undefined) receivedAt=performance.now();
      });
      observer.observe(count,{subtree:true,childList:true,characterData:true});
      return ()=>{
      const root=document.querySelector(".panel-datasheet"),img=root.querySelector('[data-page="'+n+'"] img');
      if(!img?.naturalWidth || root.querySelector(".docs-find .ui-pager-position")?.textContent!=="1 of 1") return;
      const r=img.getBoundingClientRect(),v=root.querySelector(".docs-pages").getBoundingClientRect();
      // The fixture prints the matching line 50 PDF points from the page top.
      const y=r.top+r.height*50/220, x=r.left+r.width*30/320;
      if(receivedAt!==undefined && y>v.top && y<v.bottom && x>v.left && x<v.right) {
        observer.disconnect();
        return {page:n,countMs:receivedAt-window.waffleResult.input.time,pager:root.querySelector(".docs-foot .ui-pager-position").textContent};
      }
      };
    },n);
  }
}

async function wizard({page,repeat,clipboard,measure,workload}) {
  await page.evaluate(()=>{AtriumNavHost.act("symbol-wizard");});
  const ta=page.locator(".sw-paste");
  await ta.waitFor();
  await page.evaluate(()=>{
    // The stage repaints after parsing, building the symbol and fitting its camera.
    const proto=CanvasRenderingContext2D.prototype,fillText=proto.fillText;
    proto.fillText=function(s,...args){
      if(this.canvas.matches(".sw-canvas")) window.waffleWizardText?.add(String(s));
      return fillText.call(this,s,...args);
    };
  });
  workload.symbolPins=[48,64];
  for(let i=0;i<repeat;i++) {
    const n=workload.symbolPins[i%2], tag="SIG"+i+"X";
    await clipboard("Pin\tName\tType\n"+Array.from({length:n},(_,j)=>(j+1)+"\t"+tag+j+"\tinput").join("\n"));
    await ta.focus(); await ta.press("ControlOrMeta+a");
    await measure("symbol-pin-paste-preview",{type:"paste",selector:".sw-paste"},({tag,n})=>{
      window.waffleWizardText=new Set();
      return ()=>document.querySelector(".sw-preview .sw-note")?.textContent.startsWith(n+" pins") &&
        Array.from(window.waffleWizardText).some(s=>s.includes(tag)) && n;
    },{tag,n},()=>page.keyboard.press("ControlOrMeta+v"));
  }
}

async function git({page,repeat,type,workload,cleanup}) {
  const root=path.resolve(__dirname,"../../..");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"waffle-trace-history-"));
  cleanup.push(()=>fs.rm(dir,{recursive:true,force:true}));
  const src=path.join(root,"tests/fixtures/butter-acceptance/slides"),file="Slide study.waffle";
  for(const name of await fs.readdir(src)) await fs.copyFile(path.join(src,name),path.join(dir,name));
  await run("git",["init","-q","-b","main",dir]);
  await run("git",["-C",dir,"add","."]);
  await run("git",["-C",dir,"-c","user.name=Trace","-c","user.email=trace@example.invalid","-c","commit.gpgSign=false","commit","-qm","Initial fixture"]);
  // Give the native picker actual history to search. Every commit changes a file.
  let input="";
  for(let i=1;i<=100;i++) {
    const subject="Revision fixture "+String(i).padStart(3,"0"), data=String(i);
    input+="commit refs/heads/main\ncommitter Trace <trace@example.invalid> "+(1720000000+i)+" +0000\ndata "+subject.length+"\n"+subject+"\n"+
      (i===1?"from refs/heads/main^0\n":"")+"M 100644 inline notes.txt\ndata "+data.length+"\n"+data+"\n\n";
  }
  execFileSync("git",["-C",dir,"fast-import","--quiet"],{input});
  workload.gitCommits=101;
  await page.exposeFunction("waffleReadGit",async(op,args)=>{
    if(!["refs","log"].includes(op)) throw Error("Unexpected fixture query "+op);
    const result=await run("python3",["-B",path.join(root,"native/git_head.py"),"--project",path.join(dir,file),"--query",op,"--args",JSON.stringify(args)]);
    return JSON.parse(result.stdout);
  });
  await page.evaluate(async()=>{
    window.AtriumHost={...window.AtriumHost,folderGitGrant:"trace-folder",gitQuery:async(op,args)=>{
      const start=performance.now(),result=await window.waffleReadGit(op,args);
      if(op==="log" && args.search) window.waffleGitLog={term:args.search,start,end:performance.now()};
      return result;
    }};
    const picker=await AtriumLazy.need("AtriumGitPicker"); void picker.pick({});
  });
  await page.locator(".gp-subject").first().waitFor();
  for(let i=0;i<repeat;i++) {
    const subject="Revision fixture "+String(1+(i*13)%100).padStart(3,"0");
    await type("git-search-matching-commit",page.locator(".gp-search"),subject,t=>()=>{
      const rows=document.querySelectorAll(".gp-subject");
      const log=window.waffleGitLog;
      return rows.length===1 && rows[0].getClientRects().length && rows[0].textContent===t && log?.term===t &&
        {subject:t,requestMs:log.end-log.start,requestStartMs:log.start-window.waffleResult.input.time};
    },subject);
  }
}
module.exports={query,find,comments,pdf,wizard,git};
