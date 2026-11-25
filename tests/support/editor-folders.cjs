"use strict";
const assert = require("node:assert/strict");

// Native picker/transport stand-in for LinkeDOM. The editor, folder worker, atomic change plans,
// member hashes and verified saved projections are the same code used by the application.
module.exports = function editorFolders(native) {
  // Reuse the page's codec so its parsed member objects match the worker/archive adapters.
  if (!globalThis.AtriumFormat2Model) require("../../app/formats/format-2-model.js");
  const M = AtriumFormat2Model, F = AtriumFormat2;
  // LinkeDOM has no IndexedDB. Store the real private draft records in this test window.
  const {list,read,write} = require("../project/folder-drafts.cjs").shelf();
  Object.assign(AtriumFolderDrafts.storage,{list,read,write});
  const disks = new Map(), commits = [];
  let lastSaved;

  function grant(disk) {
    const token = Atrium.id();
    disks.set(token,disk);
    return {grant:token,manifest:disk.volume.manifest,name:disk.name,draftScope:disk.scope};
  }
  function create(manifest, files = new Map()) {
    const volume = AtriumBrowserProject.create(manifest,files);
    return grant({name:manifest.replace(/\.waffle$/i,""),volume,scope:Atrium.id()});
  }
  function createModel(project, manifestName) {
    const stored = M.fromEditor(project,manifestName ? {manifestPath:manifestName} : {});
    const files = new Map(stored.files.map(row=>[row.path,F.serialize(row.file)]));
    for (const row of [...stored.models,...stored.assets]) files.set(row.path,row.bytes);
    return create(stored.manifestPath,files);
  }
  const diskOf = token => {
    const disk = disks.get(token);
    assert.ok(disk,"Folder grant is open");
    return disk;
  };
  function request(method, data) {
    const {volume} = diskOf(data.grant);
    return volume.host[method]({...data,grant:volume.grant});
  }
  Object.assign(native,{
    chooseProjectFolder:async ({name})=>create(name),
    folderReadLease:async data=>request("folderReadLease",data),folderRead:async data=>request("folderRead",data),
    folderRelease:async data=>request("folderRelease",data),folderAdopt:async data=>request("folderAdopt",data),
    folderClose:async ({grant})=>disks.delete(grant),
    async folderLocalState({grant,localState}) {
      const disk=diskOf(grant);
      if(localState)disk.localState=structuredClone(localState);
      return disk.localState;
    },
    async folderCommit(data) {
      const result=request("folderCommit",data);
      commits.push({manifest:data.manifest,paths:data.plan.map(row=>row.path)});
      return result;
    }
  });
  async function open(folder) {
    const ok=await AtriumNavHost.openFiles([{name:folder.manifest,folderProject:folder}]);
    assert.equal(ok,true,globalThis.document.getElementById("status").textContent);
    assert.equal(AtriumNavHost.folderProject().grant,folder.grant);
    return folder;
  }
  async function snapshot() {
    const session = AtriumNavHost.folderProject();
    assert.ok(session,"Save produced an editable native folder");
    const saved = await session.requireClosure({purpose:"verified saved test project",saved:true});
    lastSaved=disks.get(session.grant);
    return saved.project;
  }
  async function save() {
    const H=AtriumNavHost, saved=await H.saveAll({download:false});
    assert.ok(saved || H.folderProject() && !H.isDirty(),globalThis.document.getElementById("status").textContent);
    return snapshot();
  }
  async function saveImportedAsWaffle() {
    const source=AtriumNavHost.fileSession().imported;
    if (!source) return save();
    let chosen=false;
    const previous=native.importSaveChoice;
    native.importSaveChoice=async ({file,id,sourceKey,labels,signal})=>{
      assert.ok(!signal?.aborted && (file && file===source.sourceFile || id===source.id && sourceKey===source.sourceKey));
      assert.equal(labels.save,"Save as Waffle Project…");chosen=true;return "waffle";
    };
    const browserChoice=setInterval(()=>{
      const choice = [...document.querySelectorAll("dialog[open] button")].find(b=>b.textContent==="Save as Waffle Project…");
      if (choice) {chosen=true;choice.click();}
    },5);
    try {
      const project=await save();
      assert.ok(chosen,"Saving an imported design required the Waffle project choice");
      return project;
    } finally {
      clearInterval(browserChoice);
      if(previous)native.importSaveChoice=previous;else delete native.importSaveChoice;
    }
  }
  return {
    commits,createModel,open,createFiles:create,openFiles:(manifest,members)=>open(create(manifest,members)),openModel:(project,name)=>open(createModel(project,name)),snapshot,save,saveImportedAsWaffle,
    reopen() {assert.ok(lastSaved,"An existing saved folder is needed to reopen");return open(grant(lastSaved));}
  };
};
