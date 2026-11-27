"use strict";
const assert=require("node:assert/strict");
const {chromium}=require("../support/playwright.cjs"),{relay,editor}=require("../project/collab-pair-browser.cjs");
async function wire(page,port) {
  const state={held:false,waiting:[]};
  await page.routeWebSocket("ws://127.0.0.1:"+port+"/**",socket=>{
    const remote=socket.connectToServer();
    socket.onMessage(frame=>{if(state.held)state.waiting.push(()=>remote.send(frame));else remote.send(frame);});
  });
  state.release=()=>{state.held=false;for(const send of state.waiting.splice(0))send();};return state;
}
async function row(page,index) {
  await page.waitForFunction(n=>AtriumNavHost.project().documents.some(d=>d.kind==="schematic" && d.items.filter(i=>i.widget?.type==="todo").length>n),index,{timeout:14000}).catch(async e=>{throw Error("Missing review rows. "+JSON.stringify(await page.evaluate(()=>({project:AtriumNavHost.project().name,engine:AtriumCollabLive.session()?.r?.project?.()?.name,status:AtriumCollabLive.session()?.status,records:Object.values(AtriumNavHost.project().review?.records||{}).length,docs:AtriumNavHost.project().documents.map(d=>[d.kind,d.items.map(i=>i.widget?.type).filter(Boolean)])})))+" "+e.message);});
  await page.evaluate(async n=>{
    const h=AtriumNavHost,d=h.project().documents.find(v=>v.kind==="schematic");
    await AtriumLazy.need("AtriumReviewNotes");h.selectDocument(d.id);
    h.select([d.items.filter(i=>i.widget?.type==="todo")[n].id]);AtriumReviewNotes.open();
  },index);
  return page.locator("#review-notes-panel");
}
async function waitFor(page,expected) {
  await page.waitForFunction(expected=>{
    const h=AtriumNavHost,d=h.project().documents.find(x=>x.kind==="schematic"),r=globalThis.AtriumReviewComments;
    if(!r || !d)return false;
    const states=d.items.filter(i=>i.widget?.type==="todo").map(i=>r.thread(h.project(),i.widget.state.rows[0].threadId)?.status||"missing");
    return JSON.stringify(states)===JSON.stringify(expected);
  },expected,{timeout:16000});
}
async function main(){
  const {p,port}=await relay(),url="ws://127.0.0.1:"+port;
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try{
    const alice=await editor(browser,port,"Ada",url),bob=await editor(browser,port,"Ben",url),A=alice.page,B=bob.page;
    await Promise.all([A,B].map(page=>page.evaluate(()=>{globalThis.RTCPeerConnection=undefined;})));
    const [wa,wb]=await Promise.all([wire(A,port),wire(B,port)]);
    await A.evaluate(async()=>{
      const h=AtriumNavHost,p=Atrium.project("Collaborative review"),d=Atrium.sheet("schematic","Review sheet");p.documents=[d];
      await h.replaceProject(p,{force:true,copy:true,dirty:false});await AtriumLazy.need("AtriumReviewNotes");
      AtriumReviewNotes.place("reviewChecklist",[32,28],"Inspect return path");AtriumReviewNotes.place("reviewChecklist",[75,28],"Check sensor rail");AtriumReviewNotes.close();
    });
    if(process.env.NOTES_DEBUG)console.log("host data",await A.evaluate(()=>({name:AtriumNavHost.project().name,records:Object.keys(AtriumNavHost.project().review?.records||{}),items:AtriumNavHost.doc().items.map(i=>[i.kind,i.widget?.type])})));
    const invite=await A.evaluate(u=>AtriumCollabLive.start(u),url);
    await B.evaluate(v=>AtriumCollabLive.join(v),invite.text);
    await B.waitForFunction(()=>AtriumCollabLive.session()?.r);await row(B,1);await waitFor(B,["open","open"]);
    await A.waitForFunction(()=>AtriumCollabLive.peers().length>0);
    const first=await row(A,0),second=await row(B,1);
    wa.held=wb.held=true;
    await Promise.all([first.getByRole("checkbox",{name:"Inspect return path"}).check(),second.getByRole("checkbox",{name:"Check sensor rail"}).check()]);
    await Promise.all([A,B].map(x=>x.evaluate(()=>AtriumCollabLive.flush())));
    await waitFor(A,["resolved","open"]);await waitFor(B,["open","resolved"]);
    await new Promise(r=>setTimeout(r,160));assert(wa.waiting.length&&wb.waiting.length,"both browsers have independently encrypted outgoing packets");
    wa.release();wb.release();await Promise.all([A,B].map(x=>waitFor(x,["resolved","resolved"])));
    await A.evaluate(()=>AtriumNavHost.act("undo"));await Promise.all([A,B].map(x=>waitFor(x,["open","resolved"])));
    await A.evaluate(()=>AtriumNavHost.act("redo"));await Promise.all([A,B].map(x=>waitFor(x,["resolved","resolved"])));
    await (await row(A,0)).getByRole("button",{name:"Open in Comments",exact:true}).click();
    await A.locator(".rc-delete").click();await Promise.all([A,B].map(x=>waitFor(x,["missing","resolved"])));
    const bpanel=await row(B,1);await bpanel.getByRole("button",{name:"Open in Comments",exact:true}).click();
    await B.getByRole("textbox",{name:"Reply",exact:true}).fill("Verified against the drawing");
    await B.getByRole("button",{name:"Reply",exact:true}).click();
    await A.waitForFunction(()=>Object.values(AtriumNavHost.project().review.records).some(r=>r.type==="reply"));
    await A.evaluate(()=>AtriumNavHost.act("undo"));await Promise.all([A,B].map(x=>waitFor(x,["resolved","resolved"])));
    await B.evaluate(async()=>{AtriumCollabLive.leave();await AtriumNavHost.saveProject({as:true});AtriumNavHost.canvas().focus();});
    await B.evaluate(v=>AtriumCollabLive.join(v),invite.text);
    await B.waitForFunction(()=>AtriumCollabLive.session()?.r);await row(B,1);await waitFor(B,["resolved","resolved"]);
    const saved=x=>x.evaluate(()=>JSON.parse(JSON.stringify(AtriumNavHost.project().review)));
    assert.deepEqual(await saved(A),await saved(B));
    assert.equal(Object.values((await saved(B)).records).filter(r=>r.type==="reply").length,1);
    assert.deepEqual([...alice.errors,...bob.errors],[]);
    console.log("PASS two independent browser profiles over the local encrypted relay: simultaneous review resolutions, actor-only Undo/Redo, delete, independent reply, restore and reconnect.");
  } finally {await browser.close();p.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
