// Public WK/Chromium probe body. It runs after a real folder was adopted through File Open.
const H = globalThis.AtriumNavHost, session = H.folderProject();
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function wait(predicate) {
  for (const deadline = performance.now()+10000; performance.now()<deadline;) {
    if (await predicate()) return true;
    await delay(60);
  }
  return false;
}
const recover = () => [...document.querySelectorAll("dialog[open]")].find(d => d.textContent.includes("Recover private draft"));
const button = label => [...(recover()?.querySelectorAll("button") || [])].find(b=>b.textContent.trim()===label);
if (phase === "preferences") {
  const prefs=await AtriumLazy.need("AtriumPrefs"), start=session.draftMetrics();
  const change=text=>H.edit(()=>{H.doc().items[0].text=text;},"Change net label",null,{documents:[H.currentId()]});
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  prefs.set("general.autosave",false);
  change("DISABLED");
  await pause(1900); await session.flushDrafts();
  if (session.draftMetrics().writes!==0 || session.draftMetrics().pending) return {ok:false,reason:"disabled folder wrote a draft"};
  prefs.set("general.autosaveMinutes",10);
  prefs.set("general.autosave",true);
  if (!await wait(()=>session.draftMetrics().writes===1)) return {ok:false,reason:"enabling did not capture dirty work"};
  const savedAt=performance.now(), scheduled=[], nativeSet=globalThis.setTimeout;
  try {
    globalThis.setTimeout=(fn,ms,...args)=>{
      if (ms>=55000) scheduled.push(ms);
      return nativeSet(fn,ms,...args);
    };
    change("PERIODIC");
    prefs.set("general.autosaveMinutes",1);
  } finally { globalThis.setTimeout=nativeSet; }
  if (!scheduled.some(ms=>ms>595000 && ms<=600000) || !scheduled.some(ms=>ms>55000 && ms<=60000))
    return {ok:false,reason:"the normal Preferences change did not re-arm the expected timer",scheduled};
  await pause(56000);
  if (session.draftMetrics().writes!==1) return {ok:false,reason:"the periodic draft was early"};
  if (!await wait(()=>session.draftMetrics().writes===2)) return {ok:false,reason:"one-minute private draft missing"};
  const elapsedMs=Math.round(performance.now()-savedAt);
  change("CANCEL THIS UPDATE");
  prefs.set("general.autosave",false);
  await session.flushDrafts();
  return {ok:start.writes===0 && session.draftMetrics().writes===2 && !session.draftMetrics().pending &&
    session.dirty && elapsedMs>=59000 && elapsedMs<68000,elapsedMs,scheduled};
}
if (phase === "preferences-reopen") {
  const prefs=await AtriumLazy.need("AtriumPrefs");
  if (!await wait(recover) || prefs.get("general.autosave")!==false) return {ok:false,reason:"stored preference or private draft missing after restart"};
  const [offer]=await session.listDrafts();
  await session.resolveDraft(offer,"keep");
  const bundle=await AtriumFolderDrafts.storage.read(offer.head), text=bundle.rows[0].owner.items[0].text;
  button("Discard Draft")?.click();
  const cleared=await wait(async()=>!(await session.listDrafts()).length);
  prefs.reset(["general.autosave","general.autosaveMinutes"]);
  return {ok:text==="PERIODIC" && cleared && H.doc().items[0].text==="SENSE" &&
    !session.draftMetrics().pending && session.draftMetrics().writes===0,text,cleared};
}
if (phase === "preferences-save") {
  const prefs=await AtriumLazy.need("AtriumPrefs");
  const edit=text=>H.edit(()=>{H.doc().items[0].text=text;},"Edit during manual save",null,{documents:[H.currentId()]});
  prefs.set("general.autosave",true);
  edit("COVERED BY SAVE"); await session.flushDrafts();
  prefs.set("general.autosave",false);
  let revised=false;
  const off=session.on(event=>{
    if (event==="saving" && !revised) { revised=true; edit("LATER PRIVATE CHANGE"); }
  });
  try { await H.saveProject(); } finally { off(); }
  await session.flushDrafts();
  const {lease}=await AtriumHost.folderReadLease({grant:session.grant});
  let disk;
  try {
    const {files}=await AtriumHost.folderRead({grant:session.grant,lease,paths:["Power.wsch"]});
    disk=atob(files[0].data).trim().split("\n").map(line=>JSON.parse(line)).find(r=>r.kind==="netlabel").text;
  } finally { await AtriumHost.folderRelease({grant:session.grant,lease}); }
  const remaining=await new Promise((resolve,reject)=>{
    const open=indexedDB.open("waffle-folder-drafts");
    open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result, get=db.transaction("headers").objectStore("headers").getAll();
      get.onerror=()=>{db.close();reject(get.error);};
      get.onsuccess=()=>{db.close();resolve(get.result.filter(h=>h.projectId===H.project().id).length);};
    };
  });
  const working=H.doc().items[0].text, dirty=session.dirty;
  edit("SENSE"); await H.saveProject();
  prefs.reset(["general.autosave","general.autosaveMinutes"]);
  return {ok:revised && dirty && working==="LATER PRIVATE CHANGE" && disk==="COVERED BY SAVE" && remaining===0,disk,working,remaining};
}
if (phase === "edit") {
  const original = H.doc().items[0];
  const before = session.draftMetrics();
  const ownerId = H.currentId();
  const stage = await AtriumHost.folderStageAsset({grant:session.grant,ownerId,sourceToken,mediaType:"image/png"});
  const asset = session.stageAttachment({...stage,ownerId});
  H.edit(() => {
    original.text = "PRIVATE EDIT";
    H.doc().items.push({kind:"image",id:"draft-image",x:5,y:6,w:8,h:8,asset,name:"Selected original"});
  },"Add first sheet attachment",null,{documents:[ownerId]});
  const wrote = await wait(() => session.draftMetrics().writes > 0);
  return {ok:before.writes===0 && wrote && H.isDirty() && session.dirty,stats:session.draftMetrics(),text:original.text};
}
if (phase === "saved") {
  await delay(1800);
  return {ok:!recover() && !H.isDirty() && H.doc().items[0].text==="PRIVATE EDIT",offers:(await session.listDrafts()).length};
}
if (!await wait(recover)) return {ok:false,diagnostic:JSON.stringify({presented:session.metrics().firstPresented,visibility:document.visibilityState,
  status:document.querySelector("#status")?.textContent,dialogs:[...document.querySelectorAll("dialog[open]")].map(d=>d.textContent.slice(0,120)),
  offers:(await session.listDrafts()).map(x=>x.state)})};
