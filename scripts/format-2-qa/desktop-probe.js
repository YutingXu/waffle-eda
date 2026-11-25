"use strict";
// Runs inside the shipping editor. Output contains numeric observations and aggregate counts only.
const h = AtriumNavHost;
const native = (op, detail = {}) => webkit.messageHandlers.formatBenchmark.postMessage({op, ...detail});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const clock = () => performance.now();
function check(ok, message) { if (!ok) throw Error(message); }
async function until(test, note, timeout = 45000) {
  const limit = clock() + timeout;
  while (!test()) { if (clock() > limit) throw Error(note); await wait(10); }
}
async function bounded(job, note, ms = 90000) {
  let timer;
  try {
    return await Promise.race([job, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(note)), ms); })]);
  } finally { clearTimeout(timer); }
}
function reads(map, allowed = null) {
  let opens = 0, bytes = 0, outsideOpens = 0, outsideBytes = 0;
  for (const [path, data] of Object.entries(map)) {
    opens += data.opens ?? 0;
    bytes += data.bytes ?? 0;
    if (allowed && !allowed.has(path)) {
      outsideOpens += data.opens ?? 0;
      outsideBytes += data.bytes ?? 0;
    }
  }
  return {opens, bytes, outsideOpens, outsideBytes};
}
await until(() => document.visibilityState === "visible", "No native rendering opportunity", 4000);
AtriumPower.host({occluded: false});
const start = await AtriumLazy.need("AtriumStartPage");
start.open({launch: true});
document.querySelector("dialog.sp-dialog[open] [data-start-action=close]").click();
await frame(); await frame();
const starter = h.project();
let renderCalls = 0, frameCalls = 0;
const errors = [];
const notice = e => { const detail = e.message || e.reason?.message || ""; if (detail && errors.length < 4) errors.push(String(detail)); };
window.addEventListener("error", notice, true);
window.addEventListener("unhandledrejection", notice);
let begin, adopted, painted, visibleSnapshot, rendered = false, resolvePaint, rejectPaint;
let completeWhenPresented = false;
const visible = new Promise((resolve, reject) => { resolvePaint = resolve; rejectPaint = reject; });
const offModel = h.on("replace", () => { if (h.project() !== starter && adopted === undefined) adopted = clock() - begin; });
const offRender = h.addRenderer((doc, info) => {
  renderCalls++;
  if (h.project() !== starter && info.active && doc.id === h.currentId() && doc.items.length) rendered = true;
});
let requested = false;
const offFrame = h.on("frame", () => {
  frameCalls++;
  if (!rendered || requested) return;
  requested = true;
  native("present").then(snapshot => {
    painted = clock() - begin;
    visibleSnapshot = snapshot;
    if (trial.mode === "ready-open") completeWhenPresented = h.folderProject()?.completeFor("project") === true;
    resolvePaint();
  }).catch(rejectPaint);
});
begin = clock();
await native("open");
const status = document.getElementById("status");
const problems = new MutationObserver(() => {
  const hint = status?.textContent || "";
  if (!h.folderProject?.() && /fail|invalid|undefined|unsupported|unavailable|not a function|could not|couldn.t|missing|expired|worker error/i.test(hint))
    rejectPaint(Error("Folder Open reported " + hint));
});
if (status) problems.observe(status, {subtree:true, childList:true, characterData:true});
try {
  await bounded(visible, "No active project presentation", trial.openTimeout ?? 22000);
} catch (error) {
  const hint = status?.textContent || "";
  const folder = h.folderProject?.();
  throw Error(error.message + " · current editor status " + hint + " · " + JSON.stringify({
    adopted, renderCalls, frameCalls, rendered, requested, activeItems:h.doc?.()?.items?.length,
    session:!!folder, firstPresented:folder?.metrics().firstPresented, currentMatches:folder?.activeId === h.currentId(),
    power:AtriumPower.state(), dialogs:document.querySelectorAll("dialog[open]").length, errors
  }));
} finally {
  offModel(); offRender(); offFrame(); problems.disconnect();
  window.removeEventListener("error", notice, true); window.removeEventListener("unhandledrejection", notice);
}
const session = h.folderProject();
check(session && !h.isStarter() && (trial.mode === "draft-reopen" || !document.querySelector("dialog[open]")) && h.canvas().clientWidth > 0, "The opened editor is unusable");
const p = h.project();
async function waitForApply() {
  const start = clock();
  while (clock() - start < 15000) {
    const state = await AtriumHost.folderStatus({grant:session.grant});
    if (state.state === "settled") return;
    check(state.state === "applying" || state.state === "pending" || state.state === "saving" || state.state === "recoveryPending",
      "The saved project reported " + state.state);
    await wait(10);
  }
  throw Error("The committed working files did not finish applying");
}
const allowed = new Set(trial.visiblePaths ?? [session.manifestPath, session.getDocumentRef(h.currentId()).path]);
const first = reads(visibleSnapshot.reads, allowed);
const out = {firstPaintMs: painted, adoptedMs: adopted ?? null, firstRSS: visibleSnapshot.memory.peakRSSBytes,
  firstRSSSamples: visibleSnapshot.memory.samples, visibleIO: trial.stockWriter ? null : first, activeItems: h.doc().items.length,
  activeKind: h.doc().kind, unroutedVisible:h.showUnrouted?.(),
  stockWriter:!!trial.stockWriter,
  physicalVisibleIO:!trial.stockWriter && visibleSnapshot.physical ? reads(visibleSnapshot.physical,allowed) : null};
