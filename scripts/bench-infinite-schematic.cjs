"use strict";
// Run with the same Chrome and playwright-core as tests/integration-browser.cjs.
// Compares the same 20,000 objects, with only the distance between two clusters changed.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");

async function main() {
  const browser = await chromium.launch({headless:true,...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"})});
  try {
    const page = await browser.newPage({viewport:{width:1400,height:950}}), errors=[];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(__dirname,"..","app","index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    const result=await page.evaluate(async()=>{
      const A=Atrium, H=AtriumNavHost, S=AtriumSchObjects;
      await AtriumLazy.need(["AtriumCamera","AtriumCanvasFast","AtriumUndoStore"]);
      function project(gap){
        const p=A.project("Infinite sheet benchmark",AtriumParts.catalogue),d=p.documents[0];p.documents=[d];
        d.sheet={infinite:true}; d.id="bench-infinite"; d.name="Bench";
        for(let n=0;n<2000;n++){
          const x=(n%50)*40-1000+(n>=1000?gap:0), y=(Math.floor(n/50)%20)*40-400, items=d.items;
          items.push({id:"r"+n,kind:"part",def:"std-r",ref:"R"+(n+1),value:"10k",x,y,angle:0});
          items.push({id:"w"+n,kind:"wire",points:[[x-15,y],[x-5.08,y]]});
          items.push({id:"s"+n,kind:"wire",points:[[x+5.08,y],[x+12,y],[x+12,y+4]]});
          items.push({id:"j"+n,kind:"junction",x:x-9,y});
          items.push({id:"n"+n,kind:"netlabel",text:"N"+n,x:x-15,y});
          items.push({id:"p"+n,kind:"power",text:"GND",style:"gnd",direction:0,x:x+12,y:y+4});
          items.push({id:"b"+n,kind:"bus",points:[[x-15,y+11],[x+12,y+11]]});
          items.push({id:"l"+n,kind:"label",text:"Channel "+n,x:x-14,y:y-7});
          items.push({id:"g"+n,kind:"graphic",points:[[x-16,y-8],[x+14,y-8]]});
          items.push({...S.make("frame",[x-18,y-11],{w:34,h:25,text:"Group "+n}),id:"f"+n});
        }
        return JSON.stringify(p);
      }
      const inputs=[project(2000),project(20000000)],open=[[],[]],widths=[];
      const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
      const round=n=>Math.round(n*100)/100, p95=a=>round([...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1]);
      const canvas=H.canvas(),ctx=canvas.getContext("2d"), view=H.view();
      const options={hidden:new Set(),selectedIds:new Set(),grid:true,layer:"Top",editorPane:true,reuseBase:true};
      function raster(){ctx.getImageData(0,0,1,1);}
      function render(){view.render(H.doc(),H.defs(),options);raster();}
      function pan(atFit){
        if(atFit)view.fit(H.doc(),H.defs(),"document");
        else{const first=H.doc().items[0];view.restoreCamera({...view.camera(),cx:first.x+120,cy:first.y+80,scale:4});}
        view.settle();render();
        const samples=[];
        for(let i=0;i<70;i++){
          const start=performance.now();view.pan((i%20<10?1:-1)*4,(i%12<6?1:-1)*3);view.moving();render();
          if(i>=10)samples.push(performance.now()-start);
        }
        view.settle();return p95(samples);
      }
      // Alternate the input order to remove first-load and JIT effects from the comparison.
      for(let rep=0;rep<5;rep++){
        for(const k of rep%2?[1,0]:[0,1]){
          const t=performance.now(),p=A.validate(JSON.parse(inputs[k]));
          await H.replaceProject(p,{force:true,copy:true,dirty:false});
          view.fit(H.doc(),H.defs(),"document");render();
          const elapsed=performance.now()-t;if(rep)open[k].push(elapsed);
          const b=view.drawingBounds(H.doc(),H.defs());widths[k]=round(b[2]-b[0]);
          if(H.doc().items.length!==20000 || b.some(n=>!Number.isFinite(n)))throw Error("invalid benchmark extent");
        }
      }
      const k=1,p=A.validate(JSON.parse(inputs[k]));await H.replaceProject(p,{force:true,copy:true,dirty:false});
      return {objects:H.doc().items.length,widthMm:widths,openAndPaintMedianMs:open.map(a=>round(median(a))),
        fitPanP95Ms:pan(true),detailPanP95Ms:pan(false),panSamplesPerView:60};
    });
    console.log(JSON.stringify(result));
    assert.deepEqual(errors,[]);
    assert.ok(result.widthMm[1]/result.widthMm[0]>1000);
    assert.ok(result.openAndPaintMedianMs[1]<=result.openAndPaintMedianMs[0]*1.35+5,"empty space should not add open work");
    assert.ok(Math.max(result.fitPanP95Ms,result.detailPanP95Ms)<=16,"existing schematic pan budget is 16 ms p95");
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