const label = {save:"Restore Draft",keep:"Keep for Later",discard:"Discard Draft",separate:"Open as Separate Copy"}[phase];
const action = button(label);
if (!action) return {ok:false,reason:"Missing "+label,dialog:recover().textContent};
action.click();
if (phase === "save") {
  if (!await wait(() => H.isDirty() && H.doc().items[0].text==="PRIVATE EDIT")) return {ok:false,reason:"Restore did not apply the working edit.",status:document.querySelector("#status")?.textContent};
  const image = H.doc().items.find(i=>i.id==="draft-image");
  if (!image?.asset) return {ok:false,reason:"Recovered attachment is missing"};
  const read = await session.readAsset({ownerId:H.currentId(),assetRef:image.asset,purpose:"draft verification"});
  if (AtriumFolderDrafts.base64(read.bytes)!=="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=")
    return {ok:false,reason:"Recovered original bytes differ"};
  H.act("undo");
  if (!await wait(()=>H.doc().items.length===1 && H.doc().items[0].text==="SENSE")) return {ok:false,reason:"Restore did not undo as one edit"};
  H.act("redo");
  if (!await wait(()=>H.doc().items.some(i=>i.id==="draft-image"))) return {ok:false,reason:"Redo did not restore attachment"};
  await H.saveProject({all:true}); await session.flushDrafts();
  return {ok:!H.isDirty() && !session.dirty,hash:image.asset.sha256,offers:(await session.listDrafts()).length};
}
if (phase === "separate") {
  const opened = await wait(() => !H.folderProject() && H.doc().items[0]?.text==="PRIVATE EDIT");
  const image = H.doc().items.find(i=>i.id==="draft-image");
  return {ok:opened && H.isDirty() && H.project().documents.length===1 && image?.src?.startsWith("data:image/png;base64,iVBOR")===true,
    detail:JSON.stringify({opened,name:H.project().name,count:H.project().documents.length,status:document.querySelector("#status")?.textContent,
      dialogs:[...document.querySelectorAll("dialog[open]")].map(d=>d.textContent.slice(0,100))})};
}
await wait(() => !recover());
const offers = await session.listDrafts();
return {ok:(phase==="discard" ? offers.length===0 : offers.length>0) && !session.dirty,offers:offers.length};