if (trial.mode === "scale") { await native("finishOpen"); return out; }
// This explicit full-model endpoint is distinct from first presentation and from a naturally drained idle queue.
const initialComplete = session.completeFor("project");
if (!initialComplete) await bounded(session.requireClosure({purpose: "project"}), "Full project hydration did not finish");
const liveGeometryMs = clock() - begin;
function checkedGeometry() {
  check(session.completeFor("project"), "The complete native model was not adopted");
  const documents = h.project().documents;
  const sizes = documents.map(doc => doc.items.length);
  if (trial.itemsByDocument) {
    const ids = Object.keys(trial.itemsByDocument);
    check(ids.length === documents.length && documents.every(doc => trial.itemsByDocument[doc.id] === doc.items.length),
      "Loaded item counts differ from the verified owner documents");
  } else if (trial.items) {
    const expected = [...trial.items].sort((a, b) => a - b);
    check(JSON.stringify(expected) === JSON.stringify([...sizes].sort((a, b) => a - b)),
      "Loaded item counts differ from the frozen source");
  }
  return {documents: documents.length, items: sizes.reduce((n, size) => n + size, 0)};
}
if (trial.mode === "ready-open") {
  if (trial.activeId) check(h.currentId() === trial.activeId, "The visible document differs from the verified manifest");
  if (trial.activeKind) check(out.activeKind === trial.activeKind, "The visible document kind differs from the verified manifest");
  if (trial.activeItems != null) check(out.activeItems === trial.activeItems, "The populated frame used an unexpected document");
  const geometry = checkedGeometry();
  const ready = await native("finishOpen");
  // When every owner is already present at the first acknowledgement, that observation
  // bounds when the geometry became available. No earlier completion event was observed.
  const fullAtPresentation = initialComplete && completeWhenPresented;
  const geometryReady = fullAtPresentation ? painted : liveGeometryMs;
  return {...out, ...geometry, liveGeometryMs:geometryReady, mode:trial.mode, readyToEditMs:Math.max(painted, geometryReady),
    readyRSS:ready.peakRSSBytes, readyRSSSamples:ready.samples, fullAtPresentation};
}
let verifiedModelMembers = 0, fullValidationError = null;
if (trial.models || trial.assetBytes) {
  // The ordinary live geometry request omits embedded model bytes. Use the actual bounded
  // saved snapshot reader in its worker, including gzip framing, inflation and raw identity.
  try {
    const verified = await bounded(session.requireClosure({purpose:"project",saved:true,assets:true}),
    "Full model and attachment verification did not finish");
  verifiedModelMembers = verified.members.filter(member => member.path.startsWith("models/")).length;
  check(verifiedModelMembers === (trial.models || 0), "The explicit closure omitted a frozen model");
    check(typeof verified.version === "string" && verified.version.length === 64, "The full closure was not verified");
  } catch (error) {
    // The visible editor can still be exercised. A rejected closure has no successful full time.
    fullValidationError = /duplicate live object id/i.test(error.message) ? "duplicate-live-id" : "unverified-closure";
    verifiedModelMembers = null;
  }
}
const fullAttemptMs = clock() - begin;
const fullMs = fullValidationError ? null : fullAttemptMs;
const full = await native("finishOpen");
Object.assign(out, {editMode:trial.edit ?? null, mode:trial.mode, fullMs, fullRSS: full.peakRSSBytes, fullRSSSamples: full.samples,
  liveGeometryMs, verifiedModelMembers, fullValidationError, failedFullMs:fullValidationError ? fullAttemptMs : null,
  fullAtPresentation:initialComplete && !trial.models && !trial.assetBytes, ...checkedGeometry()});
