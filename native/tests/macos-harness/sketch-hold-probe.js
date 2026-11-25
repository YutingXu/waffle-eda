"use strict";
// Real macOS WKWebView, with synthesized Pointer Events for each input type.
globalThis.__uiProbes={async run(){
  const post=(ok,name,detail)=>webkit.messageHandlers.harness.postMessage({op:"log",ok,name,detail:detail||null});
  const wait=ms=>new Promise(done=>setTimeout(done,ms));
  const start=document.querySelector("dialog.sp-dialog[open]");
  if(start){start.querySelector("[data-start-action=demo]").click();for(let n=0;n<100&&start.open;n++)await wait(30);}
  const h=AtriumNavHost,p=Atrium.project("Held sketch"),d=Atrium.sheet("schematic","Shape sheet");
  p.documents=[d];await h.replaceProject(p,{force:true,copy:true,dirty:false});h.selectDocument(d.id);
  await AtriumLazy.need("AtriumReviewNotes");AtriumReviewNotes.place("sketch",[0,0]);
  const c=h.canvas(),r=c.getBoundingClientRect(),errors=[];window.addEventListener("error",e=>errors.push(e.message));
  let id=20;
  function device(type){
    const pointerId=id++;let last;
    function fire(phase,at=last,pressure=.5){
      last=at;c.dispatchEvent(new PointerEvent("pointer"+phase,{pointerId,pointerType:type,isPrimary:true,bubbles:true,cancelable:true,
        button:phase==="move"?-1:0,buttons:phase==="up"?0:1,pressure:phase==="up"?0:pressure,clientX:r.left+100+at[0],clientY:r.top+122+at[1]}));
    }
    return {trace(points){fire("down",points[0],.2);for(let j=1;j<points.length;j++)fire("move",points[j],.2+.65*j/(points.length-1));},up:()=>fire("up")};
  }
  const circle=Array.from({length:49},(_,j)=>[32*Math.cos(j*Math.PI/24),32*Math.sin(j*Math.PI/24)]);
  const rect=[[0,0],[70,0],[70,38],[0,38],[0,0]],line=Array.from({length:20},(_,i)=>[i*4,i+.8*Math.sin(i)]);
  const list=()=>h.doc().items.filter(i=>i.ink);
  async function held(kind){for(let i=0;i<50;i++){if(document.querySelector("#status").textContent.startsWith(kind+" snapped."))return;await wait(50);}throw Error(kind+" did not snap");}
  try {
    for(const [type,name,points] of [["mouse","Line",line],["pen","Circle",circle],["touch","Rectangle",rect]]) {
      const tool=device(type),before=list().length;tool.trace(points);await held(name);
      if(list().length!==before)throw Error("Wet shape changed the document");tool.up();
      const item=list().at(-1),v=AtriumMarkup.points(item);
      const geometry=name==="Line"?v.length===2:Math.hypot(v[0][0]-v.at(-1)[0],v[0][1]-v.at(-1)[1])<1e-6;
      post(list().length===before+1 && geometry && (type==="mouse"||Math.max(...v.map(p=>p[2]))-Math.min(...v.map(p=>p[2]))>100),
        "Native "+type+" held "+name.toLowerCase()+" wrote one compatible vector");
    }
    const original=JSON.stringify(list().at(-1)),count=list().length;h.act("undo");
    post(list().length===count-1,"Native Undo removed exactly the held shape");h.act("redo");
    post(JSON.stringify(list().at(-1))===original,"Native Redo restored identical shape and pressure");
    post(!errors.length,"Native Sketch reported no page errors",errors.join(", "));return "Complete";
  }catch(error){post(false,"Native held Sketch",error.message);return "Incomplete";}
}};