if (trial.mode === "open") return out;
if (trial.mode === "draft-create" || trial.mode === "draft-reopen") {
  const H = AtriumHost, child = trial.owner === "child";
  const existing = p.documents.find(d => d.kind === "schematic");
  const recovery = () => [...document.querySelectorAll('dialog[open]')].find(d=>d.textContent.includes("Recover private draft"));
  const rowFor = model => model.documents.flatMap(doc => doc.items.filter(i => i.kind === "image" && i.name === "QA selection").map(item=>({doc,item})))[0];
  if (trial.mode === "draft-create") {
    await h.selectDocument(existing.id);
    if (child) {
      h.act("add-schematic");
      await until(()=>document.querySelector('dialog[open] input[aria-label="Add schematic sheet"]'),"Missing new sheet dialog");
      const field = document.querySelector('dialog[open] input[aria-label="Add schematic sheet"]');
      field.value = "QA recovered child"; field.form.requestSubmit();
      await until(()=>h.doc().id !== existing.id && h.doc().kind === "schematic","New child was not selected");
    }
    const doc = h.doc(), picked = await H.folderPickAsset({grant:session.grant,ownerId:doc.id,mediaTypes:["image/png"]});
    const stage = await H.folderStageAsset({grant:session.grant,ownerId:doc.id,sourceToken:picked.sourceToken,mediaType:"image/png"});
    check(stage?.assetToken && stage.ownerId === doc.id,"Native staging failed");
    const row = {kind:"image",id:Atrium.id(),asset:stage.assetRef,x:7,y:9,w:2,h:1,extent:[2,1],name:"QA selection"};
    const start = clock(), previous = session.draftMetrics().writes;
    h.edit(()=>{ session.stageAttachment(stage); doc.items.push(row); },"Place image for restart",[row]);
    await until(()=>session.draftMetrics().writes > previous && !session.draftMetrics().pending,"Normal edit did not reach the private recovery store",26000);
    await native("formatObserve",{checkpoint:1,observation:{naturalDraftMs:clock()-start,dirty:session.modified(doc.id),bytes:row.asset.byteLength}});
    let saved=false;
    try { saved=await h.saveProject(); } catch {}
    check(!saved && session.modified(doc.id) && h.isDirty(),"Failed precommit Save cleared a revision or reported success");
    await native("formatObserve",{checkpoint:2,observation:{dirtyAfterFailedSave:true,previewBytes:(await session.readAsset({ownerId:doc.id,assetRef:row.asset,purpose:"preview"})).bytes.length}});
    throw Error("The test process should have been killed by its independent observer");
  }
  if (trial.decision === "none") {
    const offers = await session.listDrafts();
    check(!offers.length && !h.isDirty() && !recovery(),"A discarded draft returned on the next open");
    return {clean:true,draftCount:offers.length};
  }
  await until(recovery,"The normal reopened folder did not offer a private recovery draft",15000);
  const offers=await session.listDrafts();
  check(offers.length===1 && !h.isDirty(),"The committed state was not separate from the draft");
  const offered=offers[0], decision=trial.decision;
  const label={keep:"Keep for Later",separate:"Open as Separate Copy",restore:"Restore Draft",discard:"Discard Draft"}[decision];
  const button=[...recovery().querySelectorAll("button")].find(b=>b.textContent===label);
  check(button,"The actual recovery UI did not offer "+label);
  button.click();
  if(decision==="keep"){
    await until(()=>!recovery(),"Recovery choice did not close");
    return {keptDraft:true,dirty:h.isDirty(),state:offered.state,ownerCount:offered.head.rows.length,assetCount:offered.head.assets.length};
  }
  if(decision==="discard"){
    await until(()=>!recovery(),"Discard did not close the recovery dialog");
    const deadline=clock()+5000;
    while ((await session.listDrafts()).length && clock()<deadline) await wait(25);
    check(!(await session.listDrafts()).length,"Discard did not clear the private draft");
    return {discarded:true,dirty:h.isDirty()};
  }
  await until(()=>!!rowFor(h.project()) && h.isDirty(),"Recovery did not restore the selected unsaved image",15000);
  const {doc,item}=rowFor(h.project());
  const separate=decision==="separate";
  const response={state:offered.state,recovered:true,separate,ownerCount:offered.head.rows.length,assetCount:offered.head.assets.length};
  if(separate){
    check(!h.folderProject(),"A changed-base draft overwrote its opening folder");
    const encoded=item.src?.split(",")[1];
    check(encoded,"The separate copy lost its newly attached original");
    const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    const hash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
    check(bytes.length===item.asset.byteLength && hash===item.asset.sha256,"The separate copy's recovered original differs");
    return {...response,recoveredBytes:bytes.length};
  }
  check(session===h.folderProject(),"Matching recovery lost the current grant");
  const restored=await session.readAsset({ownerId:doc.id,assetRef:item.asset,purpose:"preview"});
  check(restored.bytes.length===item.asset.byteLength && restored.bytes[0]===137,"The original staged blob was not readable on the new grant");
  await native("formatObserve",{checkpoint:3,observation:{restoredBytes:restored.bytes.length,dirty:h.isDirty()}});
  await h.selectDocument(doc.id);
  check(await h.saveProject(),"Explicit Save of the recovered draft failed");
  await waitForApply();
  response.recoveredBytes=restored.bytes.length;
  response.committedFiles=session.metrics().lastSave.paths.length;
  check(response.committedFiles===(child?3:2),"Recovered active owner did not commit its complete dependency set");
  return response;
}
if (trial.mode === "attachment") {
  const H = AtriumHost, imageUI = await AtriumLazy.need("AtriumNotebookImageUI");
  const other = p.documents.find(d => d.kind === "pcb");
  const label = other?.items.find(i => i.kind === "part" && Number.isFinite(i.x));
  const existing = p.documents.find(d => d.kind === "schematic");
  check(other && label && existing, "The fixture has no editable sheet and independent board");
  const otherPath = session.getDocumentRef(other.id).path;
  async function readMembers(paths) {
    const {lease} = await H.folderReadLease({grant:session.grant});
    try {
      const answer = await H.folderRead({grant:session.grant,lease,paths});
      return new Map(answer.files.map(f => [f.path,f]));
    } finally { await H.folderRelease({grant:session.grant,lease}); }
  }
  const original = await readMembers([session.manifestPath,otherPath]);
  await h.selectDocument(other.id);
  h.edit(() => { label.x += .127; }, "Leave independent board edit unsaved", [label.id],
    {documents:[other.id],items:[label.id]});
  check(session.modified(other.id), "Independent edit lost its dirty revision");
  await h.selectDocument(existing.id);
  if (trial.edit === "child") {
    h.act("add-schematic");
    await until(() => document.querySelector('dialog[open] input[aria-label="Add schematic sheet"]'), "No new sheet dialog");
    const input = document.querySelector('dialog[open] input[aria-label="Add schematic sheet"]');
    input.value = "New QA sheet";
    input.form.requestSubmit();
    await until(() => h.doc().id !== existing.id && h.doc().kind === "schematic","The new sheet was not active");
    check(!session.getDocumentRef(h.currentId()),"New child already appears in the saved manifest");
  }
  const doc = h.doc(), first = await imageUI.insert({host:h,source:"image",point:[7,9]});
  check(first?.asset?.sha256 && doc.items.includes(first), "Normal Insert Image did not make the selected placement");
  const raw = await session.readAsset({ownerId:doc.id,assetRef:first.asset,purpose:"preview"});
  check(raw.bytes.length === first.asset.byteLength && raw.bytes[0] === 137, "The staged preview has the wrong bytes");
  const expectedBlob = "assets/"+first.asset.sha256, wasChild = trial.edit === "child";
  const start = clock();
  check(await h.saveProject(),"Normal active-sheet Save failed");
  const firstSavedMs = clock() - start, firstReceipt = session.metrics().lastSave;
  const owner = session.getDocumentRef(doc.id)?.path;
  const scope = {ownerInReceipt:!!owner && firstReceipt.paths.includes(owner), assetInReceipt:firstReceipt.paths.includes(expectedBlob),
    manifestInReceipt:firstReceipt.paths.includes(session.manifestPath), otherInReceipt:firstReceipt.paths.includes(otherPath)};
  if (!scope.ownerInReceipt || !scope.assetInReceipt || scope.manifestInReceipt !== wasChild || scope.otherInReceipt) {
    await waitForApply();
    return {...out, addedChild:wasChild, firstCommitScopePass:false, sourceBytes:first.asset.byteLength, firstFiles:firstReceipt.paths.length,
      firstSavedMs, scope, stagedBytes:(await native("formatSaveOps")).stagedBytes, otherStayedDirty:session.modified(other.id)};
  }
  check(firstReceipt.paths.length === (wasChild ? 3 : 2) && firstReceipt.paths.includes(session.manifestPath) === wasChild,
    "First Save included the wrong membership or owner set");
  check(session.modified(other.id) && !session.modified(doc.id),"First acknowledgement cleared the wrong dirty cursor");
  await waitForApply();
  const firstWork = await native("formatSaveOps");
  const now = await readMembers([owner,session.manifestPath,otherPath,expectedBlob]);
  check(now.get(expectedBlob).sha256 === first.asset.sha256 && now.get(expectedBlob).length === raw.bytes.length,
    "The installed image differs from its staged source");
  check(now.get(otherPath).sha256 === original.get(otherPath).sha256,"Unrelated dirty board reached disk");
  check((now.get(session.manifestPath).sha256 !== original.get(session.manifestPath).sha256) === wasChild,
    "Durable manifest did not match child membership");
  const verified = await session.readAsset({ownerId:doc.id,assetRef:first.asset,purpose:"preview"});
  check(verified.bytes.every((n,i) => n === raw.bytes[i]),"Saved attachment differs from the staged source");
  const next = await imageUI.insert({host:h,source:"image",point:[15,20]});
  check(next?.asset?.sha256 === first.asset.sha256 && next.id !== first.id,"Reference-only placement failed");
  const secondStart = clock();
  check(await h.saveProject(),"Reference-only save failed");
  const secondSavedMs = clock() - secondStart, secondReceipt = session.metrics().lastSave;
  check(secondReceipt.paths.length === 1 && secondReceipt.paths[0] === owner,"Previously saved bytes entered a second transaction");
  await waitForApply();
  const secondWork = await native("formatSaveOps");
  const onDisk = await readMembers([owner]);
  const ownerText = new TextDecoder().decode(Uint8Array.from(atob(onDisk.get(owner).data),c => c.charCodeAt(0)));
  const placements = ownerText.trimEnd().split("\n").map(JSON.parse).filter(i=> i.asset?.sha256 === first.asset.sha256);
  check(placements.length === 2 && session.modified(other.id) && !session.modified(doc.id),"Second Save changed the wrong design state");
  return {...out, addedChild:wasChild, firstCommitScopePass:true, scope, sourceBytes:first.asset.byteLength, renderedWidth:first.extent[0], renderedHeight:first.extent[1],
    stagesVerified:true, savedPlacements:placements.length, unrelatedDirtyAndDiskUnchanged:true,
    firstFiles:firstReceipt.paths.length, firstSavedMs, firstStaged:firstWork.stagedBytes, firstAckToClearMs:firstWork.ackToClearedMs,
    laterFiles:secondReceipt.paths.length,laterSavedMs:secondSavedMs,laterStaged:secondWork.stagedBytes,laterAckToClearMs:secondWork.ackToClearedMs};
}
if (trial.mode === "undo") {
  const doc = p.documents.find(d => d.kind === "schematic" && d.items.some(i => i.kind === "netlabel"));
  const item = doc?.items.find(i => i.kind === "netlabel");
  check(item, "No label for the in-flight Undo");
  await h.selectDocument(doc.id); await frame();
  const original = item.text;
  const owner = session.getDocumentRef(doc.id).path;
  async function storedLabel() {
    const lease = await AtriumHost.folderReadLease({grant:session.grant});
    try {
      const result = await AtriumHost.folderRead({grant:session.grant, lease:lease.lease, paths:[owner]});
      const bytes = Uint8Array.from(atob(result.files[0].data), c => c.charCodeAt(0));
      const lines = new TextDecoder().decode(bytes).trimEnd().split("\n").map(s => JSON.parse(s));
      return lines.find(r => r.id === item.id).text;
    } finally { await AtriumHost.folderRelease({grant:session.grant, lease:lease.lease}); }
  }
  check(await storedLabel() === original, "The fresh saved label differs");
  h.edit(() => { item.text += "_PENDING"; }, "Edit label during save", [item.id], {documents:[doc.id],items:[item.id]});
  await native("formatArm");
  const saving = h.saveProject();
  try {
    check(await native("formatWait"), "The native writer did not enter staged file I/O");
    h.act("undo");
    const live = h.project().documents.find(d => d.id === doc.id)?.items.find(i => i.id === item.id);
    check(live?.text === original, "Undo did not change the actual editor object");
  } finally { await native("formatResume"); }
  check(await saving && session.modified(doc.id) && h.isDirty(), "The first acknowledgement incorrectly cleared the concurrent Undo");
  await waitForApply();
  check(await storedLabel() === original + "_PENDING", "The first acknowledged bytes did not match the captured edit");
  check(await h.saveProject() && !session.modified(doc.id) && !h.isDirty(), "The inverse edit was not saved");
  await waitForApply();
  check(await storedLabel() === original,
    "The second acknowledgement did not save the undone value");
  return {...out, capturedFirstSave:true, undoStayedDirty:true, restoredAfterNextSave:true};
}
if (trial.mode === "idle") {
  const originalId = h.currentId();
  if (trial.power === "rapid") {
    for (let i = 0; i < trial.switches; i++) { h.selectDocument(p.documents[i % p.documents.length].id); await frame(); }
    h.selectDocument(originalId); await frame();
  } else if (trial.power === "hidden") {
    await native("formatWindow", {visible: false});
    await until(() => !AtriumPower.visible(), "Native hide was not received");
  } else if (trial.power === "lowPower") {
    AtriumPower.setMode("auto");
    window.dispatchEvent(new CustomEvent("atrium-power", {detail: {lowPower: true, occluded: false}}));
    check(AtriumPower.efficient(), "The host low-power notification was not applied");
  }
  // Drain the already scheduled tail of the foreground queue before the idle observation.
  const prelude = session.metrics();
  await wait(1500);
  const beforeMetrics = session.metrics();
  const startRSS = await native("formatIdleRSS");
  let watcherEvents = 0;
  const onWatch = event => { if (event.detail?.grant === session.grant) watcherEvents++; };
  window.addEventListener("folderChanged", onWatch);
  const beforeReads = reads(await native("formatReadCounts"));
  const from = clock();
  await wait(60000);
  const idleMs = clock() - from;
  window.removeEventListener("folderChanged", onWatch);
  const endRSS = await native("formatIdleRSS");
  const afterReads = reads(await native("formatReadCounts"));
  const afterMetrics = session.metrics();
  Object.assign(out, {idleMs, startRSS, endRSS, watcherEvents, settlingCallbacks:beforeMetrics.idleCallbacks - prelude.idleCallbacks, idleReads: afterReads.opens - beforeReads.opens, idleBytes: afterReads.bytes - beforeReads.bytes,
    hydrationSlices:afterMetrics.hydrationSlices ?? null,
    idleCallbacks: Number.isFinite(afterMetrics.idleCallbacks) ? afterMetrics.idleCallbacks - beforeMetrics.idleCallbacks : null,
    loadedBefore: beforeMetrics.loaded.length, loadedAfter: afterMetrics.loaded.length, power: trial.power,
    sameActive: h.currentId() === originalId, lowPower: AtriumPower.state().lowPower, visible: AtriumPower.visible()});
  return out;
}
function auditItems(project, active, selected) {
  const restore = [], counts = {instrumented:0, allReads:0, editorSaveReads:0, distinctEditorSaveReads:0};
  const visited = new Set(), attributed = new Map();
  let synchronous = false;
  function observe(array, kind, relevant) {
    for (let i = 0; i < array.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(array, String(i));
      let value = descriptor?.value;
      if (!descriptor || !descriptor.configurable || !Object.hasOwn(descriptor, "value") || relevant(value)) continue;
      counts.instrumented++;
      const token = counts.instrumented;
      Object.defineProperty(array, i, {
        configurable:true, enumerable:descriptor.enumerable,
        get() {
          counts.allReads++;
          const stack = new Error().stack ?? "";
          if (synchronous || /folder-project(?:-ui)?\.js|\bsaveProject@|\bsave@.*editor\.js/.test(stack)) {
            counts.editorSaveReads++;
            visited.add(token);
            // Keep only application script basenames/line numbers, never project paths or object data.
            const frames = [...stack.matchAll(/(?:^|\/)([a-z][a-z0-9-]+\.js:\d+:\d+)/gmi)].map(match => match[1]).slice(0, 8);
            const signature = [kind, ...frames].join(" ");
            attributed.set(signature, (attributed.get(signature) || 0) + 1);
          }
          return value;
        }, set(next) { value = next; }
      });
      restore.push(() => Object.defineProperty(array, i, {...descriptor, value}));
    }
  }
  for (const doc of project.documents) observe(doc.items, "item", item => item === selected);
  observe(project.documents, "document", doc => doc === active);
  return {counts,synchronous(on){synchronous=on;}, restore(){
    for (const done of restore) done();
    counts.distinctEditorSaveReads = visited.size;
    counts.sourceLocations = [...attributed.entries()].slice(0, 12);
  }};
}
const selection = WaffleBaselineEdits.select(p, {kicadGlobalLabel: !!trial.globalLabel});
let target = selection[trial.edit];
if (trial.sheetPart) {
  const doc = p.documents.find(d => d.kind === "schematic" && d.items.some(i => i.kind === "part" && Number.isFinite(i.x) && Number.isFinite(i.y)));
  const item = doc?.items.find(i => i.kind === "part" && Number.isFinite(i.x) && Number.isFinite(i.y));
  target = {doc, item};
}
check(target?.item, "No item for the intended edit");
await h.selectDocument(target.doc.id);
if (trial.verifySaves && !h.showUnrouted()) h.act("unrouted");
await frame();
if (trial.verifySaves) {
  check(h.doc() === target.doc && target.doc.kind === "pcb" && h.showUnrouted() && AtriumPower.visible(),
    "The Save benchmark needs the active PCB and visible connectivity overlay");
}
if (trial.nativeSaveKey) h.canvas().focus({preventScroll:true});
const def = trial.edit === "part" ? p.library.find(d => d.id === target.item.def) : null;
const sourceTrack = trial.edit === "track" ? structuredClone(target.item) : null;
// Align the browser and native monotonic clocks before timing, using the least-delayed reply.
// The half round trip (plus WebKit's timer resolution) bounds the reported apply endpoint.
let offset = 0, shortest = Infinity;
for (let pair = 0; pair < 7; pair++) {
  const start = clock(), nativeMs = await native("formatClock"), end = clock();
  if (end - start < shortest) { shortest = end - start; offset = (start + end) / 2 - nativeMs; }
}
out.clockBoundMs = 1 + shortest / 2;
out.saves = [];
for (let n = 1; n <= trial.saves; n++) {
  const item = sourceTrack ? {...sourceTrack, id: n === 1 ? sourceTrack.id : sourceTrack.id + "-" + n} : target.item;
  // Memory trials have their own process and start the sampler before the edit can schedule rendering.
  const beforeEditRSS = trial.saveRSS ? await native("formatBeginSaveRSS") : null;
  h.edit(() => {
    if (trial.edit === "part") Atrium.transformPart(target.doc, item, def, {x: item.x + WaffleBaselineEdits.MOVE_MM});
    else if (trial.edit === "label") item.text += WaffleBaselineEdits.LABEL_SUFFIX;
    else target.doc.items.push(item);
  }, "Benchmark edit", [item.id], {documents:[target.doc.id], items:[item.id]});
  check(h.isDirty() && session.modified(target.doc.id), "The real edit did not dirty the active owner");
  if (trial.nativeSaveKey) {
    await frame();
    h.canvas().focus({preventScroll:true});
  }
  // This slow, independent diagnostic runs in its own process and contributes no timing samples.
  // Indexed getters retain array and object identity. Read stacks separate editor Save from a
  // concurrently running paint, and also count any immediate unclassified command access.
  const visitTrace = trial.readAudit ? auditItems(p, target.doc, item) : null;
  let receiptAt, cleanAt, cleanSeen, saved, nativeKeyHandled = false, trusted = false, consumed = false;
  const notified = trial.nativeSaveKey ? new Promise(resolve => { saved = resolve; }) : null;
  const complete = () => {
    if (receiptAt !== undefined && cleanAt !== undefined) {
      cleanSeen = Math.max(receiptAt, cleanAt);
      saved?.(true);
    }
  };
  const offSave = session.on(kind => {
    if (kind === "saved" && !session.modified(target.doc.id)) {
      receiptAt = clock();
      if (!h.isDirty()) cleanAt ??= receiptAt;
      complete();
    }
  });
  const offDirty = h.on("dirty", value => {
    if (value === false) {
      cleanAt = clock();
      complete();
    }
  });
  const observeKey = event => {
    if (event.key.toLowerCase() === "s" && event.metaKey) {
      trusted ||= event.isTrusted;
      queueMicrotask(() => { consumed ||= event.defaultPrevented; });
    }
  };
  if (trial.nativeSaveKey) window.addEventListener("keydown", observeKey, true);
  let t = clock();
  let ok;
  try {
    if (trial.nativeSaveKey) {
      t = await native("formatSaveKey", {delivery:trial.nativeKeyDelivery || "web"}) + offset;
      nativeKeyHandled = true;
      try {
        ok = await bounded(notified, "Command-S did not finish the ordinary editor Save", 12000);
      } catch (error) {
        throw Error(error.message + " " + JSON.stringify({trusted, consumed, receipt:receiptAt !== undefined,
          clean:cleanAt !== undefined, dirty:h.isDirty(), targetDirty:session.modified(target.doc.id),
          status:status?.textContent, modal:!!document.querySelector("dialog[open]"),
          pending:session.metrics().pendingSave, active:h.doc() === target.doc}));
      }
      check(trial.nativeKeyDelivery === "menu" || trusted, "Command-S did not reach the editor as a trusted key");
    } else {
      if (visitTrace) visitTrace.synchronous(true);
      const saving = h.saveProject();
      if (visitTrace) visitTrace.synchronous(false);
      ok = await saving;
    }
  } finally {
    if (trial.nativeSaveKey) window.removeEventListener("keydown", observeKey, true);
    offDirty();
    offSave();
    visitTrace?.restore();
  }
  const commandCompletionMs = clock() - t;
  check(Number.isFinite(cleanSeen), "The native Save did not notify a clean active owner");
  const savedMs = cleanSeen - t;
  check(ok && !h.isDirty() && !session.modified(target.doc.id), "Regular Save did not acknowledge the edit");
  const receipt = session.metrics().lastSave;
  check(receipt?.transaction && receipt.paths.length === 1 && receipt.paths[0] === session.getDocumentRef(target.doc.id).path,
    "Regular Save changed a file outside its active owner");
  await waitForApply();
  const observedSettleMs = clock() - t;
  const saveRSS = trial.saveRSS ? await native("formatEndSaveRSS") : null;
  const nativeOps = await native("formatSaveOps");
  const metric = (key) => typeof receipt[key] === "number" ? receipt[key] : null;
  const clockMetric = value => Number.isFinite(value) ? value + offset - t : null;
  out.saves.push({n, audit:visitTrace?.counts, savedMs, nativeKeyHandled,
    beforeEditRSS, peakEditSaveRSS:saveRSS?.peakRSSBytes, editSaveRSSSamples:saveRSS?.samples,
    appliedMs:clockMetric(nativeOps.clearUptimeMs), nativeDurableMs:clockMetric(nativeOps.ackUptimeMs),
    nativeBeforeStageMs:clockMetric(nativeOps.stageUptimeMs), commandCompletionMs, observedSettleMs, actualAckToClearedMs: nativeOps.ackToClearedMs,
    editorMs: metric("editorMs"), rowsEncoded: metric("rowsEncoded"), unrelatedVisits: metric("unrelatedVisits"),
    transferBytes: metric("transferBytes"), bridgeJSONBytes:trial.stockWriter ? null : nativeOps.bridgeJSONBytes,
    stagedBytes:trial.stockWriter ? null : nativeOps.stagedBytes, steps:trial.stockWriter ? null : nativeOps.steps,
    splices: receipt.splices, paths: receipt.paths.length});
  if (trial.verifySaves) {
    const observation = {path:receipt.paths[0], transaction:receipt.transaction, id:item.id,
      at:[Math.round(item.x * 1e6), Math.round(item.y * 1e6)]};
    await native("formatObserve", {checkpoint:n, observation});
  } else if (trial.git) await native("formatObserve", {checkpoint: n});
}
if (trial.finalOverlay) {
  const board = target.doc, view = h.view(), state = view.internals();
  // Check the overlay after the final physical checkpoint, outside all timed saves.
  await AtriumLazy.need("AtriumConnectivityLive");
  await frame();
  const inspect = defs => AtriumConnectivity.inspectFull(Atrium.clone(board),defs);
  const graph = defs => {
    const revision = state.sync(board,defs).rev, cached = state.connectivity;
    return cached?.doc === board && cached.rev === revision ? cached.result : null;
  };
  const initial = h.defs();
  if (!graph(initial) && inspect(initial).nets.length) {
    await until(() => graph(h.defs()), "The visible PCB connectivity overlay did not catch up", 30000);
  }
  // Read the live graph and recalculate against the same editor generation in one turn.
  const defs = h.defs(), live = graph(defs), complete = inspect(defs);
  const fields = value => [value.nets,value.shorts,value.airwires,value.excluded,value.unassigned,
    value.stats.objects,value.stats.features,value.sourceNotes];
  // A board with no named copper can leave the live graph unset because it draws no wires.
  const empty = complete.nets.length === 0 && complete.airwires.length === 0;
  const rendered = live ?? (empty ? view.boardConnectivity(board,defs) : null);
  out.finalOverlay = {current:!!live || empty,visible:h.showUnrouted() && AtriumPower.visible(),active:h.doc()===board,
    airwires:rendered?.airwires.length ?? null,entities:rendered?.stats.objects ?? null,
    fullAirwires:complete.airwires.length,fullEntities:complete.stats.objects,
    exact:!!rendered && JSON.stringify(fields(rendered))===JSON.stringify(fields(complete))};
}
return out;
